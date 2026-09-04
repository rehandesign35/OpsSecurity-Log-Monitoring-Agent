const state = { hours: 24, status: 'all', incidents: [] };

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character]));
}

function formatDate(value, withDate = true) {
  if (!value) return 'No timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: withDate ? 'short' : undefined,
    day: withDate ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function timeSince(value) {
  if (!value) return 'No check recorded';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatLatency(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return '—';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function setLoading(isLoading) {
  $('#timeline-status').textContent = isLoading ? 'Syncing' : 'Live';
  $('#refresh-button').disabled = isLoading;
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function incidentTitle(incident) {
  const sources = Array.isArray(incident.sources) ? incident.sources.join(' + ') : 'Unknown source';
  return `${incident.incident_type === 'correlated' ? 'Correlated anomaly' : 'Single-source anomaly'} / ${sources}`;
}

function renderTimeline(incidents) {
  const timeline = $('#timeline');
  if (incidents.length === 0) {
    timeline.innerHTML = '<div class="empty-state">No incidents match this window.</div>';
    return;
  }

  timeline.innerHTML = incidents.map((incident) => {
    const priority = incident.ticket?.priority || 'unassigned';
    const status = incident.status || 'open';
    return `<article class="timeline-item" data-incident-id="${escapeHtml(incident.id)}">
      <div class="timeline-time"><strong>${escapeHtml(formatDate(incident.window_start))}</strong><span>to ${escapeHtml(formatDate(incident.window_end, false))}</span></div>
      <div class="incident-main">
        <div class="incident-title">
          <h3>${escapeHtml(incidentTitle(incident))}</h3>
          <span class="badge badge-${escapeHtml(incident.incident_type)}">${escapeHtml(incident.incident_type.replace('_', ' '))}</span>
          <span class="badge badge-${escapeHtml(status)}">${escapeHtml(status.replace('_', ' '))}</span>
        </div>
        <div class="incident-meta"><span>${escapeHtml((incident.sources || []).join(' / '))}</span><span>${(incident.anomaly_ids || []).length} anomalies</span><span>Created ${escapeHtml(formatDate(incident.created_at))}</span></div>
        <p class="incident-summary">${escapeHtml(incident.summary || 'Summary pending')}</p>
      </div>
      <div class="incident-action">
        <span class="priority priority-${escapeHtml(priority)}">${escapeHtml(priority)}</span>
        <button class="detail-button" type="button" data-detail="${escapeHtml(incident.id)}" aria-expanded="false">Details +</button>
        ${status === 'open' ? `<div class="resolution-actions"><button type="button" data-resolution="true_positive" data-id="${escapeHtml(incident.id)}">True +</button><button type="button" data-resolution="false_positive" data-id="${escapeHtml(incident.id)}">False +</button></div>` : ''}
      </div>
    </article>`;
  }).join('');
}

function renderHealth(health) {
  $('#health-list').innerHTML = health.map((source) => {
    const status = source.status || 'unknown';
    const error = status === 'degraded' && source.error_message ? `<span class="health-error">${escapeHtml(source.error_message)}</span>` : '';
    return `<div class="health-item"><span class="health-light ${escapeHtml(status)}"></span><div><span class="health-name">${escapeHtml(source.label)}</span>${error}</div><span class="health-time">${escapeHtml(timeSince(source.checked_at))}</span></div>`;
  }).join('');
}

function renderActivityGraph(incidents) {
  const chart = $('#activity-chart');
  const bucketCount = state.hours <= 24 ? 12 : 14;
  const bucketSize = (state.hours * 60 * 60 * 1000) / bucketCount;
  const now = Date.now();
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: now - (bucketCount - index) * bucketSize,
    correlated: 0,
    single: 0,
  }));

  incidents.forEach((incident) => {
    const timestamp = new Date(incident.created_at).getTime();
    const bucket = buckets.find((candidate, index) => timestamp >= candidate.start && timestamp < candidate.start + bucketSize && index < bucketCount);
    if (bucket) {
      if (incident.incident_type === 'correlated') bucket.correlated += 1;
      else bucket.single += 1;
    }
  });

  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.correlated + bucket.single));
  chart.innerHTML = buckets.every((bucket) => bucket.correlated + bucket.single === 0)
    ? '<span class="activity-empty">No incident activity in this window.</span>'
    : buckets.map((bucket) => {
      const correlatedHeight = bucket.correlated ? Math.max(6, (bucket.correlated / maximum) * 100) : 0;
      const singleHeight = bucket.single ? Math.max(6, (bucket.single / maximum) * 100) : 0;
      const label = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(bucket.start + bucketSize / 2));
      return `<div class="activity-column" title="${escapeHtml(label)} / correlated ${bucket.correlated} / single-source ${bucket.single}"><div class="activity-bar" style="height:${correlatedHeight}%"></div><div class="activity-bar single" style="height:${singleHeight}%"></div><span class="activity-label">${escapeHtml(label)}</span></div>`;
    }).join('');
}

