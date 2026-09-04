const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const CORRELATION_LOOKBACK_HOURS = 24;
const CORRELATION_WINDOW_MINUTES = 15;
const RESOLUTION_COOLDOWN_MINUTES = 30;
const ANOMALIES_TABLE = 'anomalies';
const INCIDENTS_TABLE = 'incidents';
const EVENTS_TABLE = 'ingested_events';
const FAILURE_STATUSES = new Set(['failed', 'dead_letter', 'dead_lettered']);

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

async function fetchOpenAnomalies(project7Url, project7Key, cutoff) {
  const endpoint = createEndpoint(project7Url, ANOMALIES_TABLE);
  endpoint.searchParams.set('select', 'id,source,detection_type,metric_name,window_start,window_end,observed_value,baseline_value,z_score,details,detected_at');
  endpoint.searchParams.set('status', 'eq.open');
  endpoint.searchParams.set('detected_at', `gte.${cutoff}`);
  endpoint.searchParams.set('order', 'window_start.asc');

  const anomalies = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });

  if (!Array.isArray(anomalies)) {
    throw new Error('anomalies response body was not an array');
  }

  return anomalies;
}

async function fetchAttachedAnomalyIds(project7Url, project7Key) {
  const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
  endpoint.searchParams.set('select', 'anomaly_ids');

  const incidents = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });

  if (!Array.isArray(incidents)) {
    throw new Error('incidents response body was not an array');
  }

  return new Set(incidents.flatMap((incident) => {
    if (!Array.isArray(incident.anomaly_ids)) {
      return [];
    }
    return incident.anomaly_ids.map((anomalyId) => String(anomalyId));
  }));
}

async function fetchOpenIncidents(project7Url, project7Key) {
  const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
  endpoint.searchParams.set('select', 'id,sources,window_end,anomaly_ids');
  endpoint.searchParams.set('status', 'eq.open');
  const incidents = await requestJson(endpoint, { headers: authHeaders(project7Key) });
  if (!Array.isArray(incidents)) {
    throw new Error('incidents response body was not an array');
  }
  return incidents;
}

async function fetchRecentEvents(project7Url, project7Key, cutoff) {
  const endpoint = createEndpoint(project7Url, EVENTS_TABLE);
  endpoint.searchParams.set('select', 'source,event_timestamp,status,raw_payload');
  endpoint.searchParams.set('event_timestamp', `gte.${cutoff}`);
  const events = await requestJson(endpoint, { headers: authHeaders(project7Key) });
  if (!Array.isArray(events)) {
    throw new Error('ingested_events response body was not an array');
  }
  return events;
}

function isCountedFailure(event) {
  if (!FAILURE_STATUSES.has(String(event.status).toLowerCase())) {
    return false;
  }
  const retryCount = Number(event.raw_payload?.retry_count);
  return !Number.isFinite(retryCount) || retryCount === 0;
}

async function resolveClearedIncidents(project7Url, project7Key, incidents, events) {
  const now = Date.now();
  const cooldownMilliseconds = RESOLUTION_COOLDOWN_MINUTES * 60 * 1000;
  let resolvedCount = 0;

  for (const incident of incidents) {
    const windowEnd = new Date(incident.window_end).getTime();
    if (Number.isNaN(windowEnd) || now - windowEnd < cooldownMilliseconds) {
      continue;
    }

    if (!Array.isArray(incident.anomaly_ids) || incident.anomaly_ids.length === 0) {
      const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
      endpoint.searchParams.set('id', `eq.${incident.id}`);
      await requestJson(endpoint, {
        method: 'PATCH',
        headers: {
          ...authHeaders(project7Key),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'resolved' }),
      });
      resolvedCount += 1;
      continue;
    }

    const sources = new Set(Array.isArray(incident.sources) ? incident.sources : []);
    const hasNewFailure = events.some((event) => {
      const eventTime = new Date(event.event_timestamp).getTime();
      return sources.has(event.source) && eventTime > windowEnd && isCountedFailure(event);
    });
    if (hasNewFailure) {
      continue;
    }

    const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
    endpoint.searchParams.set('id', `eq.${incident.id}`);
    await requestJson(endpoint, {
      method: 'PATCH',
      headers: {
        ...authHeaders(project7Key),
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: 'resolved' }),
    });
    resolvedCount += 1;
  }

  return resolvedCount;
}

