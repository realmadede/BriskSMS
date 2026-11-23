# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2-alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/config/package.json ./packages/config/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/parser-engine/package.json ./packages/parser-engine/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/zapier-app/package.json ./packages/zapier-app/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/web ./apps/web

RUN bun run build

FROM base AS api
ENV NODE_ENV=production
ENV PORT=3000
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "apps/api/src/main.ts"]

FROM base AS worker
ENV NODE_ENV=production
USER bun
CMD ["bun", "run", "apps/worker/src/main.ts"]

FROM base AS web
ENV NODE_ENV=production
ENV WEB_PORT=4200
USER bun
EXPOSE 4200
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEB_PORT || 4200) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "apps/web/server.ts"]
