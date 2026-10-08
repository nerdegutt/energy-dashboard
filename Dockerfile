# energy.offline.no: Node-server (server.mjs) med statisk frontend (public/) og JSON-API mot Postgres (erlend-postgres).
FROM node:22.23.3-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.3-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY db/postgres.sql ./db/postgres.sql
COPY public/ ./public/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
