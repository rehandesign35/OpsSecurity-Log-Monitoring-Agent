const { sendError, supabaseRequest } = require('./_supabase');

const SOURCES = [
  { id: 'project1_calls', label: 'Project 1 / calls' },
  { id: 'project5_pipeline_runs', label: 'Project 5 / pipeline runs' },
];

module.exports = async function health(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rows = await supabaseRequest('source_health', {}, {
      select: 'id,source,run_id,status,error_message,checked_at',
      order: 'checked_at.desc',
      limit: 100,
    });
    const latestBySource = new Map();
    rows.forEach((row) => {
      if (!latestBySource.has(row.source)) {
        latestBySource.set(row.source, row);
      }
    });

    res.status(200).json(SOURCES.map((source) => ({
      ...source,
      ...(latestBySource.get(source.id) || { status: 'unknown', checked_at: null, error_message: null }),
    })));
  } catch (error) {
    sendError(res, error);
  }
};
