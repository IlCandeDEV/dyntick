FROM nginx/nginx-unprivileged:stable-alpine-slim@sha256:30b5b66412019e6860fb900420758f664f770082d142b614db0d9afadfede1d3
USER 0
RUN apk add --no-cache --upgrade 'zlib>=1.4-r0'

LABEL org.opencontainers.image.title="Dyntick" \
      org.opencontainers.image.source="https://github.com/IlCandeDEV/dyntick" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.description="Your personal study space, one thing at a time."

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
