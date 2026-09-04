const { sendError, supabaseRequest } = require('../_supabase');
const { detectionLatencyMs } = require('../_latency');

module.exports = async function incidentDetail(req, res) {
  const incidentId = req.query?.id;

  if (!incidentId) {
    res.status(400).json({ error: 'Incident id is required' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const incidents = await supabaseRequest('incidents', {}, {
        select: 'id,incident_type,window_start,window_end,sources,anomaly_ids,summary,status,created_at',
        id: `eq.${incidentId}`,
        limit: 1,
      });
      if (incidents.length === 0) {
        res.status(404).json({ error: 'Incident not found' });
        return;
      }

      const incident = incidents[0];
      const anomalies = Array.isArray(incident.anomaly_ids) && incident.anomaly_ids.length > 0
        ? await supabaseRequest('anomalies', {}, {
          select: 'id,source,detection_type,metric_name,observed_value,baseline_value,z_score,details,window_start,window_end,detected_at,status',
          id: `in.(${incident.anomaly_ids.join(',')})`,
        })
        : [];
      const anomaliesById = new Map(anomalies.map((anomaly) => [String(anomaly.id), anomaly]));
      res.status(200).json({
        ...incident,
        detection_latency_ms: detectionLatencyMs(incident, anomaliesById),
        anomalies,
      });
      return;
    }

    if (req.method === 'PATCH') {
      const nextStatus = req.body?.status;
      if (!['resolved', 'true_positive', 'false_positive'].includes(nextStatus)) {
        res.status(400).json({ error: 'status must be resolved, true_positive, or false_positive' });
        return;
      }

      const rows = await supabaseRequest('incidents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ status: nextStatus }),
      }, {
        id: `eq.${incidentId}`,
      });
      if (rows.length === 0) {
        res.status(404).json({ error: 'Incident not found' });
        return;
      }
      res.status(200).json(rows[0]);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
