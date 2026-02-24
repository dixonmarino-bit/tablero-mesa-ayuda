const statusText = document.getElementById('statusText');
const sampleText = document.getElementById('sampleText');

const fields = [
  'ticketsRecibidosHoy',
  'ticketsResueltosHoy',
  'ticketsPendientes',
  'frtPromedio',
  'tiempoResolucionPromedio',
  'slaCumplimiento',
];

let fallbackIntervalMs = 60000;
let fallbackTimer = null;
let sseRetryTimer = null;
let activeSse = null;
let usingSse = false;

function setMetricValue(field, value) {
  const el = document.getElementById(field);
  if (el) {
    el.textContent = value;
  }
}

function renderMetrics(data, transportLabel) {
  for (const field of fields) {
    setMetricValue(field, data.metrics?.[field] ?? '--');
  }

  fallbackIntervalMs = Number(data.refreshIntervalMs || fallbackIntervalMs);
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : '--';
  statusText.textContent = `Última actualización: ${updated} | Fuente: ${data.source || 'n/a'} | Canal: ${transportLabel}`;

  if (data.note) {
    sampleText.textContent = data.note;
  } else if (data.sampleSize) {
    sampleText.textContent = `Muestra para promedios: ${data.sampleSize.ticketsConsiderados} tickets resueltos hoy.`;
  } else {
    sampleText.textContent = '';
  }
}

async function loadMetricsOnce() {
  const response = await fetch('/api/metrics');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  renderMetrics(data, usingSse ? 'SSE' : 'polling');
}

async function pollLoop() {
  try {
    await loadMetricsOnce();
  } catch (error) {
    statusText.textContent = `Error al cargar métricas: ${error.message}`;
  } finally {
    fallbackTimer = setTimeout(pollLoop, fallbackIntervalMs);
  }
}

function stopPolling() {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function scheduleSseRetry() {
  if (sseRetryTimer) {
    return;
  }

  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    startSse();
  }, 20000);
}

function startFallbackPolling() {
  usingSse = false;
  stopPolling();
  pollLoop();
  scheduleSseRetry();
}

function startSse() {
  if (!window.EventSource) {
    startFallbackPolling();
    return;
  }

  if (activeSse) {
    activeSse.close();
  }

  const source = new EventSource('/api/stream');
  activeSse = source;

  source.addEventListener('open', () => {
    usingSse = true;
    stopPolling();
    if (sseRetryTimer) {
      clearTimeout(sseRetryTimer);
      sseRetryTimer = null;
    }
  });

  source.addEventListener('metrics', (event) => {
    try {
      const data = JSON.parse(event.data);
      renderMetrics(data, 'SSE');
    } catch (_error) {
      // Ignorar mensajes malformados.
    }
  });

  source.addEventListener('error', () => {
    source.close();
    if (activeSse === source) {
      activeSse = null;
    }
    startFallbackPolling();
  });
}

startSse();
