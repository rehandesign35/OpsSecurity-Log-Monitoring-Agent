const MAX_LIVE_DETECTION_LATENCY_MS = 90 * 60 * 1000;

function hasLiveAnomalies(incident) {
  return Array.isArray(incident.anomaly_ids) && incident.anomaly_ids.length > 0;
}

function uniqueAnomalyIds(incidents) {
  return [...new Set(incidents.flatMap((incident) => (
    hasLiveAnomalies(incident) ? incident.anomaly_ids.map((id) => String(id)) : []
  )))];
}

function detectionLatencyMs(incident, anomaliesById) {
  if (!hasLiveAnomalies(incident) || !anomaliesById) {
    return null;
  }

  const detectedAtTimes = incident.anomaly_ids
    .map((id) => anomaliesById.get(String(id)))
    .map((anomaly) => {
      const timestamp = anomaly?.detected_at || anomaly?.created_at;
      return timestamp ? new Date(timestamp).getTime() : NaN;
    })
    .filter((value) => Number.isFinite(value));

  if (detectedAtTimes.length === 0) {
    return null;
  }

  const latency = new Date(incident.created_at).getTime() - Math.min(...detectedAtTimes);
  return Number.isFinite(latency) && latency >= 0 && latency <= MAX_LIVE_DETECTION_LATENCY_MS
    ? latency
    : null;
}

module.exports = {
  MAX_LIVE_DETECTION_LATENCY_MS,
  detectionLatencyMs,
  hasLiveAnomalies,
  uniqueAnomalyIds,
};
