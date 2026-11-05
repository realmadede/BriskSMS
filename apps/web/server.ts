import { serve } from 'bun';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4200;
const HTML_PATH = join(import.meta.dir, 'src', 'index.html');

const server = serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      if (existsSync(HTML_PATH)) {
        const content = readFileSync(HTML_PATH, 'utf-8');
        return new Response(content, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      return new Response('404: Not Found', { status: 404 });
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
