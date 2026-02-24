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

let intervalMs = 30000;

function setMetricValue(field, value) {
  const el = document.getElementById(field);
  if (el) {
    el.textContent = value;
  }
}

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
