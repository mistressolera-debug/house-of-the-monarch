// hotm-verify: private ID upload + admin review. Never logs request bodies or file contents.
import { deskMessage } from "./desk-message.js";
import {
  casPatron,
  deleteRecoveryTokens,
  nowMs,
  purgeRecovery,
  recoveryComplete,
  recoveryConfirmEmail,
  recoveryEnroll,
  recoveryPaths,
  recoveryRequest,
  PASSCODE_MIN,
  RECOVERY_TTL_MS,
} from "./recovery.js";
const MAX_FILE = 8 * 1024 * 1024;
const TYPES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/heic": 1 };
const RL_LIMIT = 5, RL_WINDOW = 3600;
const LOGIN_LIMIT = 10;
const RETENTION_DAYS = 30;
// Public site banner. Stored UNENCRYPTED under its own prefix; never touched by ID purge/decide (which only use meta/ + files/).
const BANNER_KEY = "public/banner";
const BANNER_MAX = 5 * 1024 * 1024;
const SEC = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};
const enc = new TextEncoder();
const b64 = (u) => { const a=new Uint8Array(u); let s=""; for (let i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");

function resp(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...SEC, ...headers } });
}
const json = (o, s = 200, h = {}) => resp(JSON.stringify(o), s, { "Content-Type": "application/json", ...h });

function cors(env, req) {
  const o = req.headers.get("Origin");
  return o === env.ALLOWED_ORIGIN
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" }
    : null;
}
function timingEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function rateLimited(env, req, kind, limit) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = Math.floor(Date.now() / 1000 / RL_WINDOW);
  const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(ip + "|" + env.SESSION_KEY))).slice(0, 32);
  const key = `rl/${kind}/${bucket}/${h}`;
  const obj = await env.BUCKET.get(key);
  const n = obj ? parseInt(await obj.text()) || 0 : 0;
  if (n >= limit) return true;
  await env.BUCKET.put(key, String(n + 1), { customMetadata: { expires: String(Date.now() + RL_WINDOW * 1000) } });
  return false;
}

async function aesKey(env) {
  return crypto.subtle.importKey("raw", unb64(env.ENC_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptBytes(env, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(env);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return out;
}
async function decryptBytes(env, packed) {
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const key = await aesKey(env);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

async function hashPassword(password, saltB64, iters) {
  const salt = unb64(saltB64);
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, base, 256);
  return b64(bits);
}
async function verifyPassword(env, password) {
  // format: pbkdf2$iters$saltB64$hashB64
  const parts = (env.ADMIN_PW_HASH || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = parseInt(parts[1], 10);
  const got = await hashPassword(password, parts[2], iters);
  return timingEq(got, parts[3]);
}

// RFC 6238 TOTP (SHA-1, 30s, 6 digits)
function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "", out = [];
  s = s.replace(/=+$/, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  for (const c of s) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}
async function totp(secretB32, step = Math.floor(Date.now() / 1000 / 30)) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, step); // big-endian counter in low 32 (fine for decades)
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = mac[mac.length - 1] & 0xf;
  const code = ((mac[off] & 0x7f) << 24 | mac[off + 1] << 16 | mac[off + 2] << 8 | mac[off + 3]) % 1e6;
  return String(code).padStart(6, "0");
}
async function verifyTotp(env, code) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 1000 / 30);
  for (const s of [now - 1, now, now + 1]) {
    if (timingEq(await totp(env.TOTP_SECRET, s), c)) return true;
  }
  return false;
}

async function makeSession(env, hours = 4) {
  const exp = Date.now() + hours * 3600 * 1000;
  const payload = `admin|${exp}`;
  const key = await crypto.subtle.importKey("raw", unb64(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return btoa(payload) + "." + sig;
}
async function checkSession(env, cookieHeader) {
  const m = /(?:^|;\s*)hotm_admin=([^;]+)/.exec(cookieHeader || "");
  if (!m) return false;
  const [pB64, sig] = m[1].split(".");
  if (!pB64 || !sig) return false;
  let payload;
  try { payload = atob(pB64); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", unb64(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expect = b64(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  if (!timingEq(expect, sig)) return false;
  const parts = payload.split("|");
  if (parts[0] !== "admin") return false;
  return Date.now() < parseInt(parts[1], 10);
}
function sessionCookie(token) {
  return `hotm_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${4 * 3600}`;
}

function uid() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

async function handleApply(req, env) {
  const c = cors(env, req);
  if (!c) return json({ error: "origin not allowed" }, 403);
  if (await rateLimited(env, req, "apply", RL_LIMIT)) return json({ error: "rate limited" }, 429, c);
  let form;
  try { form = await req.formData(); } catch { return json({ error: "bad form" }, 400, c); }
  const handle = String(form.get("handle") || "").trim().slice(0, 64);
  const name = String(form.get("name") || "").trim().slice(0, 96);
  const email = String(form.get("email") || "").trim().slice(0, 128);
  const consent = String(form.get("consent") || "");
  const idFile = form.get("id_image");
  const selfie = form.get("selfie");
  if (!handle || !email || !consent) return json({ error: "missing fields" }, 400, c);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "bad email" }, 400, c);
  if (!(idFile instanceof File) || !(selfie instanceof File)) return json({ error: "files required" }, 400, c);
  for (const f of [idFile, selfie]) {
    if (f.size <= 0 || f.size > MAX_FILE) return json({ error: "file size" }, 400, c);
    if (!TYPES[f.type]) return json({ error: "file type" }, 400, c);
  }
  const id = uid();
  const now = new Date().toISOString();
  const idBytes = new Uint8Array(await idFile.arrayBuffer());
  const selfieBytes = new Uint8Array(await selfie.arrayBuffer());
  const idEnc = await encryptBytes(env, idBytes);
  const selfieEnc = await encryptBytes(env, selfieBytes);
  const meta = {
    id, handle, name, email,
    status: "pending",
    createdAt: now,
    reviewedAt: null,
    idKey: `files/${id}/id.bin`,
    selfieKey: `files/${id}/selfie.bin`,
    idType: idFile.type,
    selfieType: selfie.type,
  };
  await env.BUCKET.put(meta.idKey, idEnc, { httpMetadata: { contentType: "application/octet-stream" } });
  await env.BUCKET.put(meta.selfieKey, selfieEnc, { httpMetadata: { contentType: "application/octet-stream" } });
  await env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, id }, 200, c);
}