function parseAnomalyWindow(anomaly) {
  const windowStart = new Date(anomaly.window_start);
  const windowEnd = new Date(anomaly.window_end ?? anomaly.window_start);

  if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
    throw new Error(`anomaly ${anomaly.id} has an invalid time window`);
  }
  if (windowEnd < windowStart) {
    throw new Error(`anomaly ${anomaly.id} has a window_end before window_start`);
  }

  return {
    ...anomaly,
    startTime: windowStart.getTime(),
    endTime: windowEnd.getTime(),
  };
}

function groupAnomalies(anomalies) {
  const toleranceMilliseconds = CORRELATION_WINDOW_MINUTES * 60 * 1000;
  const sortedAnomalies = anomalies.map(parseAnomalyWindow).sort((first, second) => first.startTime - second.startTime);
  const groups = [];
  let currentGroup = [];
  let currentGroupEnd = null;

  for (const anomaly of sortedAnomalies) {
    if (currentGroup.length === 0 || anomaly.startTime > currentGroupEnd + toleranceMilliseconds) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [anomaly];
      currentGroupEnd = anomaly.endTime;
      continue;
    }

    currentGroup.push(anomaly);
    currentGroupEnd = Math.max(currentGroupEnd, anomaly.endTime);
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function getIncidentWindow(group) {
  const windowStart = Math.min(...group.map((anomaly) => anomaly.startTime));
  const windowEnd = Math.max(...group.map((anomaly) => anomaly.endTime));
  return {
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
  };
}

function createIncident(group) {
  const sources = [...new Set(group.map((anomaly) => anomaly.source))];
  const { windowStart, windowEnd } = getIncidentWindow(group);
  const incidentType = sources.length > 1 ? 'correlated' : 'single_source';
  const anomalyIds = group.map((anomaly) => anomaly.id);

  return {
    incident_type: incidentType,
    window_start: windowStart,
    window_end: windowEnd,
    sources,
    anomaly_ids: anomalyIds,
    summary: null,
  };
}

async function insertIncident(project7Url, project7Key, incident) {
  const endpoint = createEndpoint(project7Url, INCIDENTS_TABLE);
  const rows = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders(project7Key),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(incident),
  });

  if (!Array.isArray(rows)) {
    throw new Error('incidents response body was not an array');
  }

  return rows[0];
}

async function runCorrelation() {
  const [project7Url, project7Key] = getRequiredEnv(
    'PROJECT7_SUPABASE_URL',
    'PROJECT7_SUPABASE_SERVICE_KEY',
  );
  const cutoff = new Date(Date.now() - CORRELATION_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const [openAnomalies, attachedAnomalyIds, openIncidents, recentEvents] = await Promise.all([
    fetchOpenAnomalies(project7Url, project7Key, cutoff),
    fetchAttachedAnomalyIds(project7Url, project7Key),
    fetchOpenIncidents(project7Url, project7Key),
    fetchRecentEvents(project7Url, project7Key, cutoff),
  ]);
  const incidentsResolved = await resolveClearedIncidents(project7Url, project7Key, openIncidents, recentEvents);
  const unattachedAnomalies = openAnomalies.filter((anomaly) => !attachedAnomalyIds.has(String(anomaly.id)));
  const groups = groupAnomalies(unattachedAnomalies);
  let correlatedIncidents = 0;
  let singleSourceIncidents = 0;
  let twoSourceCorrelatedIncidents = 0;

  for (const group of groups) {
    const incident = createIncident(group);
    await insertIncident(project7Url, project7Key, incident);
    if (incident.incident_type === 'correlated') {
      correlatedIncidents += 1;
      if (incident.sources.length === 2) {
        twoSourceCorrelatedIncidents += 1;
      }
    } else {
      singleSourceIncidents += 1;
    }
  }

  console.log(`Resolved ${incidentsResolved} cleared incidents. Processed ${unattachedAnomalies.length} open anomalies; created ${correlatedIncidents} correlated incidents and ${singleSourceIncidents} single-source incidents.`);
  return {
    incidentsCreated: correlatedIncidents + singleSourceIncidents,
    incidentsResolved,
    correlatedIncidents,
    singleSourceIncidents,
    twoSourceCorrelatedIncidents,
  };
}

async function main() {
  await runCorrelation();
}

module.exports = { runCorrelation };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Correlation failed: ${error.message}`);
    process.exitCode = 1;
  });
}