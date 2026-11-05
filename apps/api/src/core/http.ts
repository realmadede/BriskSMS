import { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  meta?: Record<string, unknown>;
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
}

export interface RouteRequest {
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
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
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || 'localhost:3000';
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // Match route
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

    // Parse Body
    let body: Record<string, unknown> = {};
    if (['POST', 'PATCH', 'PUT'].includes(method)) {
      try {
        const rawBody = await readBody(req);
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

    // Parse Query Params
    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((val, key) => {
      query[key] = val;
    });

    const routeReq: RouteRequest = {
      method,
      url: parsedUrl,
      path: pathname,
      params,
      query,
      headers: req.headers,
      body,
      context: {},
      rawReq: req,
    };

    try {
      const response = await matchedRoute.handler(routeReq);
      if (response) {
        const status = method === 'POST' && pathname.endsWith('/register') ? 201 : 200;
        res.writeHead(status);
        res.end(JSON.stringify(response));
      } else {
        res.writeHead(204);
        res.end();
      }
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        res.writeHead(err.statusCode);
        res.end(
          JSON.stringify({
            success: false,
            error: {
              code: err.code,
              message: err.message,
              details: err.details,
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => reject(err));
  });
}