async function listPending(env) {
  const listed = await env.BUCKET.list({ prefix: "meta/" });
  const out = [];
  for (const o of listed.objects || []) {
    const obj = await env.BUCKET.get(o.key);
    if (!obj) continue;
    const m = JSON.parse(await obj.text());
    if (m.status === "pending") out.push({ id: m.id, handle: m.handle, name: m.name, email: m.email, createdAt: m.createdAt });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

async function getMeta(env, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const obj = await env.BUCKET.get(`meta/${id}.json`);
  return obj ? JSON.parse(await obj.text()) : null;
}

// ID image deletes are restricted to files/<id>/(id|selfie).bin so purge/decide can never touch vault/, patrons/ or public/.
async function delIdFile(env, key) {
  if (/^files\/[0-9a-f]{32}\/(id|selfie)\.bin$/.test(String(key || ""))) await env.BUCKET.delete(key);
}
async function decide(env, id, decision) {
  const meta = await getMeta(env, id);
  if (!meta || meta.status !== "pending") return null;
  // delete image files immediately
  await delIdFile(env, meta.idKey);
  await delIdFile(env, meta.selfieKey);
  const kept = {
    id: meta.id,
    handle: meta.handle,
    status: decision,
    createdAt: meta.createdAt,
    reviewedAt: new Date().toISOString(),
  };
  await env.BUCKET.put(`meta/${id}.json`, JSON.stringify(kept), { httpMetadata: { contentType: "application/json" } });
  return kept;
}

async function serveImage(env, id, which) {
  const meta = await getMeta(env, id);
  if (!meta || meta.status !== "pending") return resp("gone", 404);
  const key = which === "selfie" ? meta.selfieKey : meta.idKey;
  const type = which === "selfie" ? meta.selfieType : meta.idType;
  const obj = await env.BUCKET.get(key);
  if (!obj) return resp("gone", 404);
  const packed = new Uint8Array(await obj.arrayBuffer());
  const plain = await decryptBytes(env, packed);
  return resp(plain, 200, { "Content-Type": type || "application/octet-stream" });
}

function sniffImage(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
// CSRF: admin state-changing banner calls must come from the admin page itself (same origin) and carry a custom header.
function sameOriginAdmin(req, url) {
  return req.headers.get("Origin") === url.origin && req.headers.get("X-HOTM-Admin") === "1";
}
async function serveBanner(env, head) {
  const obj = head ? await env.BUCKET.head(BANNER_KEY) : await env.BUCKET.get(BANNER_KEY);
  const pub = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };
  if (!obj) return resp("no banner", 404, { ...pub, "Cache-Control": "public, max-age=60", "Content-Type": "text/plain" });
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  const h = { ...pub, "Content-Type": type, "Content-Length": String(obj.size) };
  if (obj.httpEtag) h["ETag"] = obj.httpEtag;
  return resp(head ? null : obj.body, 200, h);
}
async function bannerInfo(env) {
  const obj = await env.BUCKET.head(BANNER_KEY);
  if (!obj) return { exists: false };
  return { exists: true, size: obj.size, type: obj.httpMetadata && obj.httpMetadata.contentType, uploaded: obj.uploaded };
}
async function uploadBanner(req, env) {
  let form;
  try { form = await req.formData(); } catch { return json({ error: "bad form" }, 400); }
  const f = form.get("banner");
  if (!(f instanceof File)) return json({ error: "file required" }, 400);
  if (f.size <= 0 || f.size > BANNER_MAX) return json({ error: "file must be under 5 MB" }, 400);
  const bytes = new Uint8Array(await f.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return json({ error: "only JPEG, PNG or WebP images" }, 400);
  await env.BUCKET.put(BANNER_KEY, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=300" } });
  return json({ ok: true, ...(await bannerInfo(env)) });
}

// ---------- Patron accounts ----------
// Stored under patrons/ only: patrons/acct/<id>.json, patrons/handle/<sha256(lower handle)> -> id,
// patrons/sess/<id>/<sid> (one object per live session). ID purge/decide never list or delete patrons/.
const PATRON_ITERS = 12000;
const PATRON_SESSION_DAYS = 7;
const PATRON_IP_LIMIT = 20, PATRON_HANDLE_LIMIT = 10;
const PASS_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

function normHandle(h) {
  const v = String(h || "").trim().replace(/\s+/g, " ");
  return /^[A-Za-z0-9_.@+\- ]{2,64}$/.test(v) ? v : null;
}
async function handleKey(handle) {
  return "patrons/handle/" + hex(await crypto.subtle.digest("SHA-256", enc.encode(handle.toLowerCase())));
}
function newPasscode() {
  const out = [];
  while (out.length < 20) {
    const r = crypto.getRandomValues(new Uint8Array(32));
    for (const b of r) { if (b < 248 && out.length < 20) out.push(PASS_ALPHA[b % 31]); } // 248 = 8*31, unbiased
  }
  return out.join("").match(/.{4}/g).join("-");
}
const normPass = (p) => String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
async function hashPasscode(pass) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${PATRON_ITERS}$${salt}$${await hashPassword(normPass(pass), salt, PATRON_ITERS)}`;
}
async function getPatron(env, id) {
  if (!/^[0-9a-f]{32}$/.test(String(id || ""))) return null;
  const o = await env.BUCKET.get(`patrons/acct/${id}.json`);
  return o ? JSON.parse(await o.text()) : null;
}
async function putPatron(env, p) {
  await env.BUCKET.put(`patrons/acct/${p.id}.json`, JSON.stringify(p), { httpMetadata: { contentType: "application/json" } });
}
async function handleTaken(env, handle) {
  return !!(await env.BUCKET.head(await handleKey(handle)));
}
async function createPatron(env, handle, source) {
  const h = normHandle(handle);
  if (!h) return { error: "handle must be 2-64 letters, numbers, spaces or _ . @ + -" };
  if (await handleTaken(env, h)) return { error: "that handle already has a patron account" };
  const passcode = newPasscode();
  const p = { id: uid(), handle: h, hash: await hashPasscode(passcode), source, createdAt: new Date().toISOString() };
  await env.BUCKET.put(await handleKey(h), p.id);
  await putPatron(env, p);
  return { patron: { id: p.id, handle: p.handle }, passcode };
}
async function listAll(env, prefix, include) {
  const out = []; let cursor;
  do {
    const r = await env.BUCKET.list({ prefix, cursor, ...(include ? { include } : {}) });
    out.push(...(r.objects || []));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}
async function killPatronSessions(env, id) {
  const objs = await listAll(env, `patrons/sess/${id}/`);
  for (const o of objs) await env.BUCKET.delete(o.key);
  return objs.length;
}
async function listPatrons(env) {
  const out = [];
  for (const o of await listAll(env, "patrons/acct/")) {
    const obj = await env.BUCKET.get(o.key);
    if (!obj) continue;
    const p = JSON.parse(await obj.text());
    out.push({ id: p.id, handle: p.handle, source: p.source, createdAt: p.createdAt, resetAt: p.resetAt || null });
  }
  out.sort((a, b) => (a.handle.toLowerCase() < b.handle.toLowerCase() ? -1 : 1));
  return out;
}
async function revokePatron(env, id) {
  const p = await getPatron(env, id);
  if (!p) return false;
  await env.BUCKET.delete(`patrons/acct/${p.id}.json`);
  await env.BUCKET.delete(await handleKey(p.handle));
  await killPatronSessions(env, p.id);
  await deleteRecoveryTokens(env, p.id);
  return true;
}
async function resetPatron(env, id) {
  const existing = await getPatron(env, id);
  if (!existing) return null;
  const passcode = newPasscode();
  const hash = await hashPasscode(passcode);
  const wrote = await casPatron(env, id, (p) => ({
    ...p,
    hash,
    resetAt: new Date(nowMs(env)).toISOString(),
    recoveryGen: (Number.isInteger(p.recoveryGen) ? p.recoveryGen : 0) + 1,
    sessionGen: (Number.isInteger(p.sessionGen) ? p.sessionGen : 0) + 1,
  }));
  if (!wrote || !wrote.changed) return null;
  await deleteRecoveryTokens(env, id);
  await killPatronSessions(env, id);
  return { patron: { id: wrote.patron.id, handle: wrote.patron.handle }, passcode };
}
function recoveryApi() {
  return { json, normHandle, normPass, hashPassword, hashPasscode, timingEq, getPatron, killPatronSessions, checkPatron, handleKey };
}
async function hmacSign(env, payload) {
  const key = await crypto.subtle.importKey("raw", unb64(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}
async function sessionCurrent(env, patron, sid) {
  const sess = await env.BUCKET.head(`patrons/sess/${patron.id}/${sid}`);
  if (!sess) return false;
  const raw = sess.customMetadata && sess.customMetadata.sessionGen;
  const stamped = raw == null || raw === "" ? 0 : Number(raw);
  const current = Number.isInteger(patron.sessionGen) ? patron.sessionGen : 0;
  return Number.isInteger(stamped) && stamped === current;
}
async function makePatronToken(env, p) {
  const fresh = await getPatron(env, p.id);
  const seenGen = Number.isInteger(p.sessionGen) ? p.sessionGen : 0;
  const freshGen = fresh && Number.isInteger(fresh.sessionGen) ? fresh.sessionGen : 0;
  if (!fresh || fresh.hash !== p.hash || freshGen !== seenGen) return null;
  if (typeof env.BARRIER === "function") await env.BARRIER("login:before-session");
  const sid = uid();
  const exp = Date.now() + PATRON_SESSION_DAYS * 86400 * 1000;
  await env.BUCKET.put(`patrons/sess/${p.id}/${sid}`, String(seenGen), {
    customMetadata: { exp: String(exp), sessionGen: String(seenGen) },
  });
  const payload = `patron|${p.id}|${sid}|${exp}`; // "patron|" prefix: can never pass the admin "admin|" check
  return btoa(payload) + "." + (await hmacSign(env, payload));
}
// Returns { patron, sid } or null. Verified against the account + live session record on every call.
async function checkPatron(env, req) {
  const m = /^Bearer\s+([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  let payload;
  try { payload = atob(m[1]); } catch { return null; }
  if (!timingEq(await hmacSign(env, payload), m[2])) return null;
  const [kind, id, sid, exp] = payload.split("|");
  if (kind !== "patron" || !/^[0-9a-f]{32}$/.test(sid || "") || !(Date.now() < parseInt(exp, 10))) return null;
  const p = await getPatron(env, id);
  if (!p) return null;
  if (!(await sessionCurrent(env, p, sid))) return null;
  return { patron: p, sid };
}
function patronCors(env, req) {
  const o = req.headers.get("Origin");
  return o === env.ALLOWED_ORIGIN
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "600", "Vary": "Origin" }
    : null;
}
async function rateLimitedKey(env, kind, keyStr, limit) {
  const bucket = Math.floor(Date.now() / 1000 / RL_WINDOW);
  const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(keyStr + "|" + env.SESSION_KEY))).slice(0, 32);
  const key = `rl/${kind}/${bucket}/${h}`;
  const obj = await env.BUCKET.get(key);
  const n = obj ? parseInt(await obj.text()) || 0 : 0;
  if (n >= limit) return true;
  await env.BUCKET.put(key, String(n + 1), { customMetadata: { expires: String(Date.now() + RL_WINDOW * 1000) } });
  return false;
}
async function patronLogin(req, env, c) {
  const generic = { error: "Invalid handle or passcode." };
  let body; try { body = await req.json(); } catch { return json({ error: "bad request" }, 400, c); }
  const handle = normHandle(body.handle);
  const pass = normPass(body.passcode);
  if (await rateLimited(env, req, "patron-ip", PATRON_IP_LIMIT)) return json({ error: "Too many attempts. Try again later." }, 429, c);
  if (handle && await rateLimitedKey(env, "patron-handle", handle.toLowerCase(), PATRON_HANDLE_LIMIT))
    return json({ error: "Too many attempts. Try again later." }, 429, c);
  let p = null;
  if (handle) {
    const idObj = await env.BUCKET.get(await handleKey(handle));
    if (idObj) p = await getPatron(env, await idObj.text());
  }
  // Always run one PBKDF2 so unknown handles take the same time as wrong passcodes.
  const parts = p ? p.hash.split("$") : ["pbkdf2", String(PATRON_ITERS), DUMMY_SALT, "x"];
  const got = await hashPassword(pass, parts[2], parseInt(parts[1], 10));
  const ok = !!p && pass.length > 0 && timingEq(got, parts[3]);
  if (!ok) return json(generic, 401, c);
  const token = await makePatronToken(env, p);
  if (!token) return json(generic, 401, c);
  return json({ ok: true, token, handle: p.handle }, 200, c);
}
async function purgePatronSessions(env) {
  const now = Date.now();
  for (const o of await listAll(env, "patrons/sess/", ["customMetadata"])) {
    const exp = parseInt((o.customMetadata && o.customMetadata.exp) || "0", 10);
    if (exp && exp < now) await env.BUCKET.delete(o.key);
  }
}

async function purgeOld(env) {
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const listed = await env.BUCKET.list({ prefix: "meta/" });
  let n = 0;
  for (const o of listed.objects || []) {
    const obj = await env.BUCKET.get(o.key);
    if (!obj) continue;
    const m = JSON.parse(await obj.text());
    if (m.status !== "pending" || !o.key.startsWith("meta/")) continue;
    if (new Date(m.createdAt).getTime() >= cutoff) continue;
    await delIdFile(env, m.idKey);
    await delIdFile(env, m.selfieKey);
    const kept = { id: m.id, handle: m.handle, status: "expired", createdAt: m.createdAt, reviewedAt: new Date().toISOString() };
    await env.BUCKET.put(o.key, JSON.stringify(kept));
    n++;
  }
  return n;
}


// ---------- Vault media (private, patrons only) ----------
// Stored under vault/ only: vault/media/<id> (raw bytes, private bucket), vault/meta/<id>.json,
// vault/pending/<id>.json (in-progress multipart uploads). ID purge/decide never list or delete vault/.
const VAULT_PART = 16 * 1024 * 1024;          // fixed part size (R2 needs equal parts except the last)
const VAULT_MAX = 20 * 1024 * 1024 * 1024;    // 20 GiB per item (R2 allows 10,000 parts)
const VAULT_URL_TTL = 2 * 3600 * 1000;        // signed media URLs last 2 hours
const VAULT_TYPES = { "image/jpeg": "photo", "image/png": "photo", "image/webp": "photo", "image/gif": "photo",
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video" };
function sniffMedia(b) {
  const img = sniffImage(b);
  if (img) return img;
  const s = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length >= 6 && (s(0, 6) === "GIF87a" || s(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 12 && s(4, 4) === "ftyp") return s(8, 4) === "qt  " ? "video/quicktime" : "video/mp4";
  if (b.length >= 8 && ["moov", "mdat", "wide", "free", "skip"].includes(s(4, 4))) return "video/quicktime";
  return null;
}
const cleanText = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
const isId = (id) => /^[0-9a-f]{32}$/.test(String(id || ""));
async function getJson(env, key) { const o = await env.BUCKET.get(key); return o ? JSON.parse(await o.text()) : null; }
async function putJson(env, key, v) { await env.BUCKET.put(key, JSON.stringify(v), { httpMetadata: { contentType: "application/json" } }); }
const vaultMetaKey = (id) => `vault/meta/${id}.json`;
const vaultMediaKey = (id) => `vault/media/${id}`;
const vaultPendKey = (id) => `vault/pending/${id}.json`;

async function listVault(env) {
  const objs = await listAll(env, "vault/meta/");
  const out = [];
  for (let i = 0; i < objs.length; i += 25) {
    const batch = await Promise.all(objs.slice(i, i + 25).map((o) => getJson(env, o.key).catch(() => null)));
    for (const m of batch) if (m) out.push(m);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  return out;
}
const publicItem = (m) => ({ id: m.id, kind: m.kind, type: m.type, title: m.title || "", caption: m.caption || "", size: m.size, createdAt: m.createdAt });

async function vaultCreateUpload(req, env) {
  let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const size = Number(body.size);
  const declared = String(body.type || "");
  if (!VAULT_TYPES[declared]) return json({ error: "only JPEG, PNG, WebP, GIF photos or MP4, WebM, MOV videos" }, 415);
  if (!Number.isFinite(size) || size <= 0) return json({ error: "empty file" }, 400);
  if (size > VAULT_MAX) return json({ error: "file is over 20 GB" }, 413);
  const id = uid();
  const mpu = await env.BUCKET.createMultipartUpload(vaultMediaKey(id), { httpMetadata: { contentType: declared } });
  const pend = { id, uploadId: mpu.uploadId, declared, size, parts: Math.ceil(size / VAULT_PART), sniffed: null,
    title: cleanText(body.title, 140), caption: cleanText(body.caption, 1000), name: cleanText(body.name, 200),
    createdAt: new Date().toISOString() };
  await putJson(env, vaultPendKey(id), pend);
  return json({ ok: true, id, partSize: VAULT_PART, parts: pend.parts });
}
async function vaultAbort(env, id) {
  const pend = await getJson(env, vaultPendKey(id));
  if (!pend) return false;
  try { await env.BUCKET.resumeMultipartUpload(vaultMediaKey(id), pend.uploadId).abort(); } catch {}
  await env.BUCKET.delete(vaultPendKey(id));
  return true;
}
async function vaultUploadPart(req, env, id, n) {
  const pend = await getJson(env, vaultPendKey(id));
  if (!pend) return json({ error: "upload not found" }, 404);
  if (!(n >= 1 && n <= pend.parts)) return json({ error: "bad part number" }, 400);
  const expect = n < pend.parts ? VAULT_PART : pend.size - VAULT_PART * (pend.parts - 1);
  const len = parseInt(req.headers.get("Content-Length") || "-1", 10);
  if (len !== expect) return json({ error: `part ${n} must be ${expect} bytes` }, 400);
  const mpu = env.BUCKET.resumeMultipartUpload(vaultMediaKey(id), pend.uploadId);
  let value = req.body;
  if (n === 1) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    const t = sniffMedia(bytes.subarray(0, 64));
    if (!t || VAULT_TYPES[t] !== VAULT_TYPES[pend.declared]) {
      await vaultAbort(env, id);
      return json({ error: "file contents are not a supported photo or video" }, 415);
    }
    pend.sniffed = t;
    await putJson(env, vaultPendKey(id), pend);
    value = bytes;
  }
  const part = await mpu.uploadPart(n, value);
  return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
}
async function vaultComplete(req, env, id) {
  const pend = await getJson(env, vaultPendKey(id));
  if (!pend) return json({ error: "upload not found" }, 404);
  if (!pend.sniffed) return json({ error: "first part not uploaded" }, 400);
  let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const parts = (Array.isArray(body.parts) ? body.parts : [])
    .map((p) => ({ partNumber: parseInt(p.partNumber, 10), etag: String(p.etag || "") }))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length !== pend.parts || parts.some((p, i) => p.partNumber !== i + 1 || !p.etag)) return json({ error: "missing parts" }, 400);
  const mpu = env.BUCKET.resumeMultipartUpload(vaultMediaKey(id), pend.uploadId);
  await mpu.complete(parts);
  const head = await env.BUCKET.head(vaultMediaKey(id));
  if (!head || head.size !== pend.size) {
    await env.BUCKET.delete(vaultMediaKey(id)); await env.BUCKET.delete(vaultPendKey(id));
    return json({ error: "upload size mismatch" }, 400);
  }
  const meta = { id, kind: VAULT_TYPES[pend.sniffed], type: pend.sniffed, size: pend.size, title: pend.title, caption: pend.caption,
    name: pend.name, createdAt: new Date().toISOString() };
  await putJson(env, vaultMetaKey(id), meta);
  await env.BUCKET.delete(vaultPendKey(id));
  return json({ ok: true, item: publicItem(meta) });
}
async function vaultEdit(req, env, id) {
  const m = await getJson(env, vaultMetaKey(id));
  if (!m) return json({ error: "not found" }, 404);
  let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if ("title" in body) m.title = cleanText(body.title, 140);
  if ("caption" in body) m.caption = cleanText(body.caption, 1000);
  m.updatedAt = new Date().toISOString();
  await putJson(env, vaultMetaKey(id), m);
  return json({ ok: true, item: publicItem(m) });
}
async function vaultDelete(env, id) {
  const m = await getJson(env, vaultMetaKey(id));
  if (!m) return false;
  await env.BUCKET.delete(vaultMediaKey(id));
  await env.BUCKET.delete(vaultMetaKey(id));
  return true;
}
async function purgeVaultPending(env) {
  const cutoff = Date.now() - 2 * 86400 * 1000;
  for (const o of await listAll(env, "vault/pending/")) {
    const p = await getJson(env, o.key).catch(() => null);
    if (p && isId(p.id) && new Date(p.createdAt).getTime() < cutoff) await vaultAbort(env, p.id);
  }
}
// Serve a vault object with HTTP Range support. Never cacheable, always inline.
async function serveVaultObject(req, env, meta) {
  const key = vaultMediaKey(meta.id);
  const head = await env.BUCKET.head(key);
  if (!head) return resp("not found", 404);
  const size = head.size;
  const base = { "Content-Type": meta.type, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    "Content-Disposition": "inline", "Cross-Origin-Resource-Policy": "cross-origin" };
  const rh = req.headers.get("Range");
  let start = 0, end = size - 1, partial = false;
  if (rh) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rh.trim());
    if (!m || (m[1] === "" && m[2] === "")) return resp(null, 416, { ...base, "Content-Range": `bytes */${size}` });
    if (m[1] === "") { const n = parseInt(m[2], 10); start = Math.max(0, size - n); }
    else { start = parseInt(m[1], 10); if (m[2] !== "") end = Math.min(parseInt(m[2], 10), size - 1); }
    if (start >= size || start > end) return resp(null, 416, { ...base, "Content-Range": `bytes */${size}` });
    partial = true;
  }
  const len = end - start + 1;
  const h = { ...base, "Content-Length": String(len) };
  if (partial) h["Content-Range"] = `bytes ${start}-${end}/${size}`;
  if (req.method === "HEAD") return resp(null, partial ? 206 : 200, h);
  const obj = await env.BUCKET.get(key, partial ? { range: { offset: start, length: len } } : {});
  if (!obj) return resp("not found", 404);
  return resp(obj.body, partial ? 206 : 200, h);
}
const b64url = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function mediaSig(env, id, pid, sid, exp) { return b64url(await hmacSign(env, `media|${id}|${pid}|${sid}|${exp}`)); }
async function signedMediaUrl(env, origin, id, s) {
  const exp = Date.now() + VAULT_URL_TTL;
  const sig = await mediaSig(env, id, s.patron.id, s.sid, exp);
  return `${origin}/patron/media/${id}?p=${s.patron.id}&s=${s.sid}&exp=${exp}&sig=${sig}`;
}
// GET/HEAD /patron/media/<id>: signed URL (img/video tags can't send Authorization). Re-checks patron + session every request.
async function servePatronMedia(req, env, url, id) {
  const q = url.searchParams;
  const pid = q.get("p") || "", sid = q.get("s") || "", exp = q.get("exp") || "", sig = q.get("sig") || "";
  if (!isId(id) || !isId(pid) || !isId(sid) || !/^\d{10,16}$/.test(exp) || !sig) return resp("forbidden", 403);
  if (!timingEq(await mediaSig(env, id, pid, sid, exp), sig)) return resp("forbidden", 403);
  if (!(Date.now() < parseInt(exp, 10))) return resp("link expired", 403);
  const p = await getPatron(env, pid);
  if (!p || !(await sessionCurrent(env, p, sid))) return resp("forbidden", 403);
  const meta = await getJson(env, vaultMetaKey(id));
  if (!meta) return resp("not found", 404);
  return serveVaultObject(req, env, meta);
}

// Members-only Vault content (moved out of the public index.html). Served only to valid patron tokens.
const VAULT_HTML = `
      <div class="p-6 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-4">
        <h3 class="font-cinzel text-xl font-bold text-gold-300">The Sovereign Vault</h3>
        <p class="text-xs text-slate-400">High-sovereignty private media archives and exclusive patron dispatches.</p>
        
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 pt-4">
          <div class="p-4 rounded-xl border border-slate-800 bg-slate-950/80 space-y-3">
            <div class="h-36 rounded-lg bg-royal-900 border border-gold-500/20 flex items-center justify-center">
              <i data-lucide="lock" class="w-8 h-8 text-gold-400"></i>
            </div>
            <h4 class="font-semibold text-sm text-slate-200">Court Dispatch #04</h4>
            <p class="text-[11px] text-slate-400">Verified Key Required</p>
          </div>
          <div class="p-4 rounded-xl border border-slate-800 bg-slate-950/80 space-y-3">
            <div class="h-36 rounded-lg bg-royal-900 border border-gold-500/20 flex items-center justify-center">
              <i data-lucide="lock" class="w-8 h-8 text-gold-400"></i>
            </div>
            <h4 class="font-semibold text-sm text-slate-200">Private Retainer Notes</h4>
            <p class="text-[11px] text-slate-400">Verified Key Required</p>
          </div>
          <div class="p-4 rounded-xl border border-slate-800 bg-slate-950/80 space-y-3">
            <div class="h-36 rounded-lg bg-royal-900 border border-gold-500/20 flex items-center justify-center">
              <i data-lucide="lock" class="w-8 h-8 text-gold-400"></i>
            </div>
            <h4 class="font-semibold text-sm text-slate-200">High Protocol Archive</h4>
            <p class="text-[11px] text-slate-400">Verified Key Required</p>
          </div>
        </div>
      </div>
`;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="robots" content="noindex,nofollow"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>HOTM Verify Admin</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0614;color:#e8e0f0;margin:0;padding:24px}
h1{color:#f0c36a;font-size:1.25rem}
.card{background:#161022;border:1px solid #3a2a55;border-radius:12px;padding:16px;margin:12px 0;max-width:720px}
input,button,textarea{font:inherit}
input,button,textarea{padding:10px 14px;border-radius:8px;border:1px solid #3a2a55;background:#0b0614;color:#e8e0f0}
button{background:#f0c36a;color:#1a1000;font-weight:700;cursor:pointer;border:0}
img{max-width:100%;border-radius:8px;border:1px solid #3a2a55;margin:8px 0}
.err{color:#f88}.ok{color:#8f8} .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.key{background:#0b0614;border:1px dashed #f0c36a;border-radius:10px;padding:12px;margin:8px 0;font-family:ui-monospace,monospace}
.key b{color:#f0c36a} .small{font-size:12px;color:#aaa} .prow{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;border-top:1px solid #3a2a55;padding:8px 0}
label{display:block;font-size:12px;margin:8px 0 4px;color:#aaa}
</style></head><body>
<div id="login" class="card">
  <h1>Admin sign-in</h1>
  <label>Password</label><input id="pw" type="password" autocomplete="current-password"/>
  <label>Authenticator code</label><input id="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"/>
  <p><button id="loginBtn">Sign in</button></p>
  <p id="loginErr" class="err"></p>
</div>
<div id="app" style="display:none">
  <h1>Pending verifications <button id="refresh">Refresh</button> <button id="logout">Sign out</button></h1>
  <div id="list"></div>
  <div class="card" id="patronsCard">
    <h1>Patrons</h1>
    <div class="small">People who can sign in to The Vault. Approving an application creates a patron. Keys are shown only once: copy them and send them yourself.</div>
    <div id="keyBox"></div>
    <label>Create patron manually (handle)</label>
    <div class="row"><input id="newHandle" maxlength="64" placeholder="e.g. SovereignPatron7"/><button id="createPatron">Create patron</button></div>
    <p id="patronMsg"></p>
    <div id="patronList"></div>
  </div>
  <div class="card" id="vaultCard">
    <h1>Vault media</h1>
    <div class="small">Photos (JPEG, PNG, WebP, GIF) and videos (MP4, WebM, MOV) for signed-in patrons only. Never public. Big videos upload in pieces; keep this page open until it says Done.</div>
    <label>Choose photos or videos</label>
    <input id="vFile" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm,.gif"/>
    <label>Title (optional)</label><input id="vTitle" maxlength="140" style="width:100%;box-sizing:border-box"/>
    <label>Caption (optional)</label><textarea id="vCaption" maxlength="1000" rows="2" style="width:100%;box-sizing:border-box"></textarea>
    <div class="row" style="margin-top:8px"><button id="vUpload">Upload to Vault</button><button id="vCancel" style="display:none;background:#844">Cancel upload</button></div>
    <progress id="vProg" max="1" value="0" style="width:100%;display:none;margin-top:8px"></progress>
    <p id="vMsg"></p>
    <div id="vList"></div>
  </div>
  <div class="card" id="bannerCard">
    <h1>Site banner</h1>
    <div style="font-size:12px;color:#aaa">Shown at the top of houseofthemonarch.com. JPEG, PNG or WebP, up to 5 MB. Changes show on the site within about 5 minutes.</div>
    <div id="bannerNone" class="ok" style="display:none">No banner uploaded &mdash; the site shows its built-in drawn banner.</div>
    <img id="bannerPreview" alt="Current banner" style="display:none"/>
    <div id="bannerMeta" style="font-size:12px;color:#aaa"></div>
    <label>Choose a new banner image</label>
    <input id="bannerFile" type="file" accept="image/jpeg,image/png,image/webp"/>
    <div class="row" style="margin-top:8px"><button id="bannerUpload">Upload banner</button><button id="bannerRemove" style="background:#844">Remove banner</button></div>
    <p id="bannerMsg"></p>
  </div>
</div>
<script>
async function api(path, opts){
  const r = await fetch(path, {credentials:'include', ...opts});
  const t = await r.text();
  let j; try{j=JSON.parse(t)}catch{j={raw:t}}
  if(!r.ok) throw new Error(j.error||r.status);
  return j;
}
const $ = (id)=>document.getElementById(id);
$('loginBtn').onclick = async ()=>{
  $('loginErr').textContent='';
  try{
    await api('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:$('pw').value,totp:$('totp').value})});
    $('login').style.display='none'; $('app').style.display='block'; load(); loadPatrons(); loadBanner(); loadVaultAdmin();
  }catch(e){$('loginErr').textContent=e.message}
};
$('logout').onclick = async ()=>{ await api('/admin/logout',{method:'POST'}); location.reload(); };
$('refresh').onclick = ()=>{load(); loadPatrons(); loadBanner(); loadVaultAdmin();};
async function load(){
  const {items}=await api('/admin/api/list');
  const el=$('list'); el.innerHTML='';
  if(!items.length){el.innerHTML='<p class="ok">No pending applications.</p>';return;}
  for(const it of items){
    const d=document.createElement('div'); d.className='card';
    d.innerHTML = '<h2 style="margin:0 0 8px;font-size:1rem">'+esc(it.handle)+'</h2>'+
      '<div style="font-size:12px;color:#aaa">'+esc(it.name||'')+' · '+esc(it.email)+' · '+esc(it.createdAt)+'</div>'+
      '<div class="row"><div style="flex:1"><div style="font-size:11px">ID</div><img src="/admin/api/image/'+it.id+'/id" alt=""/></div>'+
      '<div style="flex:1"><div style="font-size:11px">Selfie</div><img src="/admin/api/image/'+it.id+'/selfie" alt=""/></div></div>'+
      '<label>Patron handle (used to sign in; you can edit it)</label><input data-h="'+it.id+'" maxlength="64" value="'+esc(it.handle||it.email||'')+'"/>'+
      '<div class="row" style="margin-top:8px"><button data-a="'+it.id+'">Approve &amp; create key</button><button data-r="'+it.id+'" style="background:#844">Reject</button></div>';
    el.appendChild(d);
  }
  el.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>decide(b.dataset.a,'approved'));
  el.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>decide(b.dataset.r,'rejected'));
}
const AH={'Content-Type':'application/json','X-HOTM-Admin':'1'};
async function decide(id, decision){
  const hEl=document.querySelector('[data-h="'+id+'"]');
  const handle=hEl?hEl.value.trim():'';
  if(!confirm((decision==='approved'?'Approve '+handle+' and create their key?':'Reject this application?')+' ID images will be deleted immediately.')) return;
  try{
    const r=await api('/admin/api/decide',{method:'POST',headers:AH,body:JSON.stringify({id,decision,handle})});
    if(r.passcode) showKey(r.patron.handle,r.passcode,'New patron approved');
    load(); loadPatrons();
  }catch(e){alert(e.message)}
}
function showKey(handle,pass,title){
  const box=$('keyBox');
  box.innerHTML='<div class="key"><div class="small">'+esc(title)+' &mdash; shown only once. Copy it now and send it to them yourself.</div>'+
    '<div>Handle: <b id="kH"></b></div><div>Passcode: <b id="kP"></b></div>'+
    '<div class="row" style="margin-top:8px"><button id="kCopy">Copy</button><button id="kDone" style="background:#3a2a55;color:#e8e0f0">Done</button><span id="kMsg" class="ok"></span></div></div>';
  $('kH').textContent=handle; $('kP').textContent=pass;
  const text='House of the Monarch - Vault key\\nHandle: '+handle+'\\nPasscode: '+pass+'\\nSign in at https://houseofthemonarch.com (VIP Sign-In)';
  $('kCopy').onclick=async()=>{try{await navigator.clipboard.writeText(text);$('kMsg').textContent='Copied.'}catch(e){$('kMsg').textContent='Copy failed - select the text and copy it by hand.'}};
  $('kDone').onclick=()=>{box.innerHTML=''};
  box.scrollIntoView({behavior:'smooth',block:'center'});
}
function pmsg(t,ok){$('patronMsg').className=ok?'ok':'err';$('patronMsg').textContent=t;}
async function loadPatrons(){
  const {items}=await api('/admin/api/patrons');
  const el=$('patronList'); el.innerHTML='';
  if(!items.length){el.innerHTML='<p class="small">No patrons yet.</p>';return;}
  for(const p of items){
    const d=document.createElement('div'); d.className='prow';
    d.innerHTML='<div><b>'+esc(p.handle)+'</b><div class="small">'+esc(p.source||'')+' &middot; added '+esc(p.createdAt)+(p.resetAt?' &middot; key reset '+esc(p.resetAt):'')+'</div></div>'+
      '<div class="row"><button data-reset="'+p.id+'" style="background:#3a2a55;color:#e8e0f0">Reset passcode</button><button data-revoke="'+p.id+'" style="background:#844">Revoke</button></div>';
    d.dataset.handle=p.handle;
    el.appendChild(d);
  }
  el.querySelectorAll('[data-reset]').forEach(b=>b.onclick=async()=>{
    const h=b.closest('.prow').dataset.handle;
    if(!confirm('Make a new passcode for '+h+'? Their old passcode stops working and they are signed out.')) return;
    try{const r=await api('/admin/api/patrons/'+b.dataset.reset+'/reset',{method:'POST',headers:AH,body:'{}'});showKey(r.patron.handle,r.passcode,'New passcode');loadPatrons();}catch(e){pmsg(e.message)}
  });
  el.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{
    const h=b.closest('.prow').dataset.handle;
    if(!confirm('Revoke '+h+'? Their account is deleted and they are signed out right away.')) return;
    try{await api('/admin/api/patrons/'+b.dataset.revoke,{method:'DELETE',headers:AH});pmsg('Revoked '+h+'.',true);loadPatrons();}catch(e){pmsg(e.message)}
  });
}
$('createPatron').onclick=async()=>{
  const handle=$('newHandle').value.trim();
  if(!handle){pmsg('Type a handle first.');return;}
  try{const r=await api('/admin/api/patrons',{method:'POST',headers:AH,body:JSON.stringify({handle})});
    $('newHandle').value=''; pmsg('',true); showKey(r.patron.handle,r.passcode,'New patron created'); loadPatrons();}
  catch(e){pmsg(e.message)}
};
async function loadBanner(){
  const b=await api('/admin/api/banner');
  $('bannerNone').style.display=b.exists?'none':'block';
  $('bannerPreview').style.display=b.exists?'block':'none';
  $('bannerRemove').style.display=b.exists?'inline-block':'none';
  $('bannerMeta').textContent=b.exists?(b.type+' · '+Math.round(b.size/1024)+' KB · uploaded '+b.uploaded):'';
  if(b.exists) $('bannerPreview').src='/banner?v='+Date.now();
}
function bmsg(t,ok){$('bannerMsg').className=ok?'ok':'err';$('bannerMsg').textContent=t;}
$('bannerUpload').onclick=async()=>{
  const f=$('bannerFile').files[0];
  if(!f){bmsg('Pick an image first.');return;}
  if(f.size>5*1024*1024){bmsg('That file is over 5 MB.');return;}
  const fd=new FormData(); fd.append('banner',f);
  bmsg('Uploading…',true);
  try{await api('/admin/api/banner',{method:'POST',headers:{'X-HOTM-Admin':'1'},body:fd});
    bmsg('Banner updated.',true); $('bannerFile').value=''; loadBanner();}
  catch(e){bmsg(e.message)}
};
$('bannerRemove').onclick=async()=>{
  if(!confirm('Remove the banner? The site will show its built-in drawn banner.')) return;
  try{await api('/admin/api/banner',{method:'DELETE',headers:{'X-HOTM-Admin':'1'}});
    bmsg('Banner removed.',true); loadBanner();}
  catch(e){bmsg(e.message)}
};
// ---- Vault media ----
const VEXT={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime'};
function vmsg(t,ok){$('vMsg').className=ok?'ok':'err';$('vMsg').textContent=t;}
function fmtSize(n){return n>=1073741824?(n/1073741824).toFixed(2)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB';}
let vBusy=false,vCancel=false,vXhr=null;
window.addEventListener('beforeunload',e=>{if(vBusy){e.preventDefault();e.returnValue='';}});
function putPart(id,n,blob,onp){
  return new Promise((res,rej)=>{
    const x=new XMLHttpRequest(); vXhr=x;
    x.open('PUT','/admin/api/vault/uploads/'+id+'/part/'+n);
    x.setRequestHeader('X-HOTM-Admin','1');
    x.upload.onprogress=e=>{if(e.lengthComputable)onp(e.loaded)};
    x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch(e){}
      if(x.status===200&&j.etag)res(j.etag);else{const er=new Error(j.error||('HTTP '+x.status));er.fatal=x.status>=400&&x.status<500;rej(er)}};
    x.onerror=()=>rej(new Error('network error'));
    x.onabort=()=>rej(new Error('cancelled'));
    x.send(blob);
  });
}
async function uploadOne(f,title,caption,label){
  const ext=(f.name.split('.').pop()||'').toLowerCase();
  const type=VEXT[ext]||f.type;
  const c=await api('/admin/api/vault/uploads',{method:'POST',headers:AH,body:JSON.stringify({type:type,size:f.size,title:title,caption:caption,name:f.name})});
  const loaded={}; const tags=[];
  const prog=()=>{let s=0;for(const k in loaded)s+=loaded[k];$('vProg').value=s/f.size;
    vmsg(label+' '+Math.floor(100*s/f.size)+'% ('+fmtSize(s)+' of '+fmtSize(f.size)+')',true);};
  async function one(n){
    const blob=f.slice((n-1)*c.partSize,Math.min(n*c.partSize,f.size));
    for(let a=1;;a++){
      if(vCancel) throw new Error('cancelled');
      try{const et=await putPart(c.id,n,blob,l=>{loaded[n]=l;prog()});loaded[n]=blob.size;prog();tags.push({partNumber:n,etag:et});return;}
      catch(e){loaded[n]=0;if(e.fatal||vCancel||a>=4)throw e;await new Promise(r=>setTimeout(r,1500*a));}
    }
  }
  try{
    await one(1); // first piece alone: the server checks the file type before the rest is sent
    let next=2;
    const worker=async()=>{while(next<=c.parts){const n=next++;await one(n);}};
    await Promise.all([worker(),worker(),worker()]);
    vmsg(label+' finishing…',true);
    return await api('/admin/api/vault/uploads/'+c.id+'/complete',{method:'POST',headers:AH,body:JSON.stringify({parts:tags})});
  }catch(e){
    try{await api('/admin/api/vault/uploads/'+c.id,{method:'DELETE',headers:AH});}catch(_){}
    throw e;
  }
}
$('vUpload').onclick=async()=>{
  const files=[...$('vFile').files];
  if(!files.length){vmsg('Pick a photo or video first.');return;}
  for(const f of files){const ext=(f.name.split('.').pop()||'').toLowerCase();
    if(!VEXT[ext]){vmsg(f.name+': only JPEG, PNG, WebP, GIF, MP4, WebM or MOV files.');return;}}
  vBusy=true;vCancel=false;$('vUpload').disabled=true;$('vCancel').style.display='inline-block';$('vProg').style.display='block';
  let ok=0;
  try{
    for(let i=0;i<files.length;i++){
      $('vProg').value=0;
      await uploadOne(files[i],$('vTitle').value,$('vCaption').value,(files.length>1?('('+(i+1)+'/'+files.length+') '):'')+files[i].name);
      ok++;
    }
    vmsg('Done. '+ok+' item'+(ok===1?'':'s')+' added to the Vault.',true);
    $('vFile').value='';$('vTitle').value='';$('vCaption').value='';
  }catch(e){vmsg((ok?ok+' uploaded, then ':'')+(e.message==='cancelled'?'upload cancelled.':'upload failed: '+e.message));}
  vBusy=false;$('vUpload').disabled=false;$('vCancel').style.display='none';$('vProg').style.display='none';
  loadVaultAdmin();
};
$('vCancel').onclick=()=>{vCancel=true;if(vXhr)vXhr.abort();};
async function loadVaultAdmin(){
  const {items}=await api('/admin/api/vault');
  const el=$('vList'); el.innerHTML='';
  if(!items.length){el.innerHTML='<p class="small">No Vault media yet. Patrons see locked placeholder tiles until you add some.</p>';return;}
  for(const it of items){
    const d=document.createElement('div'); d.className='prow'; d.style.display='block';
    const src='/admin/api/vault/'+it.id+'/file';
    d.innerHTML=(it.kind==='video'?'<video controls preload="metadata" playsinline style="max-width:100%;max-height:220px;border-radius:8px" src="'+src+'"></video>'
        :'<img loading="lazy" style="max-height:220px" alt="" src="'+src+'"/>')+
      '<div class="small">'+esc(it.kind)+' &middot; '+esc(it.type)+' &middot; '+fmtSize(it.size)+' &middot; added '+esc(it.createdAt)+'</div>'+
      '<label>Title</label><input data-t maxlength="140" style="width:100%;box-sizing:border-box"/>'+
      '<label>Caption</label><textarea data-c maxlength="1000" rows="2" style="width:100%;box-sizing:border-box"></textarea>'+
      '<div class="row" style="margin-top:8px"><button data-save>Save title &amp; caption</button><button data-del style="background:#844">Delete</button><span data-m class="ok"></span></div>';
    d.querySelector('[data-t]').value=it.title; d.querySelector('[data-c]').value=it.caption;
    d.querySelector('[data-save]').onclick=async()=>{
      try{await api('/admin/api/vault/'+it.id,{method:'PATCH',headers:AH,body:JSON.stringify({title:d.querySelector('[data-t]').value,caption:d.querySelector('[data-c]').value})});
        d.querySelector('[data-m]').textContent='Saved.';}catch(e){d.querySelector('[data-m]').textContent=e.message}
    };
    d.querySelector('[data-del]').onclick=async()=>{
      if(!confirm('Delete '+(it.title||'this '+it.kind)+' from the Vault? This cannot be undone.')) return;
      try{await api('/admin/api/vault/'+it.id,{method:'DELETE',headers:AH});loadVaultAdmin();}catch(e){alert(e.message)}
    };
    el.appendChild(d);
  }
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS" && path === "/apply") {
        const c = cors(env, req);
        return c ? resp(null, 204, c) : resp(null, 403);
      }
      if (path === "/apply" && req.method === "POST") return handleApply(req, env);
      const mm = /^\/patron\/media\/([0-9a-f]{32})$/.exec(path);
      if (mm && (req.method === "GET" || req.method === "HEAD")) return servePatronMedia(req, env, url, mm[1]);
      if (path.startsWith("/patron/")) {
        const c = patronCors(env, req);
        if (req.method === "OPTIONS") return c ? resp(null, 204, c) : resp(null, 403);
        if (!c) return json({ error: "origin not allowed" }, 403);
        if (path === "/patron/login" && req.method === "POST") return patronLogin(req, env, c);
        if (path === "/patron/logout" && req.method === "POST") {
          const s = await checkPatron(env, req);
          if (s) await env.BUCKET.delete(`patrons/sess/${s.patron.id}/${s.sid}`);
          return json({ ok: true }, 200, c);
        }
        if (path === "/patron/vault" && req.method === "GET") {
          const s = await checkPatron(env, req);
          if (!s) return json({ error: "unauthorized" }, 401, c);
          const items = [];
          for (const m of await listVault(env)) items.push({ ...publicItem(m), url: await signedMediaUrl(env, url.origin, m.id, s) });
          return json({ ok: true, handle: s.patron.handle, html: VAULT_HTML, items, expiresIn: VAULT_URL_TTL / 1000 }, 200, c);
        }
        if (path === "/patron/desk-message" && req.method === "POST") return deskMessage(req, env, c, recoveryApi());
        const recoveryRoute = recoveryPaths(path, req.method);
        if (recoveryRoute === "prefetch") return json({ error: "method not allowed" }, 405, c);
        if (recoveryRoute === "request") return recoveryRequest(req, env, c, recoveryApi());
        if (recoveryRoute === "complete") return recoveryComplete(req, env, c, recoveryApi());
        if (recoveryRoute === "enroll") return recoveryEnroll(req, env, c, recoveryApi());
        if (recoveryRoute === "confirm") return recoveryConfirmEmail(req, env, c, recoveryApi());
        return json({ error: "not found" }, 404, c);
      }
      if (path === "/banner" && (req.method === "GET" || req.method === "HEAD")) return serveBanner(env, req.method === "HEAD");
      if (path === "/admin" || path === "/admin/") return resp(ADMIN_HTML, 200, { "Content-Type": "text/html; charset=utf-8" });
      if (path === "/admin/login" && req.method === "POST") {
        try {
          if (await rateLimited(env, req, "login", LOGIN_LIMIT)) return json({ error: "rate limited" }, 429);
          let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
          const okPw = await verifyPassword(env, body.password || "");
          const okTotp = await verifyTotp(env, body.totp || "");
          if (!okPw || !okTotp) return json({ error: "invalid credentials" }, 401);
          const token = await makeSession(env);
          return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
        } catch (e) {
          return json({ error: "login failed" }, 500);
        }
      }
      if (path === "/admin/logout" && req.method === "POST") {
        return json({ ok: true }, 200, { "Set-Cookie": "hotm_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
      }
      const authed = await checkSession(env, req.headers.get("Cookie"));
      if (path.startsWith("/admin/api/") && !authed) return json({ error: "unauthorized" }, 401);
      if (path === "/admin/api/list" && req.method === "GET") return json({ items: await listPending(env) });
      if (path === "/admin/api/decide" && req.method === "POST") {
        if (!sameOriginAdmin(req, url)) return json({ error: "forbidden" }, 403);
        let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        if (!["approved", "rejected"].includes(body.decision)) return json({ error: "bad decision" }, 400);
        let created = null;
        if (body.decision === "approved") {
          const meta = await getMeta(env, String(body.id || ""));
          if (!meta || meta.status !== "pending") return json({ error: "not found" }, 404);
          // verifiedEmail is not taken from the application. Recovery mail uses that field only.
          created = await createPatron(env, String(body.handle || "").trim() || meta.handle || meta.email, "approved application");
          if (created.error) return json({ error: created.error }, 409);
        }
        const kept = await decide(env, body.id, body.decision);
        if (!kept) return json({ error: "not found" }, 404);
        return json({ ok: true, kept, ...(created || {}) });
      }
      if (path === "/admin/api/patrons" && req.method === "GET") return json({ items: await listPatrons(env) });
      const pm = /^\/admin\/api\/patrons(?:\/([0-9a-f]{32}))?(\/reset)?$/.exec(path);
      if (pm && req.method !== "GET") {
        if (!sameOriginAdmin(req, url)) return json({ error: "forbidden" }, 403);
        if (!pm[1] && req.method === "POST") {
          let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
          const r = await createPatron(env, body.handle, "added manually");
          return r.error ? json({ error: r.error }, 409) : json({ ok: true, ...r });
        }
        if (pm[1] && pm[2] && req.method === "POST") {
          const r = await resetPatron(env, pm[1]);
          return r ? json({ ok: true, ...r }) : json({ error: "not found" }, 404);
        }
        if (pm[1] && !pm[2] && req.method === "DELETE") {
          return (await revokePatron(env, pm[1])) ? json({ ok: true }) : json({ error: "not found" }, 404);
        }
        return json({ error: "method not allowed" }, 405);
      }
      if (path === "/admin/api/banner") {
        if (req.method === "GET") return json(await bannerInfo(env));
        if (req.method === "POST" || req.method === "DELETE") {
          if (!sameOriginAdmin(req, url)) return json({ error: "forbidden" }, 403);
          if (req.method === "POST") return uploadBanner(req, env);
          await env.BUCKET.delete(BANNER_KEY);
          return json({ ok: true, exists: false });
        }
        return json({ error: "method not allowed" }, 405);
      }
      if (path === "/admin/api/vault" && req.method === "GET") return json({ items: (await listVault(env)).map(publicItem) });
      if (path.startsWith("/admin/api/vault/")) {
        const vf = /^\/admin\/api\/vault\/([0-9a-f]{32})\/file$/.exec(path);
        if (vf && (req.method === "GET" || req.method === "HEAD")) {
          const m = await getJson(env, vaultMetaKey(vf[1]));
          return m ? serveVaultObject(req, env, m) : resp("not found", 404);
        }
        if (!sameOriginAdmin(req, url)) return json({ error: "forbidden" }, 403);
        if (path === "/admin/api/vault/uploads" && req.method === "POST") return vaultCreateUpload(req, env);
        const vu = /^\/admin\/api\/vault\/uploads\/([0-9a-f]{32})(?:\/(complete|part\/(\d{1,5})))?$/.exec(path);
        if (vu) {
          if (vu[3] && req.method === "PUT") return vaultUploadPart(req, env, vu[1], parseInt(vu[3], 10));
          if (vu[2] === "complete" && req.method === "POST") return vaultComplete(req, env, vu[1]);
          if (!vu[2] && req.method === "DELETE") return json({ ok: await vaultAbort(env, vu[1]) });
          return json({ error: "method not allowed" }, 405);
        }
        const vi = /^\/admin\/api\/vault\/([0-9a-f]{32})$/.exec(path);
        if (vi && req.method === "PATCH") return vaultEdit(req, env, vi[1]);
        if (vi && req.method === "DELETE") return (await vaultDelete(env, vi[1])) ? json({ ok: true }) : json({ error: "not found" }, 404);
        return json({ error: "not found" }, 404);
      }
      const im = /^\/admin\/api\/image\/([0-9a-f]{32})\/(id|selfie)$/.exec(path);
      if (im && req.method === "GET") return serveImage(env, im[1], im[2]);
      if (path === "/health") return json({ ok: true });
      return resp("not found", 404);
    } catch (e) {
      // never include request/file contents
      return json({ error: "server error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOld(env));
    ctx.waitUntil(purgePatronSessions(env));
    ctx.waitUntil(purgeVaultPending(env));
    ctx.waitUntil(purgeRecovery(env));
  },
};

export { PASSCODE_MIN, RECOVERY_TTL_MS };
