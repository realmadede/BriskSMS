import { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseUnavailableError, RedisUnavailableError } from '@brisksms/db';
import {
  CookieToSet,
  parseCookies,
  serializeCookie,
  isAllowedOrigin,
} from './cookies.js';

export type { CookieToSet };
export { parseCookies, serializeCookie, isAllowedOrigin };

export interface ApiResponse<T = unknown> {
  success: boolean;
  statusCode?: number;
  data?: T;
  meta?: Record<string, unknown>;
  cookies?: CookieToSet[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class HttpException extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpException';
  }
}

export interface RequestContext {
  userId?: string;
  organizationId?: string;
  role?: string;
  deviceId?: string;
  authType?: 'bearer' | 'cookie';
  jti?: string;
}

export interface RouteRequest {
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string>;
  pendingCookies: CookieToSet[];
  body: Record<string, unknown>;
  rawBody: string;
  rawBodyBuffer: Buffer<ArrayBufferLike>;
  context: RequestContext;
  rawReq: IncomingMessage;
}

export type RouteHandler = (req: RouteRequest) => Promise<ApiResponse | void> | ApiResponse | void;

export interface RouteDefinition {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: RouteDefinition[] = [];

  add(method: string, pathPattern: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const regexStr = pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const isProd = process.env.NODE_ENV === 'production';
    const origin = req.headers.origin;

    if (origin) {
      res.setHeader('Vary', 'Origin');
      if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else if (!isProd) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With, Idempotency-Key, X-Signature, X-Timestamp, X-Organization-Id, X-CSRF-Token, X-XSRF-Token',
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const host = req.headers.host || 'localhost:3000';
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // Prevent caching of sensitive authentication and session payloads
    if (pathname.startsWith('/v1/auth')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let matchedRoute: RouteDefinition | undefined;
    const params: Record<string, string> = {};

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (match) {
        matchedRoute = route;
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(match[index + 1] ?? '');
        });
        break;
      }
    }

    if (!matchedRoute) {
      res.writeHead(404);
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Route ${method} ${pathname} not found`,
          },
        }),
      );
      return;
    }

    let body: Record<string, unknown> = {};
    let rawBody = '';
    let rawBodyBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    if (['POST', 'PATCH', 'PUT'].includes(method)) {
      try {
        rawBodyBuffer = await readBodyBuffer(req);
        rawBody = rawBodyBuffer.toString('utf-8');
        if (rawBody.trim()) {
          body = JSON.parse(rawBody);
        }
      } catch {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            success: false,
            error: {
              code: 'INVALID_JSON',
              message: 'Malformed JSON payload in request body',
            },
          }),
        );
        return;
      }
    }

    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((val, key) => {
      query[key] = val;
    });

    const cookies = parseCookies(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
    const pendingCookies: CookieToSet[] = [];

    const routeReq: RouteRequest = {
      method,
      url: parsedUrl,
      path: pathname,
      params,
      query,
      headers: req.headers,
      cookies,
      pendingCookies,
      body,
      rawBody,
      rawBodyBuffer,
      context: {},
      rawReq: req,
    };

    try {
      const response = await matchedRoute.handler(routeReq);
      const allCookies = [
        ...pendingCookies,
        ...(response && response.cookies ? response.cookies : []),
      ];
      if (allCookies.length > 0) {
        const serialized = allCookies.map((c) => serializeCookie(c.name, c.value, c.options));
        res.setHeader('Set-Cookie', serialized);
      }

      if (response) {
        const defaultStatus = method === 'POST' && pathname.endsWith('/register') ? 201 : 200;
        const status = response.statusCode ?? defaultStatus;
        const { statusCode: _omit, cookies: _omitCookies, ...payload } = response;
        res.writeHead(status);
        res.end(
          JSON.stringify(payload, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        );
      } else {
        res.writeHead(204);
        res.end();
      }
    } catch (err: unknown) {
      if (pendingCookies.length > 0) {
        const serialized = pendingCookies.map((c) => serializeCookie(c.name, c.value, c.options));
        res.setHeader('Set-Cookie', serialized);
      }
      if (err instanceof HttpException) {
        res.writeHead(err.statusCode);
        res.end(
          JSON.stringify(
            {
              success: false,
              error: {
                code: err.code,
                message: err.message,
                details: err.details,
              },
            },
            (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
          ),
        );
      } else if (err instanceof DatabaseUnavailableError || err instanceof RedisUnavailableError) {
        res.writeHead(err.statusCode);
        res.end(
          JSON.stringify({
            success: false,
            error: {
              code: err.code,
              message: err.message,
            },
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.writeHead(500);
        res.end(
          JSON.stringify({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message,
            },
          }),
        );
      }
    }
  }
}

export function readBodyBuffer(req: IncomingMessage): Promise<Buffer<ArrayBufferLike>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

export function readBody(req: IncomingMessage): Promise<string> {
  return readBodyBuffer(req).then((buf) => buf.toString('utf-8'));
}
