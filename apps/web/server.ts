/// <reference types="node" />
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4200;
const SRC_DIR = existsSync(join(process.cwd(), 'apps/web/src'))
  ? join(process.cwd(), 'apps/web/src')
  : join(process.cwd(), 'src');

const HTML_PATH = join(SRC_DIR, 'index.html');
const DEVELOPERS_PATH = join(SRC_DIR, 'developers.html');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // Root / Main landing page
  if (path === '/' || path === '/index.html') {
    if (existsSync(HTML_PATH)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(readFileSync(HTML_PATH, 'utf-8'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404: Not Found');
    return;
  }

  // Dedicated /developers route
  if (path === '/developers' || path === '/developers.html') {
    if (existsSync(DEVELOPERS_PATH)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(readFileSync(DEVELOPERS_PATH, 'utf-8'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404: Developers Page Not Found');
    return;
  }

  // Favicon shortcuts
  if (path === '/favicon.ico' || path === '/favicon.svg') {
    const favPath = join(SRC_DIR, 'assets', 'brand', 'favicon.svg');
    if (existsSync(favPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(readFileSync(favPath));
      return;
    }
  }

  // Static assets
  if (path.startsWith('/assets/')) {
    const filePath = join(SRC_DIR, path);
    if (existsSync(filePath)) {
      const ext = path.substring(path.lastIndexOf('.'));
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(readFileSync(filePath));
      return;
    }
  }

  // Health check endpoint
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'brisksms-web' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BriskSMS Web] Server running at http://localhost:${PORT}`);
});
