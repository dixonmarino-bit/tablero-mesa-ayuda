# Tablero Mesa de Ayuda (MVP local + webhook-ready)

Este proyecto implementa un tablero local de KPIs de mesa de ayuda con:

- **Visualización de la franja superior** (6 KPIs críticos).
- **Actualización casi en tiempo real** por **webhook de Zendesk + SSE**.
- **Reconciliación periódica** para consistencia.
- **Controles anti-rate-limit** (concurrencia limitada, retry y backoff para 429/5xx).

---

## 1) Qué métricas muestra
# Tablero Mesa de Ayuda (MVP local)

Este proyecto crea un tablero local inspirado en tu imagen, empezando por la **franja superior de KPIs críticos** conectada con Zendesk en tiempo casi real.

## Métricas incluidas (MVP)

1. Tickets recibidos hoy.
2. Tickets resueltos hoy.
3. Tickets pendientes.
4. FRT promedio (first reply time) sobre tickets resueltos hoy.
5. Tiempo promedio de resolución sobre tickets resueltos hoy.
6. SLA cumplimiento (% dentro de `SLA_TARGET_MINUTES`).

> Nota MVP: SLA se calcula por umbral global en minutos. En una versión avanzada se reemplaza por políticas SLA nativas (por prioridad/grupo).

---

## 2) Arquitectura de actualización (recomendada)

### Flujo principal

1. Zendesk envía evento a `POST /api/zendesk/webhook`.
2. El servidor valida firma HMAC (si hay secret configurado).
3. Se encola el evento y se agrupan bursts con debounce.
4. Se dispara reconciliación contra Zendesk.
5. Se publica al navegador por **SSE** (`/api/stream`).

### Flujo de respaldo

- Además corre reconciliación cada `REFRESH_INTERVAL_MS`.
- Si SSE falla, frontend cae a polling de `/api/metrics`.

Este enfoque evita depender 100% de webhooks y reduce carga de API versus polling agresivo.

---

## 3) Requisitos

- Node.js 18 o superior.
- Cuenta Zendesk Support con permisos para API + admin de Webhooks/Triggers.
- (Para pruebas webhook en local) túnel público: ngrok o Cloudflare Tunnel.

---

## 4) Instalación local

```bash
cp .env.example .env
node --check server.js
node server.js
```

Abrir: `http://localhost:3000`

> Este proyecto no requiere instalar dependencias externas.

---

## 5) Configuración completa de `.env`

### App

- `PORT`: puerto local (default 3000).
- `REFRESH_INTERVAL_MS`: reconciliación periódica (recomendado 60s a 300s).

### Zendesk API

- `ZENDESK_SUBDOMAIN_URL`: ej. `https://miempresa.zendesk.com`
- `ZENDESK_EMAIL`: correo del usuario API.
- `ZENDESK_API_TOKEN`: token API.
- `SLA_TARGET_MINUTES`: umbral SLA global (MVP).
- `MAX_TICKETS_FOR_AVG`: tamaño de muestra para promedios.
- `MAX_CONCURRENT_ZENDESK_CALLS`: concurrencia de requests (recomendado 4-8).
- `ZENDESK_MAX_RETRIES`: reintentos para 429/5xx.
- `ZENDESK_RETRY_BASE_DELAY_MS`: backoff base (ms).

### Webhook

- `ZENDESK_WEBHOOK_SECRET`: secret compartido para validar firma.
- `ZENDESK_WEBHOOK_SIGNATURE_HEADER`: default `x-zendesk-webhook-signature`.
- `ZENDESK_WEBHOOK_TIMESTAMP_HEADER`: default `x-zendesk-webhook-signature-timestamp`.
- `WEBHOOK_DEBOUNCE_MS`: agrupar bursts de eventos antes de reconciliar.

---

## 6) Configurar API token en Zendesk

1. En Zendesk Admin Center entra a **Apps and integrations → APIs → Zendesk API**.
2. Habilita token access (si no está habilitado).
3. Crea un token y cópialo.
4. Completa en `.env`:
   - `ZENDESK_SUBDOMAIN_URL`
   - `ZENDESK_EMAIL`
   - `ZENDESK_API_TOKEN`

---

## 7) Configurar webhooks Zendesk (paso a paso)

> Zendesk necesita una URL HTTPS pública para webhook. Si corres local, expón tu app por túnel.

### 7.1 Exponer localhost por túnel

Ejemplo con ngrok:

```bash
ngrok http 3000
```

Te dará una URL como: `https://abc123.ngrok-free.app`

### 7.2 Crear webhook en Zendesk

