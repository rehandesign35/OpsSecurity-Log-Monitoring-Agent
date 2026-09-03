const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const INGESTION_WINDOW_HOURS = 24;
const FETCH_TIMEOUT_MS = 30_000;
const DESTINATION_TABLE = 'ingested_events';
const SOURCE_HEALTH_TABLE = 'source_health';

const sources = [
  {
    name: 'project1_calls',
    label: 'Project 1 calls',
    table: 'calls',
    urlVariable: 'PROJECT1_SUPABASE_URL',
    keyVariable: 'PROJECT1_SUPABASE_SERVICE_KEY',
  },
  {
    name: 'project5_pipeline_runs',
    label: 'Project 5 pipeline runs',
    table: 'pipeline_runs',
    urlVariable: 'PROJECT5_SUPABASE_URL',
    keyVariable: 'PROJECT5_SUPABASE_SERVICE_KEY',
  },
];

function getRequiredEnv(...names) {
  for (const name of names) {
    if (!process.env[name]) {
      throw new Error(`missing ${name}`);
    }
  }

  return names.map((name) => process.env[name]);
}

function createEndpoint(baseUrl, table) {
  return new URL(`/rest/v1/${table}`, baseUrl);
}

async function requestJson(endpoint, options) {
  const response = await fetch(endpoint, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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

function authHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

function getSourceRowId(row) {
  const rowId = row.id ?? row.call_id ?? row.run_id;
  if (rowId === undefined || rowId === null) {
    throw new Error('source row has no id, call_id, or run_id field');
  }

  return String(rowId);
}

function getEventTimestamp(row) {
  const timestamp = row.updated_at ?? row.created_at ?? row.timestamp ?? row.started_at;
  if (timestamp === undefined || timestamp === null) {
    throw new Error('source row has no supported timestamp field');
  }

  return timestamp;
}

function normalizeRow(source, row) {
  return {
    source: source.name,
    source_row_id: getSourceRowId(row),
    event_timestamp: getEventTimestamp(row),
    status: row.status ?? row.state ?? row.outcome ?? 'unknown',
    raw_payload: row,
    ingested_at: new Date().toISOString(),
  };
}

async function fetchSourceRows(source, serviceKey, baseUrl, cutoff) {
  const endpoint = createEndpoint(baseUrl, source.table);
  endpoint.searchParams.set('select', '*');
  endpoint.searchParams.set('created_at', `gte.${cutoff}`);
  endpoint.searchParams.set('order', 'created_at.desc');

  const rows = await requestJson(endpoint, {
    headers: authHeaders(serviceKey),
  });

  if (!Array.isArray(rows)) {
    throw new Error('response body was not an array of rows');
  }

  return rows;
}

async function fetchExistingKeys(baseUrl, serviceKey, events) {
  if (events.length === 0) {
    return new Set();
  }

  const sourceNames = [...new Set(events.map((event) => event.source))];
  const rowIds = [...new Set(events.map((event) => event.source_row_id))];
  const endpoint = createEndpoint(baseUrl, DESTINATION_TABLE);
  endpoint.searchParams.set('select', 'source,source_row_id');
  endpoint.searchParams.set('source', `in.(${sourceNames.join(',')})`);
  endpoint.searchParams.set('source_row_id', `in.(${rowIds.join(',')})`);

  const existingRows = await requestJson(endpoint, {
    headers: authHeaders(serviceKey),
  });

  if (!Array.isArray(existingRows)) {
    throw new Error('destination response body was not an array of rows');
  }

  return new Set(existingRows.map((row) => `${row.source}:${row.source_row_id}`));
}

async function upsertEvents(baseUrl, serviceKey, events) {
  if (events.length === 0) {
    return;
  }

  const endpoint = createEndpoint(baseUrl, DESTINATION_TABLE);
  endpoint.searchParams.set('on_conflict', 'source,source_row_id');

  const responseRows = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders(serviceKey),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(events),
  });

  if (!Array.isArray(responseRows)) {
    throw new Error('upsert response body was not an array of rows');
  }
}

async function recordSourceHealth(project7Url, project7Key, source, status, errorMessage) {
  const endpoint = createEndpoint(project7Url, SOURCE_HEALTH_TABLE);
  const rows = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders(project7Key),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      source: source.name,
      run_id: process.env.GITHUB_RUN_ID || 'local',
      status,
      error_message: errorMessage,
    }),
  });

  if (!Array.isArray(rows)) {
    throw new Error('source_health response body was not an array');
  }
}

async function ingestSource(source, baseUrl, serviceKey, project7Url, project7Key, cutoff) {
  const rows = await fetchSourceRows(source, serviceKey, baseUrl, cutoff);
  const events = rows.map((row) => normalizeRow(source, row));
  const existingKeys = await fetchExistingKeys(project7Url, project7Key, events);

  await upsertEvents(project7Url, project7Key, events);

  const existingCount = events.filter((event) => existingKeys.has(`${event.source}:${event.source_row_id}`)).length;
  console.log(`${source.label}: fetched ${rows.length}; new ${events.length - existingCount}; already existing ${existingCount}`);
}

async function main() {
  const cutoff = new Date(Date.now() - INGESTION_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const results = await Promise.all(sources.map(async (source) => {
    let project7Url;
    let project7Key;
    try {
      const [baseUrl, serviceKey, destinationUrl, destinationKey] = getRequiredEnv(
        source.urlVariable,
        source.keyVariable,
        'PROJECT7_SUPABASE_URL',
        'PROJECT7_SUPABASE_SERVICE_KEY',
      );
      project7Url = destinationUrl;
      project7Key = destinationKey;
      await ingestSource(source, baseUrl, serviceKey, project7Url, project7Key, cutoff);
      await recordSourceHealth(project7Url, project7Key, source, 'healthy', null);
      return true;
    } catch (error) {
      console.error(`FAILED - ${source.label}: ${error.message}`);
      if (project7Url && project7Key) {
        try {
          await recordSourceHealth(project7Url, project7Key, source, 'degraded', error.message);
        } catch (healthError) {
          console.error(`FAILED - ${source.label} health tracking: ${healthError.message}`);
        }
      }
      return false;
    }
  }));

  if (results.every((succeeded) => !succeeded)) {
    throw new Error('both source ingestion checks failed');
  }
}

main().catch((error) => {
  console.error(`Ingestion failed: ${error.message}`);
  process.exitCode = 1;
});