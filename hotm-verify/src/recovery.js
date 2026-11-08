// Patron court-key recovery. Tokens are stored only as SHA-256 hashes.
// Single-use is an R2 conditional put (If-None-Match: *), which R2 commits atomically.
// A read followed by a delete is not used and is not atomic.
// Mail is sent only through env.MAIL.send, and only to a verified address already
// stored on the patron record. Application emails are never read here.

export const RECOVERY_TTL_MS = 15 * 60 * 1000;
export const PASSCODE_MIN = 20;
const RECOVER_IP_LIMIT = 5;
const RECOVER_HANDLE_LIMIT = 5;
const GENERIC = { ok: true };
const INVALID_LINK = { error: "That link is not valid." };

const enc = new TextEncoder();
const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (u) => {
  const a = new Uint8Array(u);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
};

export function nowMs(env) {
  const n = typeof env.CLOCK === "function" ? Number(env.CLOCK()) : Date.now();
  return Number.isFinite(n) ? n : Date.now();
}

export function publicSiteOrigin(env) {
  const raw = String(env.CANONICAL_ORIGIN || env.ALLOWED_ORIGIN || "").trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(raw)) return null;
  return raw;
}

function mailReady(env) {
  return typeof env.MAIL?.send === "function" && !!publicSiteOrigin(env);
}

export function safeMailbox(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v.length < 6 || v.length > 128) return null;
  if (/[\u0000-\u0020,;<>()[\]\\"]/.test(v)) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v;
}

function isAccount(id) {
  return /^[0-9a-f]{32}$/.test(String(id || ""));
}

async function sha256hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function newToken() {
  const raw = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error("token");
  return raw;
}

function recoveryLink(env, kind, token) {
  const origin = publicSiteOrigin(env);
  if (!origin || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const name = kind === "email" ? "court-email-verify" : "court-key-reset";
  return `${origin}/#${name}=${token}`;
}

async function listPrefix(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor });
    out.push(...(r.objects || []));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

export async function deleteRecoveryTokens(env, accountId) {
  if (!isAccount(accountId)) return;
  const prefix = `patrons/recovery-idx/${accountId}/`;
  for (const o of await listPrefix(env.BUCKET, prefix)) {
    const hash = o.key.slice(prefix.length);
    if (/^[0-9a-f]{64}$/.test(hash)) await env.BUCKET.delete(`patrons/recovery/${hash}`);
    await env.BUCKET.delete(o.key);
  }
}

export async function casPatron(env, id, mutate) {
  if (!isAccount(id)) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const obj = await env.BUCKET.get(`patrons/acct/${id}.json`);
    if (!obj) return null;
    const current = JSON.parse(await obj.text());
    const etag = obj.httpEtag || obj.etag;
    if (!etag) return { rejected: true, patron: current };
    const next = await mutate(current);
    if (!next) return { rejected: true, patron: current };
    const wrote = await env.BUCKET.put(`patrons/acct/${id}.json`, JSON.stringify(next), {
      onlyIf: new Headers({ "If-Match": String(etag) }),
      httpMetadata: { contentType: "application/json" },
    });
    if (wrote) return { changed: true, patron: next };
  }
  return { conflict: true, patron: null };
}

async function storeToken(env, fields) {
  const token = newToken();
  const hash = await sha256hex(token);
  await env.BUCKET.put(`patrons/recovery/${hash}`, JSON.stringify(fields), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.BUCKET.put(`patrons/recovery-idx/${fields.accountId}/${hash}`, "1");
  return { token, hash };
}

async function loadToken(env, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ""))) return null;
  const hash = await sha256hex(token);
  const obj = await env.BUCKET.get(`patrons/recovery/${hash}`);
  if (!obj) return null;
  let rec;
  try { rec = JSON.parse(await obj.text()); } catch { return null; }
  if (!rec || typeof rec !== "object") return null;
  rec.hash = hash;
  return rec;
}

async function claimToken(env, hash, now) {
  const wrote = await env.BUCKET.put(
    `patrons/recovery-used/${hash}`,
    JSON.stringify({ at: now }),
    { onlyIf: new Headers({ "If-None-Match": "*" }) },
  );
  return !!wrote;
}

async function discardToken(env, accountId, hash) {
  await env.BUCKET.delete(`patrons/recovery/${hash}`);
  await env.BUCKET.delete(`patrons/recovery-idx/${accountId}/${hash}`);
}

async function sendOne(env, message) {
  await env.MAIL.send({ to: message.to, subject: message.subject, text: message.text });
}

