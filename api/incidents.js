const { sendError, supabaseRequest } = require('./_supabase');

function getCutoff(query) {
  if (query.from) {
    return query.from;
  }

  const hours = Number(query.hours || 168);
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 168;
  return new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
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
    const tickets = incidentIds.length > 0
      ? await supabaseRequest('tickets', {}, {
        select: 'id,incident_id,title,priority,status,slack_message_ts,created_at',
        incident_id: `in.(${incidentIds.join(',')})`,
      })
      : [];
    const ticketByIncident = new Map(tickets.map((ticket) => [String(ticket.incident_id), ticket]));

    res.status(200).json(incidents.map((incident) => ({
      ...incident,
      ticket: ticketByIncident.get(String(incident.id)) || null,
    })));
  } catch (error) {
    sendError(res, error);
  }
};
