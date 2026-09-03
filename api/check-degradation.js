const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const SOURCE_HEALTH_TABLE = 'source_health';
const sources = ['project1_calls', 'project5_pipeline_runs'];

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

async function fetchRecentHealthRows(project7Url, project7Key, source) {
  const endpoint = createEndpoint(project7Url, SOURCE_HEALTH_TABLE);
  endpoint.searchParams.set('select', 'source,status,error_message,checked_at');
  endpoint.searchParams.set('source', `eq.${source}`);
  endpoint.searchParams.set('order', 'checked_at.desc');
  endpoint.searchParams.set('limit', '2');

  const rows = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });

  if (!Array.isArray(rows)) {
    throw new Error(`source_health response for ${source} was not an array`);
  }

  return rows;
}

async function sendSlackAlert(webhookUrl, message) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`Slack HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }
}

async function checkSource(source, project7Url, project7Key, webhookUrl) {
  const rows = await fetchRecentHealthRows(project7Url, project7Key, source);
  if (rows.length === 0) {
    console.log(`${source}: no health history found`);
    return;
  }

  const latest = rows[0];
  const previous = rows[1];
  if (latest.status === 'degraded' && (!previous || previous.status !== 'degraded')) {
    await sendSlackAlert(webhookUrl, `DEGRADED: ${source} is unreachable or failing. Error: ${latest.error_message || 'unknown error'}`);
    console.log(`${source}: degradation alert sent`);
  } else if (latest.status === 'healthy' && previous?.status === 'degraded') {
    await sendSlackAlert(webhookUrl, `RECOVERED: ${source} is healthy again.`);
    console.log(`${source}: recovery alert sent`);
  } else {
    console.log(`${source}: no degradation state change (${latest.status})`);
  }
}

async function main() {
  const [project7Url, project7Key, webhookUrl] = getRequiredEnv(
    'PROJECT7_SUPABASE_URL',
    'PROJECT7_SUPABASE_SERVICE_KEY',
    'SLACK_WEBHOOK_URL',
  );

  await Promise.all(sources.map(async (source) => {
    try {
      await checkSource(source, project7Url, project7Key, webhookUrl);
    } catch (error) {
      console.error(`FAILED - ${source} degradation check: ${error.message}`);
    }
  }));
}

main().catch((error) => {
  console.error(`Degradation check failed: ${error.message}`);
  process.exitCode = 1;
});