# Hola Mundo + ngrok (mínimo)

Este repo fue simplificado a un ejemplo mínimo para validar que el túnel de ngrok funciona.

## Requisitos

- Node.js 18+
- ngrok instalado y autenticado

## Ejecutar local

```bash
npm run check
npm start
```

Abre: `http://localhost:3000`

## Probar con ngrok

En otra terminal:

```bash
ngrok http 3000
```

Usa la URL HTTPS que te da ngrok y abre el enlace.

> Si sale la pantalla de advertencia de ngrok free, haz clic en **Visit Site**.

## Endpoint de salud

- `GET /health`
