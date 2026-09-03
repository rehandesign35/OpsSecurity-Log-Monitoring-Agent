const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const INCIDENT_LOOKBACK_HOURS = 24;
const HIGH_Z_SCORE_THRESHOLD = 3;
const INCIDENTS_TABLE = 'incidents';
const ANOMALIES_TABLE = 'anomalies';
const TICKETS_TABLE = 'tickets';

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

async function fetchEligibleIncidents(project7Url, project7Key, cutoff) {
  const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
  endpoint.searchParams.set('select', 'id,incident_type,window_start,window_end,sources,anomaly_ids,summary');
  endpoint.searchParams.set('summary', 'not.is.null');
  endpoint.searchParams.set('status', 'eq.open');
  endpoint.searchParams.set('created_at', `gte.${cutoff}`);
  endpoint.searchParams.set('order', 'created_at.asc');

  const incidents = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });
  if (!Array.isArray(incidents)) {
    throw new Error('incidents response body was not an array');
  }

  const ticketEndpoint = createEndpoint(project7Url, TICKETS_TABLE);
  ticketEndpoint.searchParams.set('select', 'incident_id');
  const tickets = await requestJson(ticketEndpoint, {
    headers: authHeaders(project7Key),
  });
  if (!Array.isArray(tickets)) {
    throw new Error('tickets response body was not an array');
  }

  const ticketedIncidentIds = new Set(tickets.map((ticket) => String(ticket.incident_id)));
  return incidents.filter((incident) => !ticketedIncidentIds.has(String(incident.id)));
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

function derivePriority(incident, anomalies) {
  const sourceCount = Array.isArray(incident.sources) ? new Set(incident.sources).size : 0;
  const zScores = anomalies
    .map((anomaly) => Number(anomaly.z_score))
    .filter((zScore) => Number.isFinite(zScore))
    .map((zScore) => Math.abs(zScore));
  const highestZScore = zScores.length > 0 ? Math.max(...zScores) : 0;

  if (incident.incident_type === 'correlated' && sourceCount >= 2) {
    return 'high';
  }
  if (highestZScore >= HIGH_Z_SCORE_THRESHOLD) {
    return 'medium';
  }
  if (incident.incident_type === 'correlated' && highestZScore >= 2.5) {
    return 'medium';
  }
  return 'low';
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().slice(11, 16);
}

function deriveTitle(incident) {
  const sources = Array.isArray(incident.sources) && incident.sources.length > 0
    ? incident.sources.join(' + ')
    : 'unknown source';
  return `${incident.incident_type === 'correlated' ? 'Correlated anomaly' : 'Single-source anomaly'}: ${sources}, ${formatTime(incident.window_start)}-${formatTime(incident.window_end)}`;
}

async function sendSlackAlert(webhookUrl, title, priority, incident) {
  const message = [
    `*${title}*`,
    `Priority: ${priority}`,
    `Sources: ${Array.isArray(incident.sources) ? incident.sources.join(', ') : 'unknown'}`,
    `Window: ${incident.window_start} to ${incident.window_end}`,
    `Summary: ${incident.summary}`,
  ].join('\n');
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`Slack HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }

  // Incoming webhooks do not return a usable message timestamp, so this remains null.
  return null;
}

async function createTicket(project7Url, project7Key, incident, title, priority, slackMessageTs) {
  const endpoint = createEndpoint(project7Url, TICKETS_TABLE);
  const rows = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders(project7Key),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      incident_id: incident.id,
      title,
      priority,
      slack_message_ts: slackMessageTs,
    }),
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('ticket insert returned no rows');
  }
}

async function processIncident(incident, project7Url, project7Key, webhookUrl) {
  const anomalies = await fetchAnomalies(project7Url, project7Key, incident.anomaly_ids);
  if (anomalies.length !== incident.anomaly_ids.length) {
    throw new Error(`expected ${incident.anomaly_ids.length} anomalies but found ${anomalies.length}`);
  }

  const priority = derivePriority(incident, anomalies);
  const title = deriveTitle(incident);
  const slackMessageTs = await sendSlackAlert(webhookUrl, title, priority, incident);
  await createTicket(project7Url, project7Key, incident, title, priority, slackMessageTs);
  console.log(`Incident ${incident.id} processed: priority=${priority}, Slack sent=yes, ticket created=yes`);
}

async function main() {
  const [project7Url, project7Key, webhookUrl] = getRequiredEnv(
    'PROJECT7_SUPABASE_URL',
    'PROJECT7_SUPABASE_SERVICE_KEY',
    'SLACK_WEBHOOK_URL',
  );
  const cutoff = new Date(Date.now() - INCIDENT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const incidents = await fetchEligibleIncidents(project7Url, project7Key, cutoff);
  console.log(`Found ${incidents.length} summarized open incidents without tickets in the last ${INCIDENT_LOOKBACK_HOURS} hours`);

  await Promise.all(incidents.map(async (incident) => {
    try {
      await processIncident(incident, project7Url, project7Key, webhookUrl);
    } catch (error) {
      console.error(`FAILED - Incident ${incident.id}: ${error.message}. No ticket created; it will be retried.`);
    }
  }));
}

main().catch((error) => {
  console.error(`Alert and ticket processing failed: ${error.message}`);
  process.exitCode = 1;
});