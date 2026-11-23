# AGENTS.md

Guidance for coding agents working in this repository. Read this before changing
code. The release procedure lives in
[docs/09-release-workflow.md](./docs/09-release-workflow.md).

## What this project is

A self-hosted family photo album: one Go binary serving a React frontend, SQLite
for metadata, and **any S3-compatible bucket** for the bytes. There is no account
system — a family passphrase and an admin passphrase, plus a per-browser display
name used only as a label.

The product is deliberately narrow: no face recognition, no AI search, no mobile
app, no per-user accounts. Requests that turn it into Immich should be pushed back
rather than implemented.

## The one invariant that matters

**Photos never pass through the application server.** Browsers upload directly to
the bucket with presigned URLs, and read back through presigned URLs that expire
in minutes. Never add a server-side upload proxy, and never re-encode an original.
Thumbnails and previews are generated in the browser and stored as separate
objects; originals stay byte-identical.

Any change touching originals, object keys, or signing needs a note in the commit
about what happens on failure.

## Hard constraints on this machine

| | |
| --- | --- |
| No `go` or `pnpm` on the host | Run both through Docker; see the runbook |
| `web/node_modules` is broken | `/tmp` copy + container, do not run `pnpm` in the repo |
| `gh` lives in `~/.local/bin` | `export PATH="$HOME/.local/bin:$PATH"` |
| Port 8080 is taken | The local app runs on **8090** |
| Local instance uses real credentials | `.env` is gitignored; never commit it |

## Before you say a change works

- `gofmt -w cmd internal`, then `go vet ./...` and `go test ./...`.
- `pnpm build` (strict TypeScript: unused locals and imports fail the build) and
  `pnpm test`. **CI does not run the frontend tests** — run them yourself.
- If the change has any runtime behaviour, actually start the app and use it.
  A passing build has already hidden a total feature failure here once: the HEIC
  decoder compiled and downloaded fine, but `script-src 'self'` blocked
  `WebAssembly.instantiate` and decoding failed only in the browser.

## Invariants that are easy to break

**Schema changes are additive and idempotent.** Add an `ALTER TABLE ... ADD COLUMN`
next to the existing ones in `internal/database/database.go`, tolerate "duplicate
column name", and never rewrite or drop a column in place. The app must start
cleanly against a database created by any previous release — verify that by
running the new image against an old data volume.

**Every user-visible string is bilingual.** Backend messages live in
`internal/i18n`; frontend strings in `web/src/lib/i18n.tsx` and need both `en` and
`zh` entries. No hardcoded UI text.

**Soft delete, not hard delete.** `photos.deleted_at` and `albums.deleted_at`
gate every read path. Deleting means stamping `deleted_at`, clearing the album
cover if it pointed at that photo, and invalidating download archives that
packaged it. Permanence happens only in the trash worker, and it removes S3
objects **before** database rows so a failure never orphans an object.

**CSP is `script-src 'self' 'wasm-unsafe-eval'`.** The `wasm-unsafe-eval` is
required by the HEIC decoder. It permits WebAssembly compilation, not `eval()` of
JavaScript — do not widen it to `'unsafe-eval'`.

**Duplicates are compared by exact bytes, per album.** The browser hashes each
file in a worker and the server refuses a second copy in the same album unless the
user explicitly allows it. Never reject silently: a wrong silent skip reads as
"my photo vanished".

**Never trust the client name.** `contributor` and `deleted_by` come from
localStorage and are only labels. There is no authenticated identity behind them,
so do not use them for authorization.

## Where things live

| Path | Responsibility |
| --- | --- |
| `cmd/server` | Entry point, config, graceful shutdown |
| `internal/config` | Every environment variable and production validation |
| `internal/database` | Schema and migrations |
| `internal/httpapi` | Routes, auth, albums, collections, uploads, downloads, dedup, trash |
| `internal/i18n` | Backend message catalogue |
| `internal/storage` | Generic S3 adapter: signing, multipart, HEAD, Copy, Delete |
| `web/src/lib` | API client, i18n, hashing, decoding, identity |
| `web/src/components` | Pages and dialogs |
| `docs/05..09` | Design notes: dedup, trash, HEIC, EXIF time, release workflow |

Design notes explain the trade-offs and the approaches that were rejected. Read
the relevant one before reworking an area, so a settled decision is not reopened
by accident.

## Working style

- One concern per commit, Conventional Commits, explain **why** in the body.
- Do not commit `.env`, `*.db`, `node_modules`, or `tsbuildinfo`.
- Prefer fixing the cause over adding a workaround; the codebase is small enough
  to stay correct.
- When a verification step cannot be done (no browser, no bucket), say so
  explicitly instead of implying it passed.
