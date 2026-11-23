# Security policy

This project stores private family photos, so please treat security reports as
sensitive.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:

<https://github.com/RainSunMe/family-gallery/security/advisories/new>

Please include the affected version or commit, what an attacker can do, and the
smallest reproduction you have. If you cannot use GitHub, open a public issue
containing only "I have a security report, please contact me" and no details.

What to expect:

- Acknowledgement within a few days.
- A fix, or a clear explanation of why the behaviour is intended, before any
  public write-up.
- Credit in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives fixes. This is a self-hosted single-binary app,
so upgrading is replacing the image.

## Threat model in one paragraph

The deployment is expected to sit behind an HTTPS reverse proxy. Anyone holding
the family passphrase is trusted with the whole library; the admin passphrase
additionally unlocks destructive operations and share-link management. Guest
invite links are scoped: a guest session can upload to one collection and read
back only its own submissions. Originals live in a private bucket and are only
reachable through presigned URLs that expire in minutes.

## In scope

- Authentication or session flaws: passphrase bypass, session fixation, token
  leakage, missing expiry, cross-role privilege escalation.
- Authorization flaws: reaching another collection's uploads, another album's
  photos, or admin-only routes as a non-admin; guest links escaping their scope.
- Object storage abuse: forging or extending a presigned URL, path traversal in
  object keys, overwriting or deleting another user's object.
- Injection, SSRF through user-supplied URLs, unsafe archive handling in the
  download packager, and stored XSS in the web UI.
- Denial of service that is cheap for the attacker and needs a fix in code
  (unbounded loops, unbounded memory per request), not merely "you can upload
  many files".

## Out of scope

- Misconfiguration by the operator: exposing the app over plain HTTP to the
  internet, a public bucket, a one-word passphrase, or leaving the S3 console
  open. The app refuses known-weak passphrases and mandates HTTPS in production,
  but it cannot audit your proxy.
- Anyone with the family passphrase reading family photos. That is the design.
- Missing features that are already listed under "Current limitations".
- Automated scanner output with no demonstrated impact.
- Vulnerabilities in third-party dependencies that are already fixed upstream;
  please just send the version bump as a normal PR (Dependabot is enabled).

## Hardening checklist for operators

- Terminate TLS at the proxy and bind the app to `127.0.0.1`.
- Use long, distinct `FAMILY_PASSWORD` and `ADMIN_PASSWORD` values.
- Keep the bucket private; grant only read/write on that one bucket.
- Back up both the SQLite database and the bucket, and rehearse a restore.
- Rotate `SESSION_SECRET` to invalidate every existing session.
