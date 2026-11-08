# Patron recovery

Court-key recovery is part of the existing patron accounts (`patrons/acct`, handle index, patron sessions). It does not create an account, copy an application email, change `source`, approve an ID, or touch admin TOTP.

This tree started from a local worker dated Nov 7 2026 08:52 America/Toronto. It is not confirmed identical to the deployed worker. Diff it against the live script before any release. This repository does not deploy.

## What is implemented

- `POST /patron/recovery/email` requires a live patron session and the current court key. A cross-origin browser request is rejected by the existing origin check. Issuing a link bumps `recoveryGen`, so an older link, including one already loaded into memory, cannot confirm after a newer enrollment or a key reset.
- `POST /patron/recovery/email/confirm` sets `verifiedEmail` only from the token. A body field cannot choose a different address. Sessions and the court key stay as they are.
- `POST /patron/recovery/request` accepts a handle only. The message goes to `verifiedEmail` on that account. Unknown handles, accounts with no verified email, and a missing mail binding all return the same `{"ok":true}` and send nothing.
- `POST /patron/recovery/complete` sets a new court key with the existing PBKDF2 normalizer (at least 20 letters or numbers). The account write is conditional and succeeds only when `recoveryGen` still matches the token. It bumps `recoveryGen` and `sessionGen`. Sessions are stamped with `sessionGen` at creation and rejected when the account has moved on, including a session created after the reset's delete list. Admin password, TOTP, application status, and Vault membership are unchanged.
- Tokens are 32 random bytes. Only the SHA-256 hash is stored. Lifetime is 15 minutes. A token is valid only while `now < expiresAt`.
- Single-use is an R2 `put` with `If-None-Match: *` on `patrons/recovery-used/<hash>`. Cloudflare's R2 consistency document (updated Oct 14, 2026) says that header is evaluated atomically with the write, and concurrent `If-None-Match: *` puts on one key have a single winner. The password and email updates use `If-Match` on the patron object and re-check `recoveryGen` inside that write. A read followed by a delete is not the claim. Recovery rate limits use the same conditional put. The older login and application counters remain read-modify-write and are not treated as atomic.
- `GET` and `HEAD` under `/patron/recovery` return 405 and do not claim a token. Links use a URL fragment on the site origin, so a prefetch of the page does not send the token to the worker.
- The link origin is `CANONICAL_ORIGIN` if set, otherwise `ALLOWED_ORIGIN`. The value must be a bare `https` origin. `Host`, `X-Forwarded-Host`, and redirect fields are not read.

## Mail is not live

The runtime sender is `src/smtp-mail.js`. It connects with Workers `connect()` to `smtp.gmail.com` port 465 and `secureTransport: "on"` (implicit TLS). Port 25 is not used. `AUTH PLAIN` is written only on that TLS socket. The AUTH user and From address are fixed to `sj@monarchofthemoon.shop`. The recipient is the verified patron address passed by the recovery code. A test double `env.MAIL.send` still replaces the socket in unit tests. Those tests do not deliver mail.

The adapter stays closed until `SMTP_APP_PASSWORD` is a 16-letter Google app password. That value is not in the repo. `SMTP_USER`, if set, must be exactly `sj@monarchofthemoon.shop`. The SMTP host is not configurable. See `DEPLOY.md` for the mailbox owner's steps and the release order.

The site and the worker have to be released together. The page posts to `/patron/recovery/*`. Until both are current, the form cannot finish a reset. Releasing either one is a separate decision from this branch.

## Storage

Existing R2 bucket `hotm-id-uploads`, binding `BUCKET`. New keys:

- `patrons/recovery/<sha256>` token record
- `patrons/recovery-idx/<accountId>/<sha256>`
- `patrons/recovery-used/<sha256>` claim marker
- `verifiedEmail`, `emailVerifiedAt`, and `recoveryGen` on the patron JSON. `sessionGen` is added when a court key changes. Sessions store the generation they were issued with.

No new bucket, Durable Object, or paid plan is required. Conditional puts have been in the R2 Workers API since 2022. Before release, confirm a conflicting `If-None-Match: *` put returns `null` on the account that hosts this bucket.

Expired token objects are removed by the existing daily cron. Patron accounts, ID files, Vault objects, and sessions are not deleted by that sweep.

## Runtime check of the R2 binding

Miniflare 4.20260730.0 (local workerd, no production bucket) accepted the same `onlyIf` headers the worker uses:

- two concurrent `If-None-Match: *` puts of one key: 1 winner
- two concurrent `If-None-Match: *` puts of different keys: both succeed
- two concurrent `If-Match` puts of one etag: 1 winner

The patron enrollment and reset races were exercised through the worker's fetch handler against an in-memory bucket that implements those same conditional rules, including a bucket whose reads return stale values. That suite is not itself running inside workerd.

## Release check

1. Diff `src/index.js` and `src/recovery.js` against the deployed worker. Stop if the deployed script has moved on.
2. Confirm `ALLOWED_ORIGIN` is `https://houseofthemonarch.com` with no path.
3. Confirm R2 conditional puts return `null` when the condition fails.
4. Add `MAIL` only when a provider is chosen. Until then, leave it unset and expect no delivery.
5. Do not put mail credentials, TOTP seeds, or `ENC_KEY` in git.
6. Deploy is out of scope for this change.
