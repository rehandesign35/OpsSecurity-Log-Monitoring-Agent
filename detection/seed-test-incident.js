const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

function getRequiredEnv(name) {
  if (!process.env[name]) {
    throw new Error(`missing ${name}`);
  }

  return process.env[name];
}

async function main() {
  const baseUrl = getRequiredEnv('PROJECT7_SUPABASE_URL');
  const serviceKey = getRequiredEnv('PROJECT7_SUPABASE_SERVICE_KEY');
  const now = Date.now();
  const endpoint = new URL('/rest/v1/incidents', baseUrl);
  const row = {
    incident_type: 'single_source',
    window_start: new Date(now - 10 * 60 * 1000).toISOString(),
    window_end: new Date(now).toISOString(),
    sources: ['project1_calls'],
    anomaly_ids: [],
    summary: 'Test incident inserted for dashboard debugging',
    status: 'open',
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const responseBody = await response.text();

  console.log(`Supabase insert response: HTTP ${response.status} ${response.statusText}`);
  console.log('Headers:', Object.fromEntries(response.headers.entries()));
  console.log('Body:', responseBody);

  if (!response.ok) {
    throw new Error('Supabase insert failed; see the full response body above');
  }

  let insertedRows;
  try {
    insertedRows = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`insert response was not valid JSON: ${error.message}`);
  }

  const insertedRow = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
  console.log('Inserted row id:', insertedRow && insertedRow.id !== undefined ? insertedRow.id : 'not returned');
}

main().catch((error) => {
  console.error(`Test incident seed failed: ${error.message}`);
  process.exitCode = 1;
});