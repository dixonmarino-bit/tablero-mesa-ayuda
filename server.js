const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadDotEnv();

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');

const config = {
  zendeskBaseUrl: process.env.ZENDESK_SUBDOMAIN_URL,
  zendeskEmail: process.env.ZENDESK_EMAIL,
  zendeskApiToken: process.env.ZENDESK_API_TOKEN,
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS || 60000),
  slaTargetMinutes: Number(process.env.SLA_TARGET_MINUTES || 480),
  maxTicketsForAvg: Number(process.env.MAX_TICKETS_FOR_AVG || 100),
  maxConcurrentZendeskCalls: Number(process.env.MAX_CONCURRENT_ZENDESK_CALLS || 6),
  zendeskMaxRetries: Number(process.env.ZENDESK_MAX_RETRIES || 4),
  zendeskRetryBaseDelayMs: Number(process.env.ZENDESK_RETRY_BASE_DELAY_MS || 500),
  webhookSecret: process.env.ZENDESK_WEBHOOK_SECRET || '',
  webhookDebounceMs: Number(process.env.WEBHOOK_DEBOUNCE_MS || 1500),
  webhookSignatureHeader: (process.env.ZENDESK_WEBHOOK_SIGNATURE_HEADER || 'x-zendesk-webhook-signature').toLowerCase(),
  webhookTimestampHeader: (process.env.ZENDESK_WEBHOOK_TIMESTAMP_HEADER || 'x-zendesk-webhook-signature-timestamp').toLowerCase(),
};

const hasZendeskCreds = Boolean(config.zendeskBaseUrl && config.zendeskEmail && config.zendeskApiToken);

const runtime = {
  metricsState: {
    source: hasZendeskCreds ? 'zendesk' : 'mock',
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
    note: hasZendeskCreds ? 'Esperando primera sincronización...' : 'Configura variables de Zendesk para datos reales.',
  },
  lastError: null,
  reconciling: false,
  queuedReconcileReason: null,
  webhookQueue: [],
  webhookProcessing: false,
  webhookDebounceTimer: null,
  sseClients: new Set(),
};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let attempt = 0;

  while (attempt <= config.zendeskMaxRetries) {
    const url = `${config.zendeskBaseUrl}${pathname}`;
    const response = await fetch(url, {
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      return response.json();
    }

    const retryAfter = Number(response.headers.get('retry-after') || 0);
    const shouldRetry = response.status === 429 || response.status >= 500;

    if (!shouldRetry || attempt === config.zendeskMaxRetries) {
      const body = await response.text();
      throw new Error(`Zendesk API ${response.status}: ${body}`);
    }

    const delay = retryAfter > 0
      ? retryAfter * 1000
      : config.zendeskRetryBaseDelayMs * Math.pow(2, attempt);

    await sleep(delay);
    attempt += 1;
  }

  throw new Error('Fallo inesperado consultando Zendesk.');
}

async function withConcurrency(items, limit, task) {
  const workers = [];
  let index = 0;

  async function worker() {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) {
        return;
      }
      await task(items[i], i);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), Math.max(items.length, 1));
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
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

function publishSseEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of runtime.sseClients) {
    client.write(payload);
  }
}

async function computeMetricsFromZendesk() {
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

  await withConcurrency(solvedTicketIds, config.maxConcurrentZendeskCalls, async (ticketId) => {
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
      // No frena el tablero por un ticket individual.
    }
  });

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

function buildMockMetrics(note) {
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
    note,
  };
}

async function reconcileMetrics(reason) {
  if (runtime.reconciling) {
    runtime.queuedReconcileReason = reason;
    return;
  }

  runtime.reconciling = true;
  try {
    if (!hasZendeskCreds) {
      runtime.metricsState = buildMockMetrics('Configura variables de Zendesk para datos reales.');
      publishSseEvent('metrics', runtime.metricsState);
      return;
    }

    const fresh = await computeMetricsFromZendesk();
    fresh.reconcileReason = reason;
    runtime.metricsState = fresh;
    runtime.lastError = null;
    publishSseEvent('metrics', runtime.metricsState);
  } catch (error) {
    runtime.lastError = {
      at: new Date().toISOString(),
      message: error.message,
      reason,
    };

    runtime.metricsState = {
      ...runtime.metricsState,
      note: `Última actualización fallida (${reason}): ${error.message}`,
    };
    publishSseEvent('error', runtime.lastError);
  } finally {
    runtime.reconciling = false;

    if (runtime.queuedReconcileReason) {
      const queuedReason = runtime.queuedReconcileReason;
      runtime.queuedReconcileReason = null;
      reconcileMetrics(`${queuedReason}:queued`);
    }
  }
}

