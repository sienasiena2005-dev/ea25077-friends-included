import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
// Local preview may select a role while real services remain unconfigured.
// This secret is ephemeral, never persisted and never used by Vercel.
process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
const { default: appHandler } = await import('../api/app.js');
const { default: telegramHandler } = await import('../api/telegram.js');
const { default: workerHandler } = await import('../api/worker.js');
const port = Number(process.env.PORT || 8787);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/api/app') return await appHandler(req, res);
    if (url.pathname === '/api/telegram') return await telegramHandler(req, res);
    if (url.pathname === '/api/worker') return await workerHandler(req, res);
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filename = path.resolve(root, 'public', `.${relative}`);
    const publicRoot = path.join(root, 'public') + path.sep;
    if (!filename.startsWith(publicRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
    const contents = await fs.readFile(filename);
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(contents);
  } catch (e) { res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' }); res.end(e.code === 'ENOENT' ? 'Not found' : 'Local server request failed.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Friends Included local preview: http://127.0.0.1:${port}`));
