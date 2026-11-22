/** Tiny static server for the bundled demo site (an X-like infinite feed for offline testing). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from './util.js';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function startDemoServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.join(PKG_ROOT, 'demo-site');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://localhost');
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/home.html';
    if (/^\/[\w-]+\/status\/\d+$/.test(p)) p = '/status.html';
    const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e: any) => {
      if (e.code === 'EADDRINUSE' && port !== 0) startDemoServer(0).then(resolve, reject);
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