1. Admin Center → **Apps and integrations → Webhooks**.
2. Create webhook.
3. Tipo: **Trigger or automation**.
4. Endpoint URL: `https://abc123.ngrok-free.app/api/zendesk/webhook`
5. Method: `POST`
6. Format: JSON
7. Authentication:
   - Si usas firma, define un secret y guarda el mismo en `ZENDESK_WEBHOOK_SECRET`.
8. Guardar.

### 7.3 Crear trigger para eventos de tickets

1. Admin Center → **Objects and rules → Business rules → Triggers**.
2. Create trigger: `Mesa Ayuda - push dashboard events`.
3. Condiciones recomendadas (ANY):
   - Ticket is Created
   - Ticket Status Changed
   - Assignee Changed
   - Priority Changed
4. Acción:
   - **Notify active webhook** (elige el webhook creado).
   - Body JSON sugerido:

```json
{
  "ticket_id": "{{ticket.id}}",
  "status": "{{ticket.status}}",
  "priority": "{{ticket.priority}}",
  "assignee_id": "{{ticket.assignee.id}}",
  "updated_at": "{{ticket.updated_at}}",
  "event_source": "zendesk_trigger"
}
```

5. Guardar y activar trigger.

### 7.4 Validar recepción

Con servidor corriendo:

- Revisar salud:
  - `GET /api/health`
- Simular webhook local:

```bash
curl -i -X POST http://localhost:3000/api/zendesk/webhook \
  -H "content-type: application/json" \
  -d '{"ticket_id":123,"status":"open"}'
```

Si hay secret configurado, la firma debe ser válida (si no, responderá 401).

---

## 8) Endpoints del servicio

- `GET /` → dashboard.
- `GET /api/metrics` → snapshot actual de KPIs.
- `GET /api/stream` → stream SSE de updates.
- `POST /api/zendesk/webhook` → ingestión de eventos Zendesk.
- `GET /api/health` → estado operativo.

---

## 9) Buenas prácticas para no romper rate limits

1. No bajar `REFRESH_INTERVAL_MS` por debajo de 60000 al inicio.
2. Mantener `MAX_CONCURRENT_ZENDESK_CALLS` entre 4 y 8.
3. Mantener `MAX_TICKETS_FOR_AVG` moderado (50-150) según volumen.
4. Dejar activos retries con backoff para 429/5xx.
5. Priorizar webhooks para inmediatez y reconciliación periódica para consistencia.

---

## 10) Troubleshooting

- **Veo ceros o mock**: faltan credenciales Zendesk en `.env`.
- **Webhook 401**: secret/firma no coincide.
- **No entra webhook desde Zendesk**: URL pública inválida o túnel caído.
- **Actualización lenta**: revisar `REFRESH_INTERVAL_MS`, estado webhook y `/api/health`.

---

## 11) Roadmap sugerido

- Persistencia de estado en SQLite/Redis.
- Métricas por analista (tabla + top 5).
- Alertas por tickets en riesgo.
- SLA real por policy/priority/group.
- Dashboard TV mode (auto full-screen + tema).
4. FRT promedio (first reply time) de tickets resueltos hoy.
5. Tiempo promedio de resolución de tickets resueltos hoy.
6. Cumplimiento de SLA (% de tickets resueltos dentro de un umbral de minutos configurable).

> Nota: en este MVP el SLA se calcula contra `SLA_TARGET_MINUTES`. Más adelante se puede reemplazar por políticas SLA nativas por grupo/prioridad.

## Requisitos

- Node.js 18+
- Token API de Zendesk Support

## Configuración

1. Copia variables de entorno:

```bash
cp .env.example .env
```

2. Completa `.env`:

- `ZENDESK_SUBDOMAIN_URL` (ej. `https://miempresa.zendesk.com`)
- `ZENDESK_EMAIL`
- `ZENDESK_API_TOKEN`
- `REFRESH_INTERVAL_MS` (ej. `30000`)
- `SLA_TARGET_MINUTES` (ej. `480` = 8 horas)
- `MAX_TICKETS_FOR_AVG` (ej. `200`)

3. Instala dependencias y ejecuta:

```bash
npm install
npm start
```

4. Abre en navegador:

- http://localhost:3000

## API interna

- `GET /api/metrics`

Devuelve los KPIs listos para renderizar en la UI.

## Próximos pasos sugeridos

- Tabla de desempeño por analista.
- Top 5 analistas del día.
- Zona de alertas de tickets en riesgo.
- Gráficos de tendencia por hora.
- Filtro por grupo/equipo y horario laboral.
