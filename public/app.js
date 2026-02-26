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
let usingSse = false;
let intervalMs = 30000;

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

function startFallbackPolling() {
  usingSse = false;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
  }
  pollLoop();
}

function startSse() {
  if (!window.EventSource) {
    startFallbackPolling();
    return;
  }

  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    usingSse = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
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
    startFallbackPolling();
  });
}

startSse();
async function loadMetrics() {
  try {
    const response = await fetch('/api/metrics');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    for (const field of fields) {
      setMetricValue(field, data.metrics[field] ?? '--');
    }

    intervalMs = Number(data.refreshIntervalMs || intervalMs);
    const updated = new Date(data.updatedAt).toLocaleTimeString();
    statusText.textContent = `Última actualización: ${updated} | Fuente: ${data.source}`;

    if (data.note) {
      sampleText.textContent = data.note;
    } else if (data.sampleSize) {
      sampleText.textContent = `Muestra para promedios: ${data.sampleSize.ticketsConsiderados} tickets resueltos hoy.`;
    } else {
      sampleText.textContent = '';
    }
  } catch (error) {
    statusText.textContent = `Error al cargar métricas: ${error.message}`;
  } finally {
    setTimeout(loadMetrics, intervalMs);
  }
}

loadMetrics();
