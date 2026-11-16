/// <reference types="node" />
import { createServer } from 'node:http';
import { closeDbPool, closeRedisClient } from '@brisksms/db';
import { createApp } from './app.js';
import { validateProductionEncryptionConfig } from './core/crypto.js';

// Enforce fail-closed production encryption and JWT configuration on boot
validateProductionEncryptionConfig();

const PORT = parseInt(process.env.PORT || '3000', 10);
const router = createApp();

const server = createServer((req, res) => {
  router.handle(req, res).catch((err) => {
    console.error('[API Unhandled Error]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Unhandled server error' } }));
    }
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, () => {
  console.log(`[BriskSMS API] Modular Backend listening on port ${PORT}`);
  console.log(`[BriskSMS API] Health Endpoint: http://localhost:${PORT}/v1/health`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[BriskSMS API] Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    try {
      await Promise.allSettled([closeDbPool(), closeRedisClient()]);
    } catch {
      // Ignore shutdown cleanup errors
    }
    console.log('[BriskSMS API] HTTP server and connections closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
