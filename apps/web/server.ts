import { serve } from 'bun';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4200;
const SRC_DIR = join(import.meta.dir, 'src');
const HTML_PATH = join(SRC_DIR, 'index.html');
const DEVELOPERS_PATH = join(SRC_DIR, 'developers.html');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Root / Main landing page
    if (path === '/' || path === '/index.html') {
      if (existsSync(HTML_PATH)) {
        return new Response(readFileSync(HTML_PATH, 'utf-8'), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      return new Response('404: Not Found', { status: 404 });
    }

    // Dedicated /developers route
    if (path === '/developers' || path === '/developers.html') {
      if (existsSync(DEVELOPERS_PATH)) {
        return new Response(readFileSync(DEVELOPERS_PATH, 'utf-8'), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      return new Response('404: Developers Page Not Found', { status: 404 });
    }

    // Favicon shortcuts
    if (path === '/favicon.ico' || path === '/favicon.svg') {
      const favPath = join(SRC_DIR, 'assets', 'brand', 'favicon.svg');
      if (existsSync(favPath)) {
        return new Response(readFileSync(favPath), {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
        });
      }
    }

    // Static assets
    if (path.startsWith('/assets/')) {
      const filePath = join(SRC_DIR, path);
      if (existsSync(filePath)) {
        const ext = path.substring(path.lastIndexOf('.'));
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        return new Response(readFileSync(filePath), {
          headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
        });
      }
    }

    // Health check endpoint
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'brisksms-web' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[BriskSMS Web] Server running at http://localhost:${server.port}`);
