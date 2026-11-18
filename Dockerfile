# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
USER 0
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile
COPY index.html vite.config.ts ./
COPY scripts/build.ts ./scripts/build.ts
COPY public ./public
COPY src ./src
COPY server ./server
RUN bun run build

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS runtime
USER 0
RUN mkdir -p /app/site /data && chown -R 1000:1000 /app /data
WORKDIR /app

LABEL org.opencontainers.image.title="Dyntick" \
      org.opencontainers.image.source="https://github.com/IlCandeDEV/dyntick" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.description="Your personal study space, one thing at a time."

COPY --from=build --chown=1000:1000 /app/dist/ /app/site/
COPY --from=build --chown=1000:1000 /app/build/server.js /app/server.js
COPY --chown=1000:1000 LICENSE /app/site/LICENSE.txt
ENV DATABASE_PATH=/data/dyntick.sqlite STATIC_DIRECTORY=/app/site PORT=8080
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'if (!(await fetch("http://127.0.0.1:8080/healthz")).ok) process.exit(1)'
ENTRYPOINT ["bun", "--no-install", "/app/server.js"]
