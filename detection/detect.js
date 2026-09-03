const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const LOOKBACK_HOURS = 24;
const Z_SCORE_THRESHOLD = 2.5;
const REPEATED_FAILURE_THRESHOLD = 3;
const REPEATED_FAILURE_WINDOW_MINUTES = 15;
const EVENTS_TABLE = 'ingested_events';
const ANOMALIES_TABLE = 'anomalies';
const FAILURE_STATUSES = new Set(['failed', 'dead_letter', 'dead_lettered']);

const sources = [
  {
    name: 'project1_calls',
    label: 'project1_calls',
  },
  {
    name: 'project5_pipeline_runs',
    label: 'project5_runs',
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

async function fetchEvents(source, project7Url, project7Key, cutoff) {
  const endpoint = createEndpoint(project7Url, EVENTS_TABLE);
  endpoint.searchParams.set('select', 'id,source_row_id,event_timestamp,status');
  endpoint.searchParams.set('source', `eq.${source.name}`);
  endpoint.searchParams.set('event_timestamp', `gte.${cutoff}`);
  endpoint.searchParams.set('order', 'event_timestamp.asc');

  const events = await requestJson(endpoint, {
    headers: authHeaders(project7Key),
  });

  if (!Array.isArray(events)) {
    throw new Error('ingested_events response body was not an array');
  }

  return events;
}

function getHourlyBuckets(events) {
  const buckets = new Map();

  for (const event of events) {
    const timestamp = new Date(event.event_timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      continue;
    }

    const bucketStart = new Date(timestamp);
    bucketStart.setUTCMinutes(0, 0, 0);
    const bucketKey = bucketStart.toISOString();
    const bucket = buckets.get(bucketKey) ?? { total: 0, failures: 0 };
    bucket.total += 1;
    if (FAILURE_STATUSES.has(String(event.status).toLowerCase())) {
      bucket.failures += 1;
    }
    buckets.set(bucketKey, bucket);
  }

  return [...buckets.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([windowStart, bucket]) => ({
      windowStart,
      total: bucket.total,
      failures: bucket.failures,
      failureRate: bucket.failures / bucket.total,
    }));
}

function calculateMean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculatePopulationStddev(values, mean) {
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function calculateZScore(observedValue, baselineValue, standardDeviation) {
  if (standardDeviation === 0) {
    return observedValue === baselineValue ? 0 : (observedValue > baselineValue ? Infinity : -Infinity);
  }

  return (observedValue - baselineValue) / standardDeviation;
}

function getWindowEnd(windowStart) {
  return new Date(new Date(windowStart).getTime() + 60 * 60 * 1000).toISOString();
}

async function insertAnomaly(project7Url, project7Key, anomaly) {
  const endpoint = createEndpoint(project7Url, ANOMALIES_TABLE);
  const rows = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders(project7Key),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(anomaly),
  });

  if (!Array.isArray(rows)) {
    throw new Error('anomalies response body was not an array');
  }
}

async function detectStatistical(source, events, project7Url, project7Key) {
  const windows = getHourlyBuckets(events);
  if (windows.length < 2) {
    console.log(`${source.label}: statistical check skipped, need at least 2 hourly windows (found ${windows.length})`);
    return;
  }

  const mostRecent = windows[windows.length - 1];
  const baselineWindows = windows.slice(0, -1);
  const baselineRates = baselineWindows.map((window) => window.failureRate);
  const baselineValue = calculateMean(baselineRates);
  const standardDeviation = calculatePopulationStddev(baselineRates, baselineValue);
  const zScore = calculateZScore(mostRecent.failureRate, baselineValue, standardDeviation);

  console.log(`${source.label}: z-score ${Number.isFinite(zScore) ? zScore.toFixed(2) : zScore}, observed failure rate ${(mostRecent.failureRate * 100).toFixed(2)}%, baseline ${(baselineValue * 100).toFixed(2)}%`);

  if (zScore <= Z_SCORE_THRESHOLD) {
    console.log(`${source.label}: no statistical anomaly`);
    return;
  }

  await insertAnomaly(project7Url, project7Key, {
    source: source.name,
    detection_type: 'statistical',
    metric_name: 'hourly_failure_rate',
    window_start: mostRecent.windowStart,
    window_end: getWindowEnd(mostRecent.windowStart),
    observed_value: mostRecent.failureRate,
    baseline_value: baselineValue,
    z_score: zScore,
    details: {
      failure_count: mostRecent.failures,
      event_count: mostRecent.total,
      baseline_window_count: baselineWindows.length,
      threshold: Z_SCORE_THRESHOLD,
    },
  });
  console.log(`${source.label}: statistical anomaly stored`);
}

function findRepeatedFailureMatch(events) {
  const windowMilliseconds = REPEATED_FAILURE_WINDOW_MINUTES * 60 * 1000;
  let failureStreak = [];

  for (const event of events) {
    if (!FAILURE_STATUSES.has(String(event.status).toLowerCase())) {
      failureStreak = [];
      continue;
    }

    failureStreak.push(event);
    if (failureStreak.length >= REPEATED_FAILURE_THRESHOLD) {
      const windowFailures = failureStreak.slice(-REPEATED_FAILURE_THRESHOLD);
      const firstTimestamp = new Date(windowFailures[0].event_timestamp).getTime();
      const lastTimestamp = new Date(windowFailures[windowFailures.length - 1].event_timestamp).getTime();
      if (!Number.isNaN(firstTimestamp) && !Number.isNaN(lastTimestamp) && lastTimestamp - firstTimestamp <= windowMilliseconds) {
        return windowFailures;
      }
    }
  }

  return [];
}

async function detectPattern(source, events, project7Url, project7Key) {
  const matchedEvents = findRepeatedFailureMatch(events);
  if (matchedEvents.length === 0) {
    console.log(`${source.label}: no repeated-failure pattern`);
    return;
  }

  const firstTimestamp = matchedEvents[0].event_timestamp;
  const lastTimestamp = matchedEvents[matchedEvents.length - 1].event_timestamp;
  await insertAnomaly(project7Url, project7Key, {
    source: source.name,
    detection_type: 'pattern',
    metric_name: 'repeated_failures',
    window_start: firstTimestamp,
    window_end: lastTimestamp,
    observed_value: matchedEvents.length,
    baseline_value: null,
    z_score: null,
    details: {
      row_ids: matchedEvents.map((event) => event.source_row_id ?? event.id),
      failure_statuses: matchedEvents.map((event) => event.status),
      threshold: REPEATED_FAILURE_THRESHOLD,
      window_minutes: REPEATED_FAILURE_WINDOW_MINUTES,
    },
  });
  console.log(`${source.label}: repeated-failure pattern stored for ${matchedEvents.length} failures`);
}

async function detectSource(source, project7Url, project7Key, cutoff) {
  const events = await fetchEvents(source, project7Url, project7Key, cutoff);
  console.log(`${source.label}: checked ${events.length} events from the last ${LOOKBACK_HOURS} hours`);
  await detectStatistical(source, events, project7Url, project7Key);
  await detectPattern(source, events, project7Url, project7Key);
}

async function main() {
  const [project7Url, project7Key] = getRequiredEnv(
    'PROJECT7_SUPABASE_URL',
    'PROJECT7_SUPABASE_SERVICE_KEY',
  );
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  await Promise.all(sources.map(async (source) => {
    try {
      await detectSource(source, project7Url, project7Key, cutoff);
    } catch (error) {
      console.error(`FAILED - ${source.label}: ${error.message}`);
    }
  }));
}

main().catch((error) => {
  console.error(`Detection failed: ${error.message}`);
  process.exitCode = 1;
});