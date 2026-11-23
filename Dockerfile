# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Single production image: static frontend + Go API in one container.
# Build: docker build -t family-gallery:latest .
# Run:   docker run --env-file .env -p 8080:8080 -v family-gallery-data:/app/data family-gallery:latest
# ---------------------------------------------------------------------------

FROM node:26-alpine AS web
WORKDIR /src
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN rm -rf dist && pnpm build

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/server ./cmd/server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 app \
    && mkdir -p /app/data /app/web/dist \
    && chown -R app:app /app
WORKDIR /app
COPY --from=build /out/server /usr/local/bin/gallery
COPY --from=web --chown=app:app /src/dist /app/web/dist
USER app
ENV APP_ENV=production \
    APP_ADDR=:8080 \
    DATABASE_PATH=/app/data/gallery.db
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:8080/healthz" || exit 1
ENTRYPOINT ["/usr/local/bin/gallery"]
