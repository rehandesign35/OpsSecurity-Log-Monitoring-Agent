const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const DEFAULT_COUNT = 3;
const MINUTES_BETWEEN_ROWS = 3;
const ALLOWED_STATUSES = new Set(['failed', 'dead_letter']);

const sources = [
  {
    name: 'project1_calls',
    table: 'calls',
    urlVariable: 'PROJECT1_SUPABASE_URL',
    keyVariable: 'PROJECT1_SUPABASE_SERVICE_KEY',
  },
  {
    name: 'project5_pipeline_runs',
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

function authHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

function createEndpoint(baseUrl, table) {
  return new URL(`/rest/v1/${table}`, baseUrl);
}

function parseOptions() {
  const options = {
    count: DEFAULT_COUNT,
    status: 'failed',
  };

  for (const argument of process.argv.slice(2)) {
    const [name, value] = argument.split('=');
    if (name === '--count') {
      options.count = Number(value);
    } else if (name === '--status') {
      options.status = value;
    } else {
      throw new Error(`unknown option ${name}; use --count=3 and/or --status=failed|dead_letter`);
    }
  }

  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 5) {
    throw new Error('--count must be an integer from 1 to 5');
  }
  if (!ALLOWED_STATUSES.has(options.status)) {
    throw new Error('--status must be failed or dead_letter');
  }

  return options;
}

async function insertTestRows(source, baseUrl, serviceKey, count, status) {
  const endpoint = createEndpoint(baseUrl, source.table);
  const now = Date.now();
  const rows = Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(now - ((count - index) * MINUTES_BETWEEN_ROWS * 60 * 1000)).toISOString();
    if (source.table === 'calls') {
      return { outcome: status, created_at: createdAt };
    }
    return {
      run_id: `synthetic-${randomUUID()}`,
      workflow_name: 'synthetic-anomaly-test',
      status: status === 'dead_letter' ? 'dead_lettered' : status,
      created_at: createdAt,
    };
  });
  const response = await fetch(endpoint, {
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
    throw new Error(`invalid response JSON: ${error.message}`);
  }

  if (!Array.isArray(insertedRows)) {
    throw new Error('insert response body was not an array');
  }

  console.log(`${source.name}: inserted ${insertedRows.length} synthetic ${status} row(s)`);
  insertedRows.forEach((row, index) => {
    const rowId = row.id ?? row.call_id ?? row.run_id ?? 'unknown';
    console.log(`  ${source.name}[${index + 1}] row id=${rowId}, created_at=${row.created_at}`);
  });
}

async function main() {
  const options = parseOptions();
  console.log(`Injecting ${options.count} ${options.status} row(s) per source, ${MINUTES_BETWEEN_ROWS} minutes apart.`);

  await Promise.all(sources.map(async (source) => {
    try {
      const [baseUrl, serviceKey] = getRequiredEnv(source.urlVariable, source.keyVariable);
      await insertTestRows(source, baseUrl, serviceKey, options.count, options.status);
    } catch (error) {
      console.error(`FAILED - ${source.name}: ${error.message}`);
    }
  }));
}

main().catch((error) => {
  console.error(`Test anomaly injection failed: ${error.message}`);
  process.exitCode = 1;
});
