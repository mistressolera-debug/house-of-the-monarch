# Sanitization notes
- Source archive from the coordinator, local copy dated Nov 7 2026 08:52 America/Toronto. It is not confirmed identical to the worker that is deployed. Do not treat this tree as a live release.
- wrangler.toml: `account_id` replaced with `<CLOUDFLARE_ACCOUNT_ID_REDACTED>`. R2 binding, bucket name, vars, and cron triggers left intact. Comments for recovery mail and conditional writes were added later; no secrets were added.
- src/index.js: scanned before recovery work for API keys, webhook secrets, tokens, private keys, TOTP seeds/otpauth URIs, emails, JWTs, and long hex. None were found (only the TOTP base32 alphabet). Recovery support was added in this repository after that scan.
- package.json / package-lock.json: no secrets. package.json was marked as a module and given a test script.
- Excluded from the archive: .dev.vars, deploy.sh, set-banner.sh, README.md, src/index.js.bak-*, .gitignore. No .git or node_modules. No credentials, ID images, or real mailboxes.
- Runtime secrets (ENC_KEY, ADMIN_PW_HASH, TOTP_SECRET, SESSION_KEY, and any future mail credential) stay in Worker secrets, not in source.
