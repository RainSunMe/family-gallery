# Contributing

Thanks for taking a look. This is a small, deliberately narrow project: a private
family album, not a general-purpose photo platform. Bug reports and focused
patches are welcome.

## Before you open a PR

- For anything larger than a typo or a one-line fix, open an issue first. It is
  much cheaper to agree on the approach than to rework a patch.
- Please keep the scope of a PR to one concern. Unrelated refactors mixed with a
  fix are hard to review.

## Local development

You do not need Go or Node installed locally — both toolchains are available
through Docker, which is also how CI runs them.

```bash
# Go: format, static analysis, unit tests
docker run --rm -v "$PWD":/src -w /src golang:1.27-alpine \
  sh -c 'gofmt -w cmd internal && go vet ./... && go test ./...'

# Frontend: type-check and production build
docker run --rm -e CI=true -v "$PWD/web":/src -w /src node:22-alpine \
  sh -c 'corepack enable && corepack prepare pnpm@10.28.2 --activate && pnpm install --frozen-lockfile && pnpm build'
```

To actually run the app you also need an S3-compatible bucket. Single-node
Garage or MinIO is enough. Set `APP_ENV=development` so the app accepts plain
HTTP and relaxed passphrases.

```bash
cp .env.example .env    # fill in S3 and passwords
APP_ENV=development docker compose up -d --build
```

After the first start, write the storage CORS rule once, as an admin:

```bash
curl -X PUT http://localhost:8080/api/v1/storage/cors \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
  --cookie 'cg_session=<admin session>' -d '{}'
```

## Guidelines

- **Formatting.** Go code must be `gofmt`-clean; CI fails otherwise. Frontend
  code is TypeScript with `strict` and `noUnusedLocals` on — no `any` escapes,
  no unused imports.
- **Schema changes.** Add an idempotent migration in `internal/database/database.go`
  next to the existing `ALTER TABLE` statements. The app must start cleanly
  against a database created by an older release. Never rewrite or drop a column
  in place.
- **New strings.** Every user-visible string goes through `internal/i18n` (backend)
  or `web/src/lib/i18n.tsx` (frontend), and needs both `en` and `zh` entries.
- **Photos are the payload.** Anything that touches originals, keys or signed
  URLs needs a note in the PR explaining what happens on failure, and must never
  modify or re-encode an original.
- **Commits.** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
- **Secrets.** Never commit a real `.env`, database file or bucket credential.

## Reporting security issues

Do not open a public issue — see [SECURITY.md](./SECURITY.md).
