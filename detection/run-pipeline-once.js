const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile();
}

const { runIngestion } = require('../ingestion/ingest');
const { runDegradationCheck } = require('../api/check-degradation');
const { runDetection } = require('./detect');
const { runCorrelation } = require('./correlate');
const { runSummarization } = require('../summarization/summarize');
const { runAlertAndTicket } = require('../api/alert-and-ticket');

async function runStage(number, name, run, formatResult) {
  console.log(`\nSTART STAGE ${number} (${name})`);
  try {
    const result = await run({ strict: true });
    console.log(`STAGE ${number} (${name}): ${formatResult(result)}`);
    return result;
  } catch (error) {
    console.error(`STAGE ${number} (${name}) FAILED:`);
    console.error(error.stack || error);
    throw error;
  }
}

async function main() {
  const ingestion = await runStage(1, 'ingest', runIngestion, (result) =>
    `${result.newCount} new events ingested (${result.fetched} source rows fetched)`);
  const degradation = await runStage(2, 'check-degradation', runDegradationCheck, (result) =>
    `completed; Slack fired=${result.slackFired ? 'yes' : 'no'}`);
  const detection = await runStage(3, 'detect', runDetection, (result) =>
    result.anomaliesCreated > 0
      ? `${result.anomaliesCreated} anomalies created`
      : '0 anomalies created - check thresholds or lookback window');
  const correlation = await runStage(4, 'correlate', runCorrelation, (result) =>
    `${result.incidentsCreated} incidents created (${result.correlatedIncidents} correlated, ${result.singleSourceIncidents} single-source)`);
  const summarization = await runStage(5, 'summarize', runSummarization, (result) =>
    `${result.incidentsSummarized} incidents summarized`);
  const alerting = await runStage(6, 'alert-and-ticket', runAlertAndTicket, (result) =>
    `${result.ticketsCreated} ticket(s) created; Slack fired=${result.slackFired ? 'yes' : 'no'}`);

  const correlationSucceeded = correlation.twoSourceCorrelatedIncidents === 1 && correlation.singleSourceIncidents === 0;
  console.log('\n=== FINAL PIPELINE SUMMARY ===');
  console.log(`Total anomalies created: ${detection.anomaliesCreated}`);
  console.log(`Total incidents created: ${correlation.incidentsCreated}`);
  console.log(`Correlation succeeded (2 sources in one incident): ${correlationSucceeded ? 'yes' : 'no'}`);
  console.log(`Slack fired: ${alerting.slackFired ? 'yes' : 'no'}`);
  console.log(`Ticket created: ${alerting.ticketsCreated > 0 ? 'yes' : 'no'}`);
  console.log(`Ingestion: ${ingestion.newCount} new event(s); degradation check Slack fired: ${degradation.slackFired ? 'yes' : 'no'}; summarized: ${summarization.incidentsSummarized}`);
}

main().catch((error) => {
  console.error(`\nPipeline stopped after the failing stage: ${error.message}`);
  process.exitCode = 1;
});