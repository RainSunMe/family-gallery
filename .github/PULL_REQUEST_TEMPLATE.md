## What and why

<!-- What changes, and which problem does it solve? Link the issue if there is one. -->

## How

<!-- A short note on the approach. Call out anything touching originals, signed URLs,
     schema migrations or user-visible strings. -->

## Verification

<!-- Commands you ran, and what you observed. -->

```bash
go vet ./... && go test ./...
cd web && pnpm build
```

## Checklist

- [ ] Scope is limited to one concern
- [ ] `gofmt` clean; `go vet` and `go test` pass
- [ ] Frontend type-checks (`pnpm build`)
- [ ] Schema change is an idempotent migration, tested against an older database
- [ ] New user-visible strings exist in both `en` and `zh`
- [ ] No secrets, `.env` files or personal photos added
- [ ] README updated if behaviour or configuration changed
