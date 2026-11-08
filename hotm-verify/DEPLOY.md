# Release notes for hotm-verify recovery mail

This file is the release plan. Nothing in it has been deployed, and no message was sent from the Worker.

## What the live worker is

Checked from the sanitized v2 handoff. Last fresh live check recorded there: Nov 8, 2026 04:01 America/New_York.

- Script: `hotm-verify`
- Version 18, version id `7ca30034-3059-4b28-a26c-35e7cb56279a`
- Active deployment `dc514756-ee41-4064-9596-7f03c0e68008` at 100%
- Compatibility date `2024-09-01`, no compatibility flags
- Bindings: R2 `BUCKET` = `hotm-id-uploads`, plain text `ALLOWED_ORIGIN` = `https://houseofthemonarch.com`, secrets `ENC_KEY`, `ADMIN_PW_HASH`, `SESSION_KEY`, `TOTP_SECRET`
- No email binding
- The version 18 bundle has no recovery routes and no SMTP client. The pre-recovery source matches that bundle aside from the bundler's default-export name. This branch adds recovery and SMTP on top of that source. Do not upload the version 18 bundle as the recovery release.

## Candidate bundle

Built locally with `wrangler 3.114.17 deploy --dry-run --outdir build --keep-vars`. Wrangler exited before upload.

- Module: `build/index.js`
- SHA-256: `4ad643a3c0eed478aa2a6d4fc75342fd12cb32b4ab9d21f198186da7a118f98f`
- Metadata: `build/release-metadata.json`
- Same copy: `/cursor/stores/self/hotm-verify-release/`
- Compatibility date stays `2024-09-01`. Workers TCP sockets are already available at that date. No flag was added.
- `cloudflare:sockets` is imported only when a send actually uses SMTP.

## Why this transport

Google's current Workspace help for an app that sends mail still lists `smtp.gmail.com` port 465 with SSL and an app password for a client that is not an OAuth mail app: [Send email from a printer, scanner, or app](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app) (Option 2). The developer SMTP table matches that: [IMAP, POP, and SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp). Port 587 would start in cleartext before STARTTLS. Port 25 is blocked by Workers ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)). SMTP relay (`smtp-relay.gmail.com`) wants a stable source IP, which this Worker does not have.

Less-secure username-and-password sign-in for Workspace was removed May 1, 2025. Do not turn that back on. An app password is the documented leftover for SMTP: [Control access to less secure apps](https://knowledge.workspace.google.com/admin/apps/control-access-to-less-secure-apps) and [Sign in with app passwords](https://support.google.com/mail/answer/185833). Cloudflare Email Sending was not used.

## Mailbox owner steps

Do these as `sj@monarchofthemoon.shop`. Do not type the normal Google password into Wrangler, git, or chat.

1. Turn on 2-Step Verification for that mailbox if it is not already on.
2. Open [app passwords](https://myaccount.google.com/apppasswords) while signed in as that mailbox. Create one for Mail. If the page is missing, a Workspace admin has to allow app passwords for the account. The normal Google password will not work.
3. On the Cloudflare account that already hosts `hotm-verify`, from this directory:

```
npx wrangler secret put SMTP_APP_PASSWORD
```

Paste the 16-letter app password only. Do not delete `ENC_KEY`, `ADMIN_PW_HASH`, `SESSION_KEY`, or `TOTP_SECRET`. Leave `SMTP_USER` unset. If you set it, it must be `sj@monarchofthemoon.shop` or the Worker will not send.

Until that secret exists, recovery requests still return the generic acknowledgement and send nothing.

## Order

1. Put `SMTP_APP_PASSWORD` if the mailbox owner is ready. Version 18 ignores an unknown secret, so this can happen before the new script.
2. Deploy `build/index.js` as a new version of `hotm-verify` with the existing bindings kept (`--keep-vars`). Do not remove the R2 bucket or the four existing secrets. Do not add a Cloudflare `send_email` binding.
3. Publish the GitHub Pages `index.html` from this branch. Do that after the Worker, so the new form calls a script that already has the routes. Publishing Pages is a separate step from merging; merging `main` would publish the page.
4. Later, with an explicit send approval, exercise one isolated test patron: enroll, confirm, reset once, and confirm the link does not work a second time. That has not been done.

## Rollback

1. Roll the Worker back to version 18, version id `7ca30034-3059-4b28-a26c-35e7cb56279a`. That build has no recovery routes. Leave the existing secrets in place. `SMTP_APP_PASSWORD` can stay; version 18 does not read it.
2. Put the previous `index.html` back on Pages so the public Recover control does not call those routes.
3. Do not delete `ENC_KEY`, `TOTP_SECRET`, `SESSION_KEY`, or `ADMIN_PW_HASH` as part of the rollback.
