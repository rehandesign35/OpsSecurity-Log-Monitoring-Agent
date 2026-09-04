const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const INCIDENT_COUNT = 84;
const LOOKBACK_HOURS = 23;

function getRequiredEnv(...names) {
  for (const name of names) {
    if (!process.env[name]) {
      throw new Error(`missing ${name}`);
    }
  }

  return names.map((name) => process.env[name]);
}

function createIncident(index, now) {
  const correlated = index % 4 === 0;
  const status = index % 6 === 0 ? 'false_positive' : index % 3 === 0 ? 'true_positive' : 'open';
  const ageMinutes = Math.round((index / (INCIDENT_COUNT - 1)) * LOOKBACK_HOURS * 60);
  const start = new Date(now - ageMinutes * 60 * 1000 - (index % 5) * 60 * 1000);
  const durationMinutes = correlated ? 8 + (index % 12) : 4 + (index % 9);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const sources = correlated
    ? ['project1_calls', 'project5_pipeline_runs']
    : [index % 2 === 0 ? 'project1_calls' : 'project5_pipeline_runs'];
  const summaries = correlated
    ? [
      'Call failures and pipeline retries increased during the same operating window; review the shared dependency path.',
      'Cross-system error activity was detected across customer calls and scheduled processing.',
      'A short burst of failures affected both voice operations and background pipeline execution.',
    ]
    : [
      'Repeated call failures observed in a short window; review provider response codes and retry behavior.',
      'Pipeline execution failures rose briefly; inspect the affected workflow logs and downstream dependency.',
      'A concentrated operational error pattern was detected and is awaiting review.',
      'Short-lived failure activity was recorded with no additional source impact observed.',
    ];

  return {
    incident_type: correlated ? 'correlated' : 'single_source',
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    sources,
    anomaly_ids: [],
    summary: summaries[index % summaries.length],
    status,
  };
}

async function main() {
  const [baseUrl, serviceKey] = getRequiredEnv(
    'PROJECT7_SUPABASE_URL',
    'PROJECT7_SUPABASE_SERVICE_KEY',
  );
  const rows = Array.from({ length: INCIDENT_COUNT }, (_, index) => createIncident(index, Date.now()));
  const response = await fetch(new URL('/rest/v1/incidents', baseUrl), {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseBody}`);
  }

  const insertedRows = JSON.parse(responseBody);
  if (!Array.isArray(insertedRows) || insertedRows.length !== INCIDENT_COUNT) {
    throw new Error(`expected ${INCIDENT_COUNT} inserted incidents, got ${Array.isArray(insertedRows) ? insertedRows.length : 'non-array response'}`);
  }

  const counts = insertedRows.reduce((result, incident) => {
    result[incident.status] = (result[incident.status] || 0) + 1;
    result[incident.incident_type] = (result[incident.incident_type] || 0) + 1;
    return result;
  }, {});
  console.log(`Inserted ${insertedRows.length} realistic incidents into Project 7.`);
  console.log(`By type: ${counts.correlated} correlated, ${counts.single_source} single-source.`);
  console.log(`By status: ${counts.open} open, ${counts.true_positive} true-positive, ${counts.false_positive} false-positive.`);
}

main().catch((error) => {
  console.error(`Realistic incident seed failed: ${error.message}`);
  process.exitCode = 1;
});