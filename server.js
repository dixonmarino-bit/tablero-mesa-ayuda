const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadDotEnv();

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');

const config = {
  zendeskBaseUrl: process.env.ZENDESK_SUBDOMAIN_URL,
  zendeskEmail: process.env.ZENDESK_EMAIL,
  zendeskApiToken: process.env.ZENDESK_API_TOKEN,
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS || 30000),
  slaTargetMinutes: Number(process.env.SLA_TARGET_MINUTES || 480),
  maxTicketsForAvg: Number(process.env.MAX_TICKETS_FOR_AVG || 200),
};

const hasZendeskCreds = Boolean(config.zendeskBaseUrl && config.zendeskEmail && config.zendeskApiToken);

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalIndex = line.indexOf('=');
    if (equalIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    const value = line.slice(equalIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function formatStartOfDayUTC() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  return start.toISOString().replace('.000Z', 'Z');
}

function getAuthHeader() {
  const token = Buffer.from(`${config.zendeskEmail}/token:${config.zendeskApiToken}`).toString('base64');
  return `Basic ${token}`;
}

async function zendeskGet(pathname) {
  const url = `${config.zendeskBaseUrl}${pathname}`;
  const response = await fetch(url, {
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zendesk API ${response.status}: ${body}`);
  }

  return response.json();
}

async function fetchSearchCount(query) {
  const encoded = encodeURIComponent(query);
  const data = await zendeskGet(`/api/v2/search.json?query=${encoded}&per_page=1`);
  return data.count || 0;
}

async function fetchSolvedTodayTicketIds(startIso) {
  const query = encodeURIComponent(`type:ticket status:solved solved>${startIso}`);
  let nextPath = `/api/v2/search.json?query=${query}&sort_by=updated_at&sort_order=desc&per_page=100`;
  const ids = [];

  while (nextPath && ids.length < config.maxTicketsForAvg) {
    const data = await zendeskGet(nextPath);
    for (const ticket of data.results || []) {
      ids.push(ticket.id);
      if (ids.length >= config.maxTicketsForAvg) {
        break;
      }
    }

    if (!data.next_page || ids.length >= config.maxTicketsForAvg) {
      break;
    }

    nextPath = data.next_page.replace(config.zendeskBaseUrl, '');
  }

  return ids;
}

async function fetchTicketMetric(ticketId) {
  const data = await zendeskGet(`/api/v2/tickets/${ticketId}/metrics.json`);
  return data.ticket_metric;
}

function minutesFromCalendarMetric(metricField) {
  if (!metricField || typeof metricField.calendar !== 'number') {
    return null;
  }
  return metricField.calendar;
}

function formatDuration(minutes) {
  if (minutes === null || Number.isNaN(minutes)) {
    return '--';
  }

  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')} h`;
  }

  return `${m} min`;
}

async function buildMetrics() {
  if (!hasZendeskCreds) {
    return {
      source: 'mock',
      updatedAt: new Date().toISOString(),
      refreshIntervalMs: config.refreshIntervalMs,
      metrics: {
        ticketsRecibidosHoy: 0,
        ticketsResueltosHoy: 0,
        ticketsPendientes: 0,
        frtPromedio: '--',
        tiempoResolucionPromedio: '--',
        slaCumplimiento: '--',
      },
      note: 'Configura las variables de entorno de Zendesk para ver datos reales.',
    };
  }

  const startIso = formatStartOfDayUTC();

  const [ticketsRecibidosHoy, ticketsResueltosHoy, ticketsPendientes] = await Promise.all([
    fetchSearchCount(`type:ticket created>${startIso}`),
    fetchSearchCount(`type:ticket status:solved solved>${startIso}`),
    fetchSearchCount('type:ticket status<solved'),
  ]);

  const solvedTicketIds = await fetchSolvedTodayTicketIds(startIso);
  let frtSum = 0;
  let frtCount = 0;
  let resolutionSum = 0;
  let resolutionCount = 0;
  let slaOk = 0;

  await Promise.all(
    solvedTicketIds.map(async (ticketId) => {
      try {
        const metric = await fetchTicketMetric(ticketId);

        const frt = minutesFromCalendarMetric(metric.reply_time_in_minutes);
        if (frt !== null) {
          frtSum += frt;
          frtCount += 1;
        }

        const resolution = minutesFromCalendarMetric(metric.full_resolution_time_in_minutes);
        if (resolution !== null) {
          resolutionSum += resolution;
          resolutionCount += 1;
          if (resolution <= config.slaTargetMinutes) {
            slaOk += 1;
          }
        }
      } catch (_error) {
        // Ignora tickets individuales con problemas para no romper todo el tablero.
      }
    })
  );

  const frtAvg = frtCount > 0 ? frtSum / frtCount : null;
  const resolutionAvg = resolutionCount > 0 ? resolutionSum / resolutionCount : null;
  const sla = resolutionCount > 0 ? `${Math.round((slaOk / resolutionCount) * 100)}%` : '--';

  return {
    source: 'zendesk',
    updatedAt: new Date().toISOString(),
    refreshIntervalMs: config.refreshIntervalMs,
    metrics: {
      ticketsRecibidosHoy,
      ticketsResueltosHoy,
      ticketsPendientes,
      frtPromedio: formatDuration(frtAvg),
      tiempoResolucionPromedio: formatDuration(resolutionAvg),
      slaCumplimiento: sla,
    },
    sampleSize: {
      ticketsConsiderados: solvedTicketIds.length,
      ticketsConFRT: frtCount,
      ticketsConResolucion: resolutionCount,
    },
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain; charset=utf-8' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (req.url === '/api/metrics') {
    try {
      const data = await buildMetrics();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 500, {
        message: 'No fue posible obtener métricas desde Zendesk.',
        detail: error.message,
      });
    }
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    sendFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  const normalizedPath = path.normalize(req.url).replace(/^\/+/, '');
  const requestedPath = path.join(publicDir, normalizedPath);

  if (!requestedPath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  sendFile(res, requestedPath);
});

server.listen(port, () => {
  console.log(`Tablero MVP disponible en http://localhost:${port}`);
});