function renderStats(stats, incidents) {
  const openCount = incidents.filter((incident) => incident.status === 'open').length;
  const total = stats.correlated + stats.single_source;
  const correlatedPercent = total > 0 ? (stats.correlated / total) * 100 : 0;
  $('#incident-count').textContent = incidents.length;
  $('#open-count').textContent = openCount;
  $('#open-detail').textContent = openCount === 1 ? 'Needs review' : 'Current open state';
  $('#fp-rate').textContent = stats.false_positive_rate === null ? '—' : `${(stats.false_positive_rate * 100).toFixed(1)}%`;
  $('#latency').textContent = formatLatency(stats.avg_detection_latency_ms);
  $('#latency-stamp-value').textContent = formatLatency(stats.avg_detection_latency_ms);
  $('#signal-mix').textContent = `${stats.correlated} / ${stats.single_source}`;
  $('#correlated-count').textContent = stats.correlated;
  $('#single-count').textContent = stats.single_source;
  $('#chart-total').textContent = total;
  $('#chart-ring').style.background = `conic-gradient(var(--cobalt) 0 ${correlatedPercent}%, var(--coral) ${correlatedPercent}% 100%)`;
}

async function loadDashboard() {
  setLoading(true);
  const query = `hours=${state.hours}&status=${encodeURIComponent(state.status)}`;
  try {
    const [incidents, stats, health] = await Promise.all([
      getJson(`/api/incidents?${query}`),
      getJson(`/api/stats?${query}`),
      getJson('/api/health'),
    ]);
    state.incidents = incidents;
    renderTimeline(incidents);
    renderStats(stats, incidents);
    renderActivityGraph(incidents);
    renderHealth(health);
    $('#last-refresh').textContent = `Updated ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())}`;
    $('#timeline-status').textContent = 'Live';
  } catch (error) {
    $('#timeline').innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
    $('#timeline-status').textContent = 'Error';
  } finally {
    setLoading(false);
  }
}

async function toggleDetails(button) {
  const item = button.closest('.timeline-item');
  const existing = item.querySelector('.anomaly-details');
  if (existing) {
    existing.remove();
    button.textContent = 'Details +';
    button.setAttribute('aria-expanded', 'false');
    return;
  }

  button.textContent = 'Loading';
  try {
    const detail = await getJson(`/api/incidents/${encodeURIComponent(item.dataset.incidentId)}`);
    const details = (detail.anomalies || []).map((anomaly) => `<div class="anomaly-card"><strong>${escapeHtml(anomaly.metric_name || anomaly.detection_type)}</strong><p>${escapeHtml(anomaly.source)} / ${escapeHtml(anomaly.detection_type)}</p><p>Observed ${escapeHtml(anomaly.observed_value)} · Baseline ${escapeHtml(anomaly.baseline_value ?? '—')} · z ${escapeHtml(anomaly.z_score ?? '—')}</p><p>${escapeHtml(JSON.stringify(anomaly.details || {}))}</p></div>`).join('');
    item.insertAdjacentHTML('beforeend', `<div class="anomaly-details">${details || '<div class="empty-state">No anomaly records found.</div>'}</div>`);
    button.textContent = 'Details −';
    button.setAttribute('aria-expanded', 'true');
  } catch (error) {
    button.textContent = 'Retry details';
    console.error(error);
  }
}

async function resolveIncident(id, status) {
  const button = document.querySelector(`[data-resolution][data-id="${CSS.escape(id)}"][data-resolution="${status}"]`);
  if (button) button.disabled = true;
  try {
    await getJson(`/api/incidents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await loadDashboard();
  } catch (error) {
    if (button) button.disabled = false;
    alert(error.message);
  }
}

document.addEventListener('click', (event) => {
  const detailButton = event.target.closest('[data-detail]');
  if (detailButton) toggleDetails(detailButton);
  const resolutionButton = event.target.closest('[data-resolution]');
  if (resolutionButton) resolveIncident(resolutionButton.dataset.id, resolutionButton.dataset.resolution);
  if (event.target.closest('#refresh-button')) loadDashboard();
  const segment = event.target.closest('[data-hours]');
  if (segment) {
    document.querySelectorAll('[data-hours]').forEach((button) => button.classList.remove('is-active'));
    segment.classList.add('is-active');
    state.hours = Number(segment.dataset.hours);
    loadDashboard();
  }
});

$('#status-filter').addEventListener('change', (event) => {
  state.status = event.target.value;
  loadDashboard();
});

loadDashboard();
