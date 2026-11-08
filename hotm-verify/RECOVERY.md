# Patron recovery

Court-key recovery is part of the existing patron accounts (`patrons/acct`, handle index, patron sessions). It does not create an account, copy an application email, change `source`, approve an ID, or touch admin TOTP.

This tree started from a local worker dated Nov 7 2026 08:52 America/Toronto. It is not confirmed identical to the deployed worker. Diff it against the live script before any release. This repository does not deploy.

## What is implemented

- `POST /patron/recovery/email` while signed in stores nothing until the patron proves they can read the mailbox. The confirmation link is bound to that account and that address.
- `POST /patron/recovery/email/confirm` sets `verifiedEmail` only from the token. A body field cannot choose a different address. Sessions and the court key stay as they are.
- `POST /patron/recovery/request` accepts a handle only. The message goes to `verifiedEmail` on that account. Unknown handles, accounts with no verified email, and a missing mail binding all return the same `{"ok":true}` and send nothing.
- `POST /patron/recovery/complete` sets a new court key with the existing PBKDF2 normalizer (at least 20 letters or numbers), bumps `recoveryGen`, deletes recovery tokens for that account, and deletes patron sessions. Admin password, TOTP, application status, and Vault membership are unchanged.
- Tokens are 32 random bytes. Only the SHA-256 hash is stored. Lifetime is 15 minutes. A token is valid only while `now < expiresAt`.
- Single-use is an R2 `put` with `If-None-Match: *` on `patrons/recovery-used/<hash>`. R2 commits that condition with the write. The password update is a second conditional put, `If-Match` on the patron object, so two different links cannot both change the key. A read followed by a delete is not the claim.
- `GET` and `HEAD` under `/patron/recovery` return 405 and do not claim a token. Links use a URL fragment on the site origin, so a prefetch of the page does not send the token to the worker.
- The link origin is `CANONICAL_ORIGIN` if set, otherwise `ALLOWED_ORIGIN`. The value must be a bare `https` origin. `Host`, `X-Forwarded-Host`, and redirect fields are not read.

## Mail is not live

No mail provider, domain, or API key is configured. `env.MAIL.send` is absent, so a request acknowledges and does not deliver. A test double that records `{ to, subject, text }` proves the envelope in unit tests. That double is not a production sender.

To turn delivery on later, add a Worker binding named `MAIL` whose `send({ to, subject, text })` delivers to the single `to` address. Keep the credential in a Worker secret. Do not send when `verifiedEmail` is missing. Do not add the application email onto the patron. Leave `CANONICAL_ORIGIN` unset, or set it to `https://houseofthemonarch.com`, because the fragment form lives on that page. `ALLOWED_ORIGIN` is already that origin.

The site and the worker have to be released together. The page posts to `/patron/recovery/*`. Until both are current, the form cannot finish a reset. Releasing either one is a separate decision from this branch.

## Storage

Existing R2 bucket `hotm-id-uploads`, binding `BUCKET`. New keys:

- `patrons/recovery/<sha256>` token record
- `patrons/recovery-idx/<accountId>/<sha256>`
- `patrons/recovery-used/<sha256>` claim marker
- `verifiedEmail`, `emailVerifiedAt`, and `recoveryGen` on the patron JSON, added when an address is confirmed or a key changes

No new bucket, Durable Object, or paid plan is required. Conditional puts have been in the R2 Workers API since 2022. Before release, confirm a conflicting `If-None-Match: *` put returns `null` on the account that hosts this bucket.

Expired token objects are removed by the existing daily cron. Patron accounts, ID files, Vault objects, and sessions are not deleted by that sweep.

## Release check

1. Diff `src/index.js` and `src/recovery.js` against the deployed worker. Stop if the deployed script has moved on.
2. Confirm `ALLOWED_ORIGIN` is `https://houseofthemonarch.com` with no path.
3. Confirm R2 conditional puts return `null` when the condition fails.
4. Add `MAIL` only when a provider is chosen. Until then, leave it unset and expect no delivery.
5. Do not put mail credentials, TOTP seeds, or `ENC_KEY` in git.
6. Deploy is out of scope for this change.