function timingSafeCompare(a, b) {
  const aBuffer = Buffer.from(a || '', 'utf8');
  const bBuffer = Buffer.from(b || '', 'utf8');
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function verifyWebhookSignature(rawBodyBuffer, headers) {
  if (!config.webhookSecret) {
    return true;
  }

  const signatureHeader = headers[config.webhookSignatureHeader] || '';
  const timestamp = headers[config.webhookTimestampHeader] || '';
  const payloadBuffer = timestamp
    ? Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuffer])
    : rawBodyBuffer;
  const digest = crypto.createHmac('sha256', config.webhookSecret).update(payloadBuffer).digest();
  const expectedBase64 = digest.toString('base64');
  const expectedHex = digest.toString('hex');

  return timingSafeCompare(signatureHeader, expectedBase64)
    || timingSafeCompare(signatureHeader, expectedHex);
}

function queueWebhookEvent(eventPayload) {
  runtime.webhookQueue.push({ at: new Date().toISOString(), eventPayload });
  processWebhookQueue();
}

async function processWebhookQueue() {
  if (runtime.webhookProcessing) {
    return;
  }

  runtime.webhookProcessing = true;

  while (runtime.webhookQueue.length > 0) {
    runtime.webhookQueue.shift();

    if (runtime.webhookDebounceTimer) {
      clearTimeout(runtime.webhookDebounceTimer);
    }

    runtime.webhookDebounceTimer = setTimeout(() => {
      reconcileMetrics('webhook');
    }, config.webhookDebounceMs);
  }

  runtime.webhookProcessing = false;
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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bufferChunk);
      size += bufferChunk.length;

      if (size > 2_000_000) {
        reject(new Error('Payload demasiado grande.'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (req.method === 'GET' && req.url === '/api/metrics') {
    sendJson(res, 200, {
      ...runtime.metricsState,
      runtime: {
        reconciling: runtime.reconciling,
        lastError: runtime.lastError,
      },
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    runtime.sseClients.add(res);
    res.write(`event: metrics\ndata: ${JSON.stringify(runtime.metricsState)}\n\n`);

    req.on('close', () => {
      runtime.sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/zendesk/webhook') {
    try {
      const rawBody = await readRequestBody(req);
      const rawBodyText = rawBody.toString('utf8');
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value || '')])
      );

      if (!verifyWebhookSignature(rawBody, headers)) {
        sendJson(res, 401, { message: 'Firma de webhook inválida.' });
        return;
      }

      let payload = {};
      try {
        payload = rawBodyText ? JSON.parse(rawBodyText) : {};
      } catch (_error) {
        sendJson(res, 400, { message: 'JSON inválido en webhook.' });
        return;
      }

      queueWebhookEvent(payload);
      sendJson(res, 202, { message: 'Evento recibido.', queued: true });
      return;
    } catch (error) {
      sendJson(res, 500, { message: 'Error procesando webhook.', detail: error.message });
      return;
    }
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, {
      status: 'ok',
      hasZendeskCreds,
      sseClients: runtime.sseClients.size,
      webhookQueue: runtime.webhookQueue.length,
      reconciling: runtime.reconciling,
      updatedAt: runtime.metricsState.updatedAt,
      lastError: runtime.lastError,
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    sendFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  if (req.method === 'GET') {
    const normalizedPath = path.normalize(req.url).replace(/^\/+/, '');
    const requestedPath = path.join(publicDir, normalizedPath);

    if (!requestedPath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    sendFile(res, requestedPath);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

setInterval(() => {
  reconcileMetrics('interval');
}, config.refreshIntervalMs);

reconcileMetrics('startup');

server.listen(port, () => {
  console.log(`Tablero MVP disponible en http://localhost:${port}`);
});
