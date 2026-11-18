FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
USER 0
RUN apk add --no-cache --upgrade 'zlib>=1.4-r0'
RUN mkdir -p /app/site /data && chown -R 1000:1000 /app /data
WORKDIR /app

LABEL org.opencontainers.image.title="Dyntick" \
      org.opencontainers.image.source="https://github.com/IlCandeDEV/dyntick" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.description="Your personal study space, one thing at a time."

COPY --chown=1000:1000 site/ /app/site/
COPY --chown=1000:1000 server.js /app/server.js
ENV DATABASE_PATH=/data/dyntick.sqlite STATIC_DIRECTORY=/app/site PORT=8080
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'if (!(await fetch("http://127.0.0.1:8080/healthz")).ok) process.exit(1)'
ENTRYPOINT ["bun", "--no-install", "/app/server.js"]
