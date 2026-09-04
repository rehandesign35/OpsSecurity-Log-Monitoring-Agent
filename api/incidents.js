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

module.exports = async function incidents(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const query = req.query || {};
    const incidents = await supabaseRequest('incidents', {}, {
      select: 'id,incident_type,window_start,window_end,sources,anomaly_ids,summary,status,created_at',
      created_at: `gte.${getCutoff(query)}`,
      status: query.status && query.status !== 'all' ? `eq.${query.status}` : undefined,
      order: 'created_at.desc',
      limit: 500,
    });

    const incidentIds = incidents.map((incident) => incident.id);
    const [tickets, anomaliesById] = await Promise.all([
      incidentIds.length > 0
        ? supabaseRequest('tickets', {}, {
          select: 'id,incident_id,title,priority,status,slack_message_ts,created_at',
          incident_id: `in.(${incidentIds.join(',')})`,
        })
        : Promise.resolve([]),
      fetchAnomaliesById(uniqueAnomalyIds(incidents)),
    ]);
    const ticketByIncident = new Map(tickets.map((ticket) => [String(ticket.incident_id), ticket]));

    res.status(200).json(incidents.map((incident) => ({
      ...incident,
      detection_latency_ms: detectionLatencyMs(incident, anomaliesById),
      ticket: ticketByIncident.get(String(incident.id)) || null,
    })));
  } catch (error) {
    sendError(res, error);
  }
};
