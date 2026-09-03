# Ops Security Log-Monitoring Agent

Project 7 of an AI engineering portfolio. This repository will monitor operational and security logs from prior projects.

## Step 1: Connection test

This step only verifies read access to the existing Supabase tables:

- Project 1: `calls`
- Project 5: `pipeline_runs`

Copy `.env.example` to `.env`, fill in the Supabase values, and run:

```bash
npm run test-connection
```

The script uses Supabase's REST API and reports the five most recent rows and each source's newest timestamp. It does not perform detection, correlation, summarization, or alerting.

## Step 2: Scheduled ingestion

The ingestion agent reads rows created or updated in the last 24 hours from both source tables, normalizes them, and upserts them into Project 7's `ingested_events` table. Re-running the agent is safe because the destination uses `(source, source_row_id)` for deduplication.

Run it locally with:

```bash
npm run ingest
```

GitHub Actions runs the same command every 30 minutes and supports manual dispatch. Configure all six Supabase values as repository secrets before enabling the workflow.

## Step 4: Incident correlation

The correlation agent groups unattached open anomalies from the last 24 hours by overlapping or nearby time windows and stores each group in the `incidents` table. Run it locally with:

```bash
npm run correlate
```

The scheduled workflow runs correlation after ingestion and detection.
