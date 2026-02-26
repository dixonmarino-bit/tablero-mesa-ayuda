const http = require('node:http');

const port = Number(process.env.PORT || 3000);

const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hola Mundo</title>
    <style>
      body { font-family: Arial, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #111; color: #fff; }
      .card { padding: 24px; border: 1px solid #444; border-radius: 12px; text-align: center; }
      h1 { margin: 0 0 8px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Hola Mundo 👋</h1>
      <p>Servidor funcionando correctamente en Node.js.</p>
    </div>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', port }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, () => {
  console.log(`Hola Mundo en http://localhost:${port}`);
});
