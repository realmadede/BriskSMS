/// <reference types="node" />
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const PORT = 4200;
const SRC_DIR = existsSync(join(process.cwd(), 'apps/web/src'))
  ? join(process.cwd(), 'apps/web/src')
  : join(process.cwd(), 'src');
const ASSETS_DIR = resolve(SRC_DIR, 'assets');

const HTML_PATH = join(SRC_DIR, 'index.html');
const DEVELOPERS_PATH = join(SRC_DIR, 'developers.html');
const CONSOLE_PATH = join(SRC_DIR, 'console.html');

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function writeSecureHead(
  res: ServerResponse,
  statusCode: number,
  headers: Record<string, string>
): void {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
}

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

export function handleWebRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    writeSecureHead(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400: Bad Request');
    return;
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // Root / Main landing page
  if (path === '/' || path === '/index.html') {
    if (existsSync(HTML_PATH)) {
      writeSecureHead(res, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(readFileSync(HTML_PATH, 'utf-8'));
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Not Found');
    return;
  }

  // Dedicated /developers and /developer route
  if (path === '/developers' || path === '/developers.html' || path === '/developer' || path === '/developer.html') {
    if (existsSync(DEVELOPERS_PATH)) {
      writeSecureHead(res, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(readFileSync(DEVELOPERS_PATH, 'utf-8'));
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Developers Page Not Found');
    return;
  }

  // Dedicated /console, /merchant-console, /app, /dashboard, and /verify-email merchant routes
  if (
    path === '/console' ||
    path === '/console.html' ||
    path === '/merchant-console' ||
    path === '/merchant-console.html' ||
    path === '/app' ||
    path === '/dashboard' ||
    path === '/verify-email' ||
    path === '/verify-email.html'
  ) {
    if (existsSync(CONSOLE_PATH)) {
      writeSecureHead(res, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(readFileSync(CONSOLE_PATH, 'utf-8'));
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Merchant Console Page Not Found');
    return;
  }

  // Favicon shortcuts
  if (path === '/favicon.ico' || path === '/favicon.svg') {
    const favPath = join(SRC_DIR, 'assets', 'brand', 'favicon.svg');
    if (existsSync(favPath)) {
      writeSecureHead(res, 200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(readFileSync(favPath));
      return;
    }
  }

  // Static assets (canonicalized against ASSETS_DIR to prevent path traversal)
  if (path.startsWith('/assets/')) {
    const relativeAsset = path.replace(/^\/+/, '');
    const filePath = resolve(SRC_DIR, relativeAsset);
    if (!filePath.startsWith(ASSETS_DIR + sep)) {
      writeSecureHead(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403: Forbidden');
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      writeSecureHead(res, 200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(readFileSync(filePath));
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Asset Not Found');
    return;
  }

  // Health check endpoint
  if (path === '/health') {
    writeSecureHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: 'brisksms-web' }));
    return;
  }

  writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

export function createWebServer(): Server {
  return createServer(handleWebRequest);
}

const isDirectEntry = (import.meta as { main?: boolean }).main === true;
if (isDirectEntry) {
  const server = createWebServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[BriskSMS Web] Server running at http://localhost:${PORT}`);
  });
}
