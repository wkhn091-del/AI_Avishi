// A stand-in for a generated project's dev server in tests (see fake-docker.mjs): it serves the folder it runs in
// (index.html at "/"), echoes requests to /__echo, answers a WebSocket upgrade and echoes its bytes. It listens on a
// free port and writes it to <FAKE_DEV_DIR>/.stash/port-<the port it was asked for>, for the fake relay.
// FAKE_DEV_FAIL makes it exit at once, like a dev server that can't start.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

if (process.env.FAKE_DEV_FAIL) {
  console.error('Error: Cannot find module vite');
  process.exit(1);
}
const root = process.cwd();
const requested = Number(process.env.FAKE_DEV_PORT || 0);
// JSX is served as text, so a browser doesn't run it: a dev server would compile it first.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake');
  if (url.pathname === '/__echo') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, host: req.headers.host, body }));
    });
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  // As a helmet-protected app would: the preview proxy keeps its policy but lets Stash frame it.
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'text/plain', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
  res.end(readFileSync(file));
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.pipe(socket);
});
const listen = (attempt = 0) => {
  server.once('error', () => (attempt < 20 ? listen(attempt + 1) : process.exit(1)));
  server.listen(20_000 + Math.floor(Math.random() * 30_000), '127.0.0.1', () => {
    const dir = path.join(process.env.FAKE_DEV_DIR ?? root, '.stash');
    mkdirSync(dir, { recursive: true });
    if (requested) writeFileSync(path.join(dir, `port-${requested}`), String(server.address().port));
    console.log(`fake dev server ready on ${server.address().port}`);
  });
};
listen();
