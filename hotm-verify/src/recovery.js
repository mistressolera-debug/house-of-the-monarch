// Patron court-key recovery. Tokens are stored only as SHA-256 hashes.
// Single-use is an R2 conditional put (If-None-Match: *), which R2 commits atomically.
// A read followed by a delete is not used and is not atomic.
// Mail goes to env.MAIL.send when a test double is installed. Otherwise it uses
// the Gmail SMTP adapter, which sends only as monarchofthemoonshop@gmail.com.
// Application emails are never read here.

import { sendWorkspaceMail, workspaceSmtpReady } from "./smtp-mail.js";

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
  if (!publicSiteOrigin(env)) return false;
  if (typeof env.MAIL?.send === "function") return true;
  return workspaceSmtpReady(env);
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
  const payload = { to: message.to, subject: message.subject, text: message.text };
  if (typeof env.MAIL?.send === "function") {
    await env.MAIL.send(payload);
    return;
  }
  await sendWorkspaceMail(env, payload);
}

function generation(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function textField(record, key) {
  const value = record && record[key];
  return typeof value === "string" ? value : "";
}

async function pause(env, name) {
  if (typeof env.BARRIER === "function") await env.BARRIER(name);
}

async function courtKeyMatches(api, patron, passcode) {
  const pass = api.normPass(passcode);
  if (!pass) return false;
  const parts = String(patron && patron.hash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = parseInt(parts[1], 10);
  if (!iters) return false;
  const got = await api.hashPassword(pass, parts[2], iters);
  return api.timingEq(got, parts[3]);
}

// Conditional increment. Losing writers retry. Exhausting the retries fails closed.
// The shared login/apply counters are still read-modify-write and are not used here.
async function limited(env, kind, material, limit) {
  const windowMs = 3600 * 1000;
  const bucket = Math.floor(nowMs(env) / windowMs);
  const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(String(material) + "|" + (env.SESSION_KEY || "")))).slice(0, 32);
  const key = `rl/${kind}/${bucket}/${h}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const obj = await env.BUCKET.get(key);
    const n = obj ? parseInt(await obj.text(), 10) || 0 : 0;
    if (n >= limit) return true;
    const etag = obj && (obj.httpEtag || obj.etag);
    const onlyIf = etag
      ? new Headers({ "If-Match": String(etag) })
      : new Headers({ "If-None-Match": "*" });
    const wrote = await env.BUCKET.put(key, String(n + 1), {
      onlyIf,
      customMetadata: { expires: String(nowMs(env) + windowMs) },
    });
    if (wrote) return false;
  }
  return true;
}

function clientIp(req) {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

export async function recoveryRequest(req, env, c, api) {
  let body;
  try { body = await req.json(); } catch { return api.json({ error: "bad request" }, 400, c); }
  const record = asRecord(body);
  if (!record) return api.json({ error: "bad request" }, 400, c);
  const handle = api.normHandle(textField(record, "handle"));
  if (await limited(env, "recover-ip", clientIp(req), RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  if (handle && await limited(env, "recover-handle", handle.toLowerCase(), RECOVER_HANDLE_LIMIT)) {
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
        generation: generation(patron.recoveryGen),
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
  if (await limited(env, "recover-complete-ip", clientIp(req), RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  const record = asRecord(body);
  const rec = await loadToken(env, textField(record, "token"));
  if (!rec || rec.purpose !== "password-reset" || !isAccount(rec.accountId) || !Number.isInteger(Number(rec.generation))) {
    return api.json(INVALID_LINK, 400, c);
  }
  await pause(env, "complete:loaded");
  if (!(nowMs(env) < Number(rec.expiresAt))) return api.json(INVALID_LINK, 400, c);
  const passcode = textField(record, "passcode");
  if (api.normPass(passcode).length < PASSCODE_MIN) {
    return api.json({ error: "Court key must be at least 20 letters or numbers." }, 400, c);
  }
  const now = nowMs(env);
  if (!(await claimToken(env, rec.hash, now))) return api.json(INVALID_LINK, 400, c);
  const hash = await api.hashPasscode(passcode);
  const when = new Date(now).toISOString();
  const wrote = await casPatron(env, rec.accountId, (p) => {
    if (generation(p.recoveryGen) !== Number(rec.generation)) return null;
    return {
      ...p,
      hash,
      resetAt: when,
      recoveryGen: generation(p.recoveryGen) + 1,
      sessionGen: generation(p.sessionGen) + 1,
    };
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
  const record = asRecord(body);
  if (!record) return api.json({ error: "bad request" }, 400, c);
  if (await limited(env, "recover-enroll-ip", clientIp(req), RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  const email = safeMailbox(textField(record, "email"));
  if (!email) return api.json({ error: "bad email" }, 400, c);
  if (!(await courtKeyMatches(api, session.patron, textField(record, "passcode")))) {
    return api.json({ error: "unauthorized" }, 401, c);
  }
  if (mailReady(env)) {
    const bumped = await casPatron(env, session.patron.id, (p) => {
      if (p.hash !== session.patron.hash || generation(p.sessionGen) !== generation(session.patron.sessionGen)) return null;
      return { ...p, recoveryGen: generation(p.recoveryGen) + 1 };
    });
    if (!bumped || !bumped.changed) return api.json({ error: "unauthorized" }, 401, c);
    await deleteRecoveryTokens(env, session.patron.id);
    const { token, hash } = await storeToken(env, {
      purpose: "email-verify",
      accountId: session.patron.id,
      email,
      generation: generation(bumped.patron.recoveryGen),
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
  if (await limited(env, "recover-confirm-ip", clientIp(req), RECOVER_IP_LIMIT)) {
    return api.json({ error: "Too many attempts. Try again later." }, 429, c);
  }
  const record = asRecord(body);
  const rec = await loadToken(env, textField(record, "token"));
  if (!rec || rec.purpose !== "email-verify" || !isAccount(rec.accountId) || !Number.isInteger(Number(rec.generation))) {
    return api.json(INVALID_LINK, 400, c);
  }
  const email = safeMailbox(rec.email);
  if (!email) return api.json(INVALID_LINK, 400, c);
  await pause(env, "confirm:loaded");
  if (!(nowMs(env) < Number(rec.expiresAt))) return api.json(INVALID_LINK, 400, c);
  if (!(await claimToken(env, rec.hash, nowMs(env)))) return api.json(INVALID_LINK, 400, c);
  const when = new Date(nowMs(env)).toISOString();
  const wrote = await casPatron(env, rec.accountId, (p) => {
    if (generation(p.recoveryGen) !== Number(rec.generation)) return null;
    return {
      ...p,
      verifiedEmail: email,
      emailVerifiedAt: when,
      recoveryGen: generation(p.recoveryGen) + 1,
    };
  });
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
