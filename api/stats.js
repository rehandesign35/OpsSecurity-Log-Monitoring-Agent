const { sendError, supabaseRequest } = require('./_supabase');

function getCutoff(query) {
  if (query.from) {
    return query.from;
  }

  const hours = Number(query.hours || 168);
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 168;
  return new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
}

module.exports = async function stats(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const query = req.query || {};
    const filters = {
      created_at: `gte.${getCutoff(query)}`,
      order: 'created_at.asc',
      limit: 500,
    };
    const incidents = await supabaseRequest('incidents', {}, {
      select: 'id,incident_type,status,created_at',
      ...filters,
    });
    const tickets = await supabaseRequest('tickets', {}, {
      select: 'incident_id,created_at',
      created_at: `gte.${getCutoff(query)}`,
      limit: 500,
    });

    const resolved = incidents.filter((incident) => ['true_positive', 'false_positive'].includes(incident.status));
    const falsePositives = resolved.filter((incident) => incident.status === 'false_positive').length;
    const ticketByIncident = new Map(tickets.map((ticket) => [String(ticket.incident_id), ticket]));
    const latencies = incidents
      .map((incident) => {
        const ticket = ticketByIncident.get(String(incident.id));
        if (!ticket) return null;
        const latency = new Date(ticket.created_at).getTime() - new Date(incident.created_at).getTime();
        return Number.isFinite(latency) && latency >= 0 ? latency : null;
      })
      .filter((latency) => latency !== null);

    res.status(200).json({
      correlated: incidents.filter((incident) => incident.incident_type === 'correlated').length,
      single_source: incidents.filter((incident) => incident.incident_type === 'single_source').length,
      false_positive_count: falsePositives,
      resolved_count: resolved.length,
      false_positive_rate: resolved.length > 0 ? falsePositives / resolved.length : null,
      avg_detection_latency_ms: latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      ticketed_incident_count: latencies.length,
    });
  } catch (error) {
    sendError(res, error);
  }
};
