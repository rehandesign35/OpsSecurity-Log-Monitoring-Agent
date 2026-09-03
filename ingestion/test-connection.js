if (typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const sources = [
  {
    name: 'Project 1 calls',
    table: 'calls',
    urlVariable: 'PROJECT1_SUPABASE_URL',
    keyVariable: 'PROJECT1_SUPABASE_SERVICE_KEY',
    timestampFields: ['created_at', 'timestamp', 'started_at'],
  },
  {
    name: 'Project 5 pipeline runs',
    table: 'pipeline_runs',
    urlVariable: 'PROJECT5_SUPABASE_URL',
    keyVariable: 'PROJECT5_SUPABASE_SERVICE_KEY',
    timestampFields: ['created_at', 'timestamp', 'started_at'],
  },
];

function getMostRecentTimestamp(row, timestampFields) {
  for (const field of timestampFields) {
    if (row && row[field] !== undefined && row[field] !== null) {
      return row[field];
    }
  }

  return 'unavailable';
}

async function checkSource(source) {
  const baseUrl = process.env[source.urlVariable];
  const serviceKey = process.env[source.keyVariable];

  if (!baseUrl || !serviceKey) {
    throw new Error(`missing ${source.urlVariable} or ${source.keyVariable}`);
  }

  const endpoint = new URL(`/rest/v1/${source.table}`, baseUrl);
  endpoint.searchParams.set('select', '*');
  endpoint.searchParams.set('order', 'created_at.desc');
  endpoint.searchParams.set('limit', '5');

  const response = await fetch(endpoint, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }

  let rows;
  try {
    rows = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`invalid JSON response: ${error.message}`);
  }

  if (!Array.isArray(rows)) {
    throw new Error('response body was not an array of rows');
  }

  console.log(`${source.name} (${source.table}): ${rows.length} row(s); most recent timestamp: ${getMostRecentTimestamp(rows[0], source.timestampFields)}`);
}

async function main() {
  await Promise.all(sources.map(async (source) => {
    try {
      await checkSource(source);
    } catch (error) {
      console.error(`FAILED - ${source.name}: ${error.message}`);
    }
  }));
}

main().catch((error) => {
  console.error(`Connection test failed unexpectedly: ${error.message}`);
  process.exitCode = 1;
});
