const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const SUMMARIZATION_LOOKBACK_HOURS = 24;
const INCIDENTS_TABLE = 'incidents';
const ANOMALIES_TABLE = 'anomalies';
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

function getRequiredEnv(...names) {
  for (const name of names) {
    if (!process.env[name]) {
      throw new Error(`missing ${name}`);
    }
  }

  return names.map((name) => process.env[name]);
}

function authHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

function createEndpoint(baseUrl, table) {
  return new URL(`/rest/v1/${table}`, baseUrl);
}

async function requestJson(endpoint, options) {
  const response = await fetch(endpoint, options);
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }

  if (!responseBody) {
    return [];
  }

  try {
    return JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`invalid JSON response: ${error.message}`);
  }
}

async function fetchUnsummarizedIncidents(project7Url, project7Key, cutoff) {
  const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
  endpoint.searchParams.set('select', 'id,incident_type,window_start,window_end,sources,anomaly_ids');
  endpoint.searchParams.set('summary', 'is.null');
  endpoint.searchParams.set('created_at', `gte.${cutoff}`);
  endpoint.searchParams.set('order', 'created_at.asc');

  const incidents = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });

  if (!Array.isArray(incidents)) {
    throw new Error('incidents response body was not an array');
  }

  return incidents;
}

async function fetchAnomalies(project7Url, project7Key, anomalyIds) {
  if (!Array.isArray(anomalyIds) || anomalyIds.length === 0) {
    return [];
  }

  const endpoint = createEndpoint(project7Url, ANOMALIES_TABLE);
  endpoint.searchParams.set('select', 'id,source,detection_type,metric_name,observed_value,baseline_value,z_score,details,window_start,window_end');
  endpoint.searchParams.set('id', `in.(${anomalyIds.join(',')})`);

  const anomalies = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });

  if (!Array.isArray(anomalies)) {
    throw new Error('anomalies response body was not an array');
  }

  return anomalies;
}

function buildPrompt(incident, anomalies) {
  const incidentContext = {
    incident_type: incident.incident_type,
    sources: incident.sources,
    window_start: incident.window_start,
    window_end: incident.window_end,
  };
  const anomalyContext = anomalies.map((anomaly) => ({
    id: anomaly.id,
    source: anomaly.source,
    detection_type: anomaly.detection_type,
    metric_name: anomaly.metric_name,
    observed_value: anomaly.observed_value,
    baseline_value: anomaly.baseline_value,
    z_score: anomaly.z_score,
    details: anomaly.details,
    window_start: anomaly.window_start,
    window_end: anomaly.window_end,
  }));

  return `Incident context:\n${JSON.stringify(incidentContext, null, 2)}\n\nAnomaly details:\n${JSON.stringify(anomalyContext, null, 2)}\n\nWrite a concise incident report for an engineer. State what happened, which systems were involved, the likely severity (low/medium/high) based on the z-scores and whether multiple sources were involved, and one plausible next step to investigate. Do not invent details not present in the data. 3-5 sentences.`;
}

async function generateSummary(apiKey, prompt) {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You summarize operational incidents using only the supplied data.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
    }),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }

  let result;
  try {
    result = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`invalid OpenAI JSON response: ${error.message}`);
  }

  const summary = result.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error('OpenAI response did not contain summary text');
  }

  return summary;
}

async function updateIncident(project7Url, project7Key, incidentId, summary) {
  const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
  endpoint.searchParams.set('id', `eq.${incidentId}`);
  const rows = await requestJson(endpoint, {
    method: 'PATCH',
    headers: {
      ...authHeaders(project7Key),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ summary }),
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('incident update returned no rows');
  }
}

function preview(summary) {
  const compactSummary = summary.replace(/\s+/g, ' ');
  return compactSummary.length > 160 ? `${compactSummary.slice(0, 157)}...` : compactSummary;
}

async function summarizeIncident(incident, project7Url, project7Key, openaiApiKey) {
  const anomalies = await fetchAnomalies(project7Url, project7Key, incident.anomaly_ids);
  if (anomalies.length !== incident.anomaly_ids.length) {
    throw new Error(`expected ${incident.anomaly_ids.length} anomalies but found ${anomalies.length}`);
  }

  const summary = await generateSummary(openaiApiKey, buildPrompt(incident, anomalies));
  await updateIncident(project7Url, project7Key, incident.id, summary);
  console.log(`Incident ${incident.id} processed: ${preview(summary)}`);
  return 1;
}

async function runSummarization({ strict = false } = {}) {
  const [project7Url, project7Key, openaiApiKey] = getRequiredEnv(
    'PROJECT7_SUPABASE_URL',
    'PROJECT7_SUPABASE_SERVICE_KEY',
    'OPENAI_API_KEY',
  );
  const cutoff = new Date(Date.now() - SUMMARIZATION_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const incidents = await fetchUnsummarizedIncidents(project7Url, project7Key, cutoff);
  console.log(`Found ${incidents.length} incidents without summaries in the last ${SUMMARIZATION_LOOKBACK_HOURS} hours`);

  const results = await Promise.all(incidents.map(async (incident) => {
    try {
      return await summarizeIncident(incident, project7Url, project7Key, openaiApiKey);
    } catch (error) {
      console.error(`FAILED - Incident ${incident.id}: ${error.message}`);
      if (strict) {
        throw error;
      }
      return 0;
    }
  }));

  return { incidentsSummarized: results.reduce((sum, count) => sum + count, 0) };
}

async function main() {
  await runSummarization();
}

module.exports = { runSummarization };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Summarization failed: ${error.message}`);
    process.exitCode = 1;
  });
}