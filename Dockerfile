# Vazhe: a single Node server. Everything it saves lives in /data.
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY lexicon ./lexicon

# Runs as the unprivileged "node" user; a new volume at /data starts out owned by it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "src/server.js"]
