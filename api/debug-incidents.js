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

function authHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

async function logRawResponse(label, response) {
  const responseBody = await response.text();
  console.log(`\n=== ${label} ===`);
  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log('Headers:', Object.fromEntries(response.headers.entries()));
  console.log('Body:', responseBody);
  return response.ok;
}

async function main() {
  const baseUrl = getRequiredEnv('PROJECT7_SUPABASE_URL');
  const serviceKey = getRequiredEnv('PROJECT7_SUPABASE_SERVICE_KEY');
  const supabaseEndpoint = new URL('/rest/v1/incidents', baseUrl);
  supabaseEndpoint.searchParams.set('select', '*');

  let allResponsesOk = await fetch(supabaseEndpoint, {
    headers: authHeaders(serviceKey),
  }).then((response) => logRawResponse('Project 7 Supabase REST /incidents', response));

  if (process.env.DASHBOARD_API_BASE_URL) {
    const dashboardEndpoint = new URL('/api/incidents', process.env.DASHBOARD_API_BASE_URL);
    const dashboardOk = await fetch(dashboardEndpoint).then((response) => logRawResponse('Dashboard /api/incidents', response));
    allResponsesOk = allResponsesOk && dashboardOk;
  } else {
    console.log('\n=== Dashboard /api/incidents ===');
    console.log('Skipped: DASHBOARD_API_BASE_URL is not set');
  }

  if (!allResponsesOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Incident debug request failed: ${error.message}`);
  process.exitCode = 1;
});