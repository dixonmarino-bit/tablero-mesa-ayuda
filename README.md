# Tablero Mesa de Ayuda (MVP local)

Este proyecto crea un tablero local inspirado en tu imagen, empezando por la **franja superior de KPIs críticos** conectada con Zendesk en tiempo casi real.

## Métricas incluidas (MVP)

1. Tickets recibidos hoy.
2. Tickets resueltos hoy.
3. Tickets pendientes.
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
