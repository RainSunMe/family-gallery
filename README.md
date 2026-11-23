# Family Gallery · Self-hosted Family Photo Sharing

[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![License](https://img.shields.io/badge/License-MIT-black.svg)](./LICENSE)

**A private family photo album you host yourself.** Built with Go, SQLite and any S3-compatible object storage.
Photos never pass through the application server: browsers upload directly to your own bucket, and the backend only issues short-lived signed URLs.

The whole interface is bilingual (English and Simplified Chinese). `DEFAULT_LANGUAGE` decides which one a visitor sees first; after signing in, the language can be changed in the settings dialog, and `?lang=zh` / `?lang=en` overrides it for a single visit.

> Keywords: self-hosted photo album · family photo sharing · photo collection · S3 · Garage · MinIO · Go · SQLite · React

> 中文说明见 [README.zh-CN.md](./README.zh-CN.md).

## Why use it

| | |
| --- | --- |
| **Private storage** | Photos stay in your own bucket. The browser uploads and reads directly, so the app never relays a single byte. |
| **Photo requests** | One invite link lets family and friends upload without signing up, and each guest only sees their own submissions. |
| **Read-only sharing** | Album links and QR codes with an expiry you control, and a stop button for any moment. |
| **Cloud packaging** | The server builds bounded ZIP archives that can be downloaded in parts and are cleaned up after they expire. |
| **Small footprint** | A single container image ships the frontend and the API; one data volume is enough to run it. |
| **No account system** | Family and admin passphrases are separate, and sessions are stored as hashes. |

## Quick start

```bash
git clone https://github.com/RainSunMe/family-gallery.git
cd family-gallery
cp .env.example .env      # replace every REPLACE_WITH_* placeholder
docker compose up -d --build
```

Then open `http://localhost:8080` and sign in with the family passphrase from `.env`.

> The image already contains the built frontend, so **do not** mount `web/dist` — it would shadow the image contents.
> In production, put the app behind an HTTPS reverse proxy and only expose its port.

### Without Compose

```bash
docker build -t family-gallery .
docker run -d --name gallery --env-file .env \
  -p 127.0.0.1:8080:8080 -v gallery-data:/app/data \
  family-gallery
```

## Configuration

Everything is configured through environment variables. `APP_ENV` already defaults to `production`, which enforces passphrase strength and HTTPS.

### Required

| Variable | Description |
| --- | --- |
| `FAMILY_PASSWORD` | Family passphrase. `family` is rejected. |
| `ADMIN_PASSWORD` | Admin passphrase. Must differ from the family one; `admin` is rejected. |
| `SESSION_SECRET` | Random session key of at least 32 characters. |
| `S3_ENDPOINT` | Object storage endpoint used by the backend. |
| `S3_BUCKET` | Name of the private bucket. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | S3 credentials dedicated to this app. |

### Branding and appearance

The name, tagline and description shown in the UI can be changed without rebuilding the frontend:

| Variable | Default | Description |
| --- | --- | --- |
| `SITE_NAME` | `Family Gallery` | Shown in the sidebar, on the login page and in settings. |
| `SITE_TAGLINE` | `PRIVATE FAMILY PHOTOS` | Small caption under the name. |
| `SITE_DESCRIPTION` | `A self-hosted family photo album` | Shown at the bottom of the settings dialog. |

For a custom brand, just set the values in `.env`:

```dotenv
SITE_NAME=Orange Light
SITE_TAGLINE=ORANGE LIGHT FAMILY PHOTOS
SITE_DESCRIPTION=Our family album
```

### Language

| Variable | Default | Description |
| --- | --- | --- |
| `DEFAULT_LANGUAGE` | `en` | Language used when a visitor has no preference. Supported values: `en`, `zh`. |

API error messages follow the request language: the `lang` query parameter wins, then the `Accept-Language` header, then `DEFAULT_LANGUAGE`. The login page always uses `DEFAULT_LANGUAGE`, so there is no language switcher on the entry screen; after signing in, the language can be changed in the settings dialog (the choice is remembered in that browser), and `?lang=zh` / `?lang=en` overrides it for a single visit.

Note: a language picked in the settings dialog is stored per browser and always wins over `DEFAULT_LANGUAGE`.

### Runtime and access

| Variable | Default | Description |
| --- | --- | --- |
| `APP_ENV` | `production` | Set to `development` to disable production validation. |
| `APP_ADDR` | `:8080` | Listen address. |
| `APP_PUBLIC_URL` | `http://localhost:8080` | Public URL. Must be HTTPS in production. |
| `DATABASE_PATH` | `./data/gallery.db` | SQLite path. Inside the image it is `/app/data/gallery.db`. |
| `S3_PUBLIC_ENDPOINT` | falls back to `S3_ENDPOINT` | Browser-reachable S3 endpoint. Must be HTTPS in production. |
| `S3_REGION` | `garage` | Must match the object storage configuration. |
| `S3_USE_PATH_STYLE` | `true` | Required by most self-hosted S3 services. |
| `APP_ENV_FILE` | empty | Optional extra environment file. |

### Sessions and signatures

| Variable | Default |
| --- | --- |
| `FAMILY_SESSION_TTL` | `720h` |
| `ADMIN_SESSION_TTL` | `12h` |
| `SIGNED_READ_TTL` | `5m` |
| `SIGNED_UPLOAD_TTL` | `15m` |
| `COLLECTION_SESSION_TTL` | `168h` |

### Uploads, downloads and throttling

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_UPLOAD_SIZE` | `209715200` | Per-file limit in bytes (200 MiB). |
| `MULTIPART_PART_SIZE` | `8388608` | Part size; S3 requires at least 5 MiB. |
| `DOWNLOAD_PART_SIZE` | `524288000` | Maximum size of one ZIP part (500 MiB). |
| `DOWNLOAD_RETENTION` | `24h` | How long download packages are kept. |
| `WORKER_INTERVAL` | `2s` | Poll interval of the packaging worker. |
| `LOGIN_MAX_ATTEMPTS` | `10` | Failed attempts before a block. |
| `LOGIN_BLOCK_DURATION` | `5m` | Block duration after too many failures. |

## Object storage requirements

Any S3-compatible service works: **Garage, MinIO, SeaweedFS, Ceph RGW, AWS S3**, and others.

1. The bucket must be **private**; access only happens through short-lived presigned URLs.
2. Allow cross-origin `GET`, `PUT` and `HEAD` from the browser, and expose `ETag` (required for multipart uploads).
3. The host in `S3_PUBLIC_ENDPOINT` must match the one used for signing — you cannot sign against an internal address and then swap in the public domain.

After deploying, call this once as an admin to write an exact-origin CORS rule:

```bash
curl -X PUT https://photos.example.com/api/v1/storage/cors \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://photos.example.com' \
  --cookie 'cg_session=<admin session>' \
  -d '{}'
```

## Architecture

```text
browser ── sign-in / metadata / signing ──> Go API ── SQLite (albums, requests, shares, jobs)
browser ── presigned PUT / GET ───────────> private S3 (originals / previews / thumbnails)
Go packaging worker ── GET / PUT ─────────> private S3 (ZIP parts)
```

| Path | Responsibility |
| --- | --- |
| `cmd/server` | Entry point, configuration loading, graceful shutdown |
| `internal/config` | All environment variables and production validation |
| `internal/database` | SQLite schema and migrations |
| `internal/httpapi` | Routing, auth, albums, requests, shares, downloads |
| `internal/i18n` | Message catalog and locale negotiation |
| `internal/storage` | Generic S3 adapter: signing, multipart, HEAD, Copy |
| `web/` | React + Vite + Tailwind frontend, served directly by Go |

## Development and tests

```bash
# Go: format, static analysis, unit tests
docker run --rm -v "$PWD":/src -w /src golang:1.25-alpine \
  sh -c 'gofmt -w cmd internal && go vet ./... && go test ./...'

# Frontend: type-check and production build
docker run --rm -e CI=true -v "$PWD/web":/src -w /src node:22-alpine \
  sh -c 'corepack enable && corepack prepare pnpm@10.28.2 --activate && pnpm install --frozen-lockfile && pnpm build'
```

For local development, run a single-node Garage (or any S3-compatible service), set `APP_ENV=development`, and use plain HTTP.

## Current limitations

- JPEG, PNG, WebP and GIF are fully supported in the browser; HEIC/HEIF and video have no preview or transcoding pipeline yet.
- The delete and trash UI is not exposed yet.
- Packaging runs inside the API process with a single worker loop. At larger scale, split it into a separate worker with durable leases.
- Both SQLite and the object store need their own backups, and restores should be rehearsed regularly.

## License

[MIT](./LICENSE). Inter, Noto Sans SC and Fraunces under `web/public/fonts` are distributed under the SIL Open Font License, which ships alongside the fonts.