export async function recoveryRequest(req, env, c, api) {
  let body;
  try { body = await req.json(); } catch { return api.json({ error: "bad request" }, 400, c); }
  const handle = api.normHandle(body && body.handle);
  if (await api.rateLimited(env, req, "recover-ip", RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  if (handle && await api.rateLimitedKey(env, "recover-handle", handle.toLowerCase(), RECOVER_HANDLE_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  if (handle && mailReady(env)) {
    const idObj = await env.BUCKET.get(await api.handleKey(handle));
    const id = idObj ? String(await idObj.text()).trim() : "";
    const patron = id ? await api.getPatron(env, id) : null;
    const email = patron ? safeMailbox(patron.verifiedEmail) : null;
    if (patron && email) {
      const { token, hash } = await storeToken(env, {
        purpose: "password-reset",
        accountId: patron.id,
        generation: patron.recoveryGen || 0,
        expiresAt: nowMs(env) + RECOVERY_TTL_MS,
      });
      const link = recoveryLink(env, "reset", token);
      let sent = false;
      if (link) {
        try {
          await sendOne(env, {
            to: email,
            subject: "House of the Monarch court key",
            text: "A court-key reset was requested for " + patron.handle + ".\n\nOpen this link and choose a new court key:\n" + link + "\n\nThe link expires in 15 minutes and works once. It does not approve an ID or open the Vault. If you did not ask, ignore this message.\n",
          });
          sent = true;
        } catch {
          sent = false;
        }
      }
      if (!sent) await discardToken(env, patron.id, hash);
    }
  }
  return api.json(GENERIC, 200, c);
}

export async function recoveryComplete(req, env, c, api) {
  let body;
  try { body = await req.json(); } catch { return api.json({ error: "bad request" }, 400, c); }
  if (await api.rateLimited(env, req, "recover-complete-ip", RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  const rec = await loadToken(env, body && body.token);
  if (!rec || rec.purpose !== "password-reset" || !isAccount(rec.accountId)) return api.json(INVALID_LINK, 400, c);
  if (!(nowMs(env) < Number(rec.expiresAt))) return api.json(INVALID_LINK, 400, c);
  const pass = api.normPass(body && body.passcode);
  if (pass.length < PASSCODE_MIN) {
    return api.json({ error: "Court key must be at least 20 letters or numbers." }, 400, c);
  }
  const now = nowMs(env);
  if (!(await claimToken(env, rec.hash, now))) return api.json(INVALID_LINK, 400, c);
  const hash = await api.hashPasscode(body.passcode);
  const when = new Date(now).toISOString();
  const wrote = await casPatron(env, rec.accountId, (p) => {
    if ((p.recoveryGen || 0) !== (Number(rec.generation) || 0)) return null;
    return { ...p, hash, resetAt: when, recoveryGen: (p.recoveryGen || 0) + 1 };
  });
  if (!wrote || !wrote.changed) return api.json(INVALID_LINK, 400, c);
  await deleteRecoveryTokens(env, rec.accountId);
  await api.killPatronSessions(env, rec.accountId);
  return api.json({ ok: true }, 200, c);
}

export async function recoveryEnroll(req, env, c, api) {
  const session = await api.checkPatron(env, req);
  if (!session) return api.json({ error: "unauthorized" }, 401, c);
  let body;
  try { body = await req.json(); } catch { return api.json({ error: "bad request" }, 400, c); }
  if (await api.rateLimited(env, req, "recover-enroll-ip", RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  const email = safeMailbox(body && body.email);
  if (!email) return api.json({ error: "bad email" }, 400, c);
  if (mailReady(env)) {
    const { token, hash } = await storeToken(env, {
      purpose: "email-verify",
      accountId: session.patron.id,
      email,
      expiresAt: nowMs(env) + RECOVERY_TTL_MS,
    });
    const link = recoveryLink(env, "email", token);
    let sent = false;
    if (link) {
      try {
        await sendOne(env, {
          to: email,
          subject: "Confirm your House of the Monarch recovery email",
          text: "Confirm this recovery address for " + session.patron.handle + ":\n" + link + "\n\nThe link expires in 15 minutes and works once. It does not change your court key, approve an ID, or open the Vault.\n",
        });
        sent = true;
      } catch {
        sent = false;
      }
    }
    if (!sent) await discardToken(env, session.patron.id, hash);
  }
  return api.json(GENERIC, 200, c);
}

export async function recoveryConfirmEmail(req, env, c, api) {
  let body;
  try { body = await req.json(); } catch { return api.json({ error: "bad request" }, 400, c); }
  if (await api.rateLimited(env, req, "recover-confirm-ip", RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  const rec = await loadToken(env, body && body.token);
  if (!rec || rec.purpose !== "email-verify" || !isAccount(rec.accountId)) return api.json(INVALID_LINK, 400, c);
  const email = safeMailbox(rec.email);
  if (!email) return api.json(INVALID_LINK, 400, c);
  if (!(nowMs(env) < Number(rec.expiresAt))) return api.json(INVALID_LINK, 400, c);
  if (!(await claimToken(env, rec.hash, nowMs(env)))) return api.json(INVALID_LINK, 400, c);
  const when = new Date(nowMs(env)).toISOString();
  const wrote = await casPatron(env, rec.accountId, (p) => ({
    ...p,
    verifiedEmail: email,
    emailVerifiedAt: when,
    recoveryGen: (p.recoveryGen || 0) + 1,
  }));
  if (!wrote || !wrote.changed) return api.json(INVALID_LINK, 400, c);
  await deleteRecoveryTokens(env, rec.accountId);
  return api.json({ ok: true }, 200, c);
}

export async function purgeRecovery(env) {
  const now = nowMs(env);
  const prefix = "patrons/recovery/";
  for (const o of await listPrefix(env.BUCKET, prefix)) {
    const obj = await env.BUCKET.get(o.key);
    if (!obj) continue;
    let rec;
    try { rec = JSON.parse(await obj.text()); } catch { continue; }
    if (!rec || !(Number(rec.expiresAt) <= now)) continue;
    await env.BUCKET.delete(o.key);
    const hash = o.key.slice(prefix.length);
    if (isAccount(rec.accountId) && /^[0-9a-f]{64}$/.test(hash)) {
      await env.BUCKET.delete(`patrons/recovery-idx/${rec.accountId}/${hash}`);
    }
  }
}

export function recoveryPaths(path, method) {
  if (path === "/patron/recovery/request" && method === "POST") return "request";
  if (path === "/patron/recovery/complete" && method === "POST") return "complete";
  if (path === "/patron/recovery/email" && method === "POST") return "enroll";
  if (path === "/patron/recovery/email/confirm" && method === "POST") return "confirm";
  if (path.startsWith("/patron/recovery") && (method === "GET" || method === "HEAD")) return "prefetch";
  return "";
}
