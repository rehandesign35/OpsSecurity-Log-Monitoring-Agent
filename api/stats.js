const { sendError, supabaseRequest } = require('./_supabase');
const { detectionLatencyMs, uniqueAnomalyIds } = require('./_latency');

function getCutoff(query) {
  if (query.from) {
    return query.from;
  }

  const hours = Number(query.hours || 168);
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 168;
  return new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
}

async function fetchAnomaliesById(ids) {
  if (ids.length === 0) {
    return new Map();
  }

  const anomalies = await supabaseRequest('anomalies', {}, {
    select: 'id,detected_at',
    id: `in.(${ids.join(',')})`,
  });
  return new Map(anomalies.map((anomaly) => [String(anomaly.id), anomaly]));
}

module.exports = async function stats(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const query = req.query || {};
    const incidents = await supabaseRequest('incidents', {}, {
      select: 'id,incident_type,status,anomaly_ids,created_at',
      created_at: `gte.${getCutoff(query)}`,
      order: 'created_at.asc',
      limit: 500,
    });

    const reviewed = incidents.filter((incident) => ['true_positive', 'false_positive'].includes(incident.status));
    const falsePositives = reviewed.filter((incident) => incident.status === 'false_positive').length;
    const anomaliesById = await fetchAnomaliesById(uniqueAnomalyIds(incidents));
    const latencies = incidents
      .map((incident) => detectionLatencyMs(incident, anomaliesById))
      .filter((latency) => latency !== null);

    res.status(200).json({
      correlated: incidents.filter((incident) => incident.incident_type === 'correlated').length,
      single_source: incidents.filter((incident) => incident.incident_type === 'single_source').length,
      false_positive_count: falsePositives,
      resolved_count: reviewed.length,
      false_positive_rate: reviewed.length > 0 ? falsePositives / reviewed.length : null,
      avg_detection_latency_ms: latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      ticketed_incident_count: latencies.length,
    });
  } catch (error) {
    sendError(res, error);
  }
};
