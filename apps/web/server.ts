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
const GETTING_STARTED_PATH = join(SRC_DIR, 'getting-started.html');
const CONSOLE_PATH = join(SRC_DIR, 'console.html');
const NEXUS_PATH = join(SRC_DIR, 'nexus.html');
const LEGAL_PAGES: Record<string, string> = {
  '/privacy': join(SRC_DIR, 'privacy.html'),
  '/privacy.html': join(SRC_DIR, 'privacy.html'),
  '/terms': join(SRC_DIR, 'terms.html'),
  '/terms.html': join(SRC_DIR, 'terms.html'),
};
const HEADER_PARTIAL_PATH = join(SRC_DIR, 'partials', 'header.html');
const HEADER_MARKER = '<!-- @header -->';

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

// The public pages share one header (partials/header.html), stitched in at their marker.
function sendPublicPage(res: ServerResponse, pagePath: string): void {
  if (!existsSync(HEADER_PARTIAL_PATH)) {
    writeSecureHead(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500: Site header partial missing');
    return;
  }
  const header = readFileSync(HEADER_PARTIAL_PATH, 'utf-8');
  writeSecureHead(res, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(readFileSync(pagePath, 'utf-8').replace(HEADER_MARKER, () => header));
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
  // Pages link their CSS/JS relatively (so static previews work too), which only resolves from
  // the slash-less URL: send /developers/ to /developers. Leading slashes are collapsed so the
  // Location can never become protocol-relative (//other-host).
  if (path.length > 1 && path.endsWith('/')) {
    const target = '/' + url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    writeSecureHead(res, 301, { Location: target + url.search });
    res.end();
    return;
  }

  // Root / Main landing page
  if (path === '/' || path === '/index.html') {
    if (existsSync(HTML_PATH)) {
      sendPublicPage(res, HTML_PATH);
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Not Found');
    return;
  }

  // Dedicated /developers and /developer route
  if (path === '/developers' || path === '/developers.html' || path === '/developer' || path === '/developer.html') {
    if (existsSync(DEVELOPERS_PATH)) {
      sendPublicPage(res, DEVELOPERS_PATH);
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Developers Page Not Found');
    return;
  }

  // Setup guide
  if (path === '/getting-started' || path === '/getting-started.html') {
    if (existsSync(GETTING_STARTED_PATH)) {
      sendPublicPage(res, GETTING_STARTED_PATH);
      return;
    }
    writeSecureHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: Not Found');
    return;
  }

  // Privacy Policy and Terms of Service
  const legalPage = LEGAL_PAGES[path];
  if (legalPage && existsSync(legalPage)) {
    sendPublicPage(res, legalPage);
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

  // Platform admin. Reached only by typing /nexus: no page, menu, sitemap or redirect points here.
  if (path === '/nexus') {
    if (existsSync(NEXUS_PATH)) {
      writeSecureHead(res, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      });
      res.end(readFileSync(NEXUS_PATH, 'utf-8'));
      return;
    }
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
      // Page CSS/JS must always match the uncached page HTML, so browsers re-check them on
      // every load; images and fonts can be cached for an hour.
      const cacheControl = ext === '.css' || ext === '.js' ? 'no-cache' : 'public, max-age=3600';
      writeSecureHead(res, 200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
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
