import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Ambient declaration for Bun HTTP server
declare const Bun: {
  serve: (options: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }) => { port: number };
} | undefined;

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
  '.json': 'application/json; charset=utf-8',
};

if (typeof Bun === 'undefined') {
  throw new Error('This development server requires Bun runtime (bun apps/web/server.ts)');
}

const server = Bun.serve({
  port: PORT,
  fetch(req: Request): Response | Promise<Response> {
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
