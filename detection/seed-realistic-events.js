const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const EVENTS_PER_SOURCE = 42;
const LOOKBACK_MINUTES = 10;
const FAILURE_BURST_START = 30;
const FAILURE_BURST_COUNT = 6;

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

function eventTimestamp(index, now) {
  const minuteOffset = LOOKBACK_MINUTES - ((index * 7) % (LOOKBACK_MINUTES * 2)) / 2;
  return new Date(now - minuteOffset * 60 * 1000 - (index % 4) * 1000).toISOString();
}

function createRows(source, now) {
  return Array.from({ length: EVENTS_PER_SOURCE }, (_, index) => {
    const inFailureBurst = index >= FAILURE_BURST_START && index < FAILURE_BURST_START + FAILURE_BURST_COUNT;
    const createdAt = eventTimestamp(index, now);

    if (source === 'calls') {
      return {
        outcome: inFailureBurst ? 'failed' : (index % 5 === 0 ? 'voicemail' : 'completed'),
        created_at: createdAt,
      };
    }

    return {
      run_id: `daily-sync-${new Date(now).toISOString().slice(0, 10)}-${String(index + 1).padStart(2, '0')}-${randomUUID().slice(0, 8)}`,
      workflow_name: index % 3 === 0 ? 'customer-sync' : 'billing-reconciliation',
      status: inFailureBurst ? 'dead_lettered' : 'success',
      created_at: createdAt,
    };
  });
}

async function insertRows(baseUrl, serviceKey, table, rows) {
  const response = await fetch(createEndpoint(baseUrl, table), {
    method: 'POST',
    headers: {
      ...authHeaders(serviceKey),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }

  let insertedRows;
  try {
    insertedRows = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`insert response was not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(insertedRows)) {
    throw new Error('insert response body was not an array');
  }

  return insertedRows;
}

async function main() {
  const [project1Url, project1Key, project5Url, project5Key] = getRequiredEnv(
    'PROJECT1_SUPABASE_URL',
    'PROJECT1_SUPABASE_SERVICE_KEY',
    'PROJECT5_SUPABASE_URL',
    'PROJECT5_SUPABASE_SERVICE_KEY',
  );
  const now = Date.now();
  const allSources = [
    { label: 'Project 1 calls', table: 'calls', url: project1Url, key: project1Key },
    { label: 'Project 5 pipeline runs', table: 'pipeline_runs', url: project5Url, key: project5Key },
  ];
  const sources = process.env.SEED_SOURCE
    ? allSources.filter((source) => source.table === process.env.SEED_SOURCE)
    : allSources;
  if (sources.length === 0) {
    throw new Error(`unknown SEED_SOURCE ${process.env.SEED_SOURCE}; use calls or pipeline_runs`);
  }

  console.log(`Seeding ${EVENTS_PER_SOURCE * sources.length} realistic events across ${sources.length} source(s), including ${FAILURE_BURST_COUNT} recent failures per source.`);
  for (const source of sources) {
    const insertedRows = await insertRows(source.url, source.key, source.table, createRows(source.table, now));
    console.log(`${source.label}: inserted ${insertedRows.length} rows`);
  }
}

main().catch((error) => {
  console.error(`Realistic event seed failed: ${error.message}`);
  process.exitCode = 1;
});