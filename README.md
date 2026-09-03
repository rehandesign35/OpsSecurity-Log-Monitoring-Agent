# Ops Security Log-Monitoring Agent

Project 7 of an AI engineering portfolio. This repository will monitor operational and security logs from prior projects.

## Step 1: Connection test

This step only verifies read access to the existing Supabase tables:

- Project 1: `calls`
- Project 5: `pipeline_runs`

Copy `.env.example` to `.env`, fill in the four Supabase values, and run:

```bash
npm run test-connection
```

The script uses Supabase's REST API and reports the five most recent rows and each source's newest timestamp. It does not perform detection, correlation, summarization, or alerting.
