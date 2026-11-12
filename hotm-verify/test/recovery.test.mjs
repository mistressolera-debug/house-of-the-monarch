import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { test } from "node:test";
import worker, { PASSCODE_MIN, RECOVERY_TTL_MS } from "../src/index.js";
import { scriptedSmtp } from "./scripted-smtp.mjs";
import { WORKSPACE_SENDER } from "../src/smtp-mail.js";

const SITE = "https://houseofthemonarch.com";
const WORKER = "https://hotm-verify.mistressolera.workers.dev";
// Public base32 test vector for the bytes of "Hello!". Not a production seed.
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const KEY_A = "ABCD2345EFGH6789JKLM";
const KEY_B = "ZZZZ9999YYYY8888XXXX";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

class MemoryBucket {
  constructor() {
    this.store = new Map();
    this.chain = Promise.resolve();
  }
  enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => {}, () => {});
    return run;
  }
  async put(key, value, options = {}) {
    return this.enqueue(async () => {
      const cur = this.store.get(key);
      const cond = readCond(options.onlyIf);
      if (cond.none === "*") {
        if (cur) return null;
      } else if (cond.none && cur && (cur.etag === cond.none || cur.httpEtag === cond.none)) {
        return null;
      }
      if (cond.match && (!cur || (cur.etag !== cond.match && cur.httpEtag !== cond.match))) return null;
      const bytes = toBytes(value);
      const etag = createHash("sha256").update(randomBytes(16)).digest("hex");
      const httpEtag = `"${etag}"`;
      const row = {
        bytes,
        etag,
        httpEtag,
        customMetadata: options.customMetadata || {},
        httpMetadata: options.httpMetadata || {},
        uploaded: new Date(),
      };
      this.store.set(key, row);
      return { key, etag, httpEtag, size: bytes.length, customMetadata: row.customMetadata, httpMetadata: row.httpMetadata, uploaded: row.uploaded };
    });
  }
  async get(key) {
    return this.enqueue(async () => this.view(key));
  }
  async head(key) {
    return this.enqueue(async () => {
      const row = this.store.get(key);
      if (!row) return null;
      return { key, size: row.bytes.length, etag: row.etag, httpEtag: row.httpEtag, customMetadata: row.customMetadata, httpMetadata: row.httpMetadata, uploaded: row.uploaded };
    });
  }
  async delete(key) {
    return this.enqueue(async () => {
      this.store.delete(key);
    });
  }
  async list({ prefix = "" } = {}) {
    return this.enqueue(async () => ({
      truncated: false,
      objects: [...this.store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({ key, size: row.bytes.length, customMetadata: row.customMetadata, httpEtag: row.httpEtag, uploaded: row.uploaded })),
    }));
  }
  view(key) {
    const row = this.store.get(key);
    if (!row) return null;
    return {
      key,
      size: row.bytes.length,
      etag: row.etag,
      httpEtag: row.httpEtag,
      customMetadata: row.customMetadata,
      httpMetadata: row.httpMetadata,
      uploaded: row.uploaded,
      text: async () => new TextDecoder().decode(row.bytes),
      arrayBuffer: async () => row.bytes.buffer.slice(row.bytes.byteOffset, row.bytes.byteOffset + row.bytes.byteLength),
    };
  }
}

function readCond(onlyIf) {
  if (!onlyIf) return {};
  if (typeof Headers !== "undefined" && onlyIf instanceof Headers) {
    return { match: onlyIf.get("If-Match"), none: onlyIf.get("If-None-Match") };
  }
  return { match: onlyIf.etagMatches || null, none: onlyIf.etagDoesNotMatch || null };
}
function toBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("unsupported body");
}

async function adminHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" }, base, 256);
  return `pbkdf2$1000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  const out = [];
  s = s.replace(/=+$/, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  for (const c of s) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}
async function totp(step = Math.floor(Date.now() / 1000 / 30)) {
  const key = await crypto.subtle.importKey("raw", base32Decode(TOTP_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, step);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = mac[mac.length - 1] & 0xf;
  const code = ((mac[off] & 0x7f) << 24 | mac[off + 1] << 16 | mac[off + 2] << 8 | mac[off + 3]) % 1e6;
  return String(code).padStart(6, "0");
}

function makeEnv() {
  const sink = [];
  const clock = { t: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const logs = [];
  const env = {
    BUCKET: new MemoryBucket(),
    ALLOWED_ORIGIN: SITE,
    SESSION_KEY: b64(randomBytes(32)),
    ENC_KEY: b64(randomBytes(32)),
    TOTP_SECRET,
    MAIL: { async send(msg) { sink.push({ to: msg.to, subject: msg.subject, text: msg.text }); } },
    CLOCK: () => clock.t,
    sink,
    clock,
    logs,
  };
  return env;
}

async function call(env, path, { method = "POST", origin = SITE, headers = {}, body, ip = "203.0.113.10", url = WORKER } = {}) {
  const h = new Headers(headers);
  if (origin) h.set("Origin", origin);
  h.set("CF-Connecting-IP", ip);
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    h.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const watched = ["log", "info", "warn", "error", "debug"];
  const prev = {};
  for (const name of watched) {
    prev[name] = console[name];
    console[name] = (...args) => { env.logs.push(args.map(String).join(" ")); };
  }
  try {
    const res = await worker.fetch(new Request(url + path, { method, headers: h, body: payload }), env);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, text, json, headers: res.headers };
  } finally {
    for (const name of watched) console[name] = prev[name];
  }
}

function linkToken(text, kind) {
  const name = kind === "email" ? "court-email-verify" : "court-key-reset";
  const match = String(text).match(new RegExp(`https://houseofthemonarch\\.com/#${name}=([A-Za-z0-9_-]{43})`));
  assert.ok(match, "mail did not contain the site link");
  return match[1];
}

async function adminCookie(env) {
  env.ADMIN_PW_HASH = env.ADMIN_PW_HASH || await adminHash("test-admin-password");
  const res = await call(env, "/admin/login", {
    origin: null,
    body: { password: "test-admin-password", totp: await totp() },
  });
  assert.equal(res.status, 200, res.text);
  const cookie = res.headers.get("set-cookie");
  assert.ok(cookie && cookie.startsWith("hotm_admin="));
  return cookie.split(";")[0];
}

async function createPatron(env, handle) {
  const cookie = env.adminCookie || (env.adminCookie = await adminCookie(env));
  const res = await call(env, "/admin/api/patrons", {
    origin: WORKER,
    headers: { Cookie: cookie, "X-HOTM-Admin": "1" },
    body: { handle },
    ip: "203.0.113.4",
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.passcode);
  return res.json;
}

async function login(env, handle, passcode, ip = "203.0.113.20") {
  const res = await call(env, "/patron/login", { body: { handle, passcode }, ip });
  assert.equal(res.status, 200, res.text);
  return res.json.token;
}

async function enroll(env, bearer, email, passcode, ip = "203.0.113.30") {
  const before = env.sink.length;
  const res = await call(env, "/patron/recovery/email", {
    headers: { Authorization: "Bearer " + bearer },
    body: { email, passcode, deliverTo: "other@example.net", to: "other@example.net" },
    ip,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '{"ok":true}');
  assert.equal(env.sink.length, before + 1);
  assert.equal(env.sink.at(-1).to, email.toLowerCase());
  assert.equal(env.sink.at(-1).text.includes("other@example.net"), false);
  return linkToken(env.sink.at(-1).text, "email");
}

async function confirm(env, token, ip = "203.0.113.31") {
  return call(env, "/patron/recovery/email/confirm", { body: { token, email: "attacker@example.net" }, ip });
}

async function verified(env, handle, email) {
  const created = await createPatron(env, handle);
  const bearer = await login(env, handle, created.passcode);
  const token = await enroll(env, bearer, email, created.passcode);
  const done = await confirm(env, token);
  assert.equal(done.status, 200, done.text);
  env.sink.length = 0;
  return { passcode: created.passcode, bearer, email: email.toLowerCase() };
}

async function requestReset(env, handle, extra = {}, ip = "203.0.113.40") {
  return call(env, "/patron/recovery/request", { body: { handle, ...extra }, ip });
}

async function patronRecord(env, handle) {
  const listed = await env.BUCKET.list({ prefix: "patrons/acct/" });
  for (const obj of listed.objects) {
    const row = env.BUCKET.view(obj.key);
    const patron = JSON.parse(await row.text());
    if (patron.handle === handle) return patron;
  }
  return null;
}

test("conditional create accepts one of two concurrent writers", async () => {
  const bucket = new MemoryBucket();
  const [a, b] = await Promise.all([
    bucket.put("claim", "a", { onlyIf: new Headers({ "If-None-Match": "*" }) }),
    bucket.put("claim", "b", { onlyIf: new Headers({ "If-None-Match": "*" }) }),
  ]);
  const wins = [a, b].filter(Boolean);
  assert.equal(wins.length, 1);
  const stored = await (await bucket.get("claim")).text();
  assert.equal(stored, wins[0] === a ? "a" : "b");
});

test("admin sign-in still requires the password and the TOTP", async () => {
  const env = makeEnv();
  env.ADMIN_PW_HASH = await adminHash("test-admin-password");
  const missing = await call(env, "/admin/login", { origin: null, body: { password: "test-admin-password", totp: "" } });
  const wrong = await call(env, "/admin/login", { origin: null, body: { password: "test-admin-password", totp: "000000" } });
  const good = await call(env, "/admin/login", { origin: null, body: { password: "test-admin-password", totp: await totp() } });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(good.status, 200);
  assert.equal(good.json.token, undefined);
});

test("application email is not a recovery address", async () => {
  const env = makeEnv();
  const fd = new FormData();
  fd.set("handle", "Cedar_Apply");
  fd.set("name", "Cedar Apply");
  fd.set("email", "applicant@example.com");
  fd.set("consent", "yes");
  const jpeg = new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], "id.jpg", { type: "image/jpeg" });
  fd.set("id_image", jpeg);
  fd.set("selfie", new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], "selfie.jpg", { type: "image/jpeg" }));
  const applied = await call(env, "/apply", { body: fd, ip: "203.0.113.70" });
  assert.equal(applied.status, 200, applied.text);
  const cookie = await adminCookie(env);
  const decided = await call(env, "/admin/api/decide", {
    origin: WORKER,
    headers: { Cookie: cookie, "X-HOTM-Admin": "1" },
    body: { id: applied.json.id, decision: "approved", handle: "Cedar_Apply" },
    ip: "203.0.113.71",
  });
  assert.equal(decided.status, 200, decided.text);
  const meta = JSON.parse(await (await env.BUCKET.get(`meta/${applied.json.id}.json`)).text());
  assert.equal(meta.email, undefined);
  assert.equal(meta.status, "approved");
  const patron = await patronRecord(env, "Cedar_Apply");
  assert.ok(patron);
  assert.equal(patron.verifiedEmail, undefined);
  assert.equal(patron.email, undefined);
  assert.equal(patron.source, "approved application");
  const reset = await requestReset(env, "Cedar_Apply", { email: "applicant@example.com", to: "applicant@example.com" });
  assert.equal(reset.status, 200);
  assert.equal(reset.text, '{"ok":true}');
  assert.equal(env.sink.length, 0);
});

test("envelope goes only to the verified address and ignores caller routing", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_One", "Cedar.One@Example.com");
  const unknown = await requestReset(env, "Cedar_Missing", { email: "other@example.net" }, "203.0.113.80");
  const unverified = await requestReset(env, "Cedar_Plain", {}, "203.0.113.81");
  await createPatron(env, "Cedar_Plain");
  const still = await requestReset(env, "Cedar_Plain", { email: "plain@example.net" }, "203.0.113.82");
  const sent = await requestReset(env, "Cedar_One", {
    email: "other@example.net",
    to: "other@example.net",
    redirect: "https://evil.example/steal",
    host: "evil.example",
  }, "203.0.113.83");
  assert.equal(unknown.text, sent.text);
  assert.equal(unverified.text, sent.text);
  assert.equal(still.text, sent.text);
  assert.equal(sent.status, 200);
  assert.equal(env.sink.length, 1);
  assert.equal(env.sink[0].to, "cedar.one@example.com");
  assert.equal(env.sink[0].text.includes("other@example.net"), false);
  assert.equal(env.sink[0].text.includes("evil.example"), false);
  assert.equal(sent.headers.get("location"), null);
  assert.equal(sent.text.includes(linkToken(env.sink[0].text, "reset")), false);
  assert.equal(env.logs.some((line) => line.includes(linkToken(env.sink[0].text, "reset"))), false);
});

test("host and redirect input cannot change the link", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Host", "host@example.com");
  const res = await worker.fetch(new Request("https://evil.example/patron/recovery/request", {
    method: "POST",
    headers: {
      Origin: SITE,
      "Content-Type": "application/json",
      "X-Forwarded-Host": "evil.example",
      "X-Forwarded-Proto": "http",
      Forwarded: "host=evil.example",
      "CF-Connecting-IP": "203.0.113.90",
    },
    body: JSON.stringify({ handle: "Cedar_Host", redirect: "https://evil.example/out", email: "evil@example.net" }),
  }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.equal(env.sink.length, 1);
  assert.equal(env.sink[0].to, "host@example.com");
  assert.match(env.sink[0].text, /https:\/\/houseofthemonarch\.com\/#court-key-reset=[A-Za-z0-9_-]{43}/);
  assert.equal(env.sink[0].text.includes("evil.example"), false);
});

test("reset updates the court key, revokes sessions and old links, and keeps approval", async () => {
  const env = makeEnv();
  const account = await verified(env, "Cedar_Reset", "reset@example.com");
  const oldBearer = await login(env, "Cedar_Reset", account.passcode, "203.0.113.21");
  const vaultBefore = await call(env, "/patron/vault", { method: "GET", headers: { Authorization: "Bearer " + oldBearer } });
  assert.equal(vaultBefore.status, 200);
  const asked = await requestReset(env, "Cedar_Reset");
  assert.equal(asked.text, '{"ok":true}');
  const token = linkToken(env.sink[0].text, "reset");
  const prefetch = await call(env, "/patron/recovery/complete?token=" + token, { method: "GET", ip: "203.0.113.41" });
  const head = await call(env, "/patron/recovery/complete?token=" + token, { method: "HEAD", ip: "203.0.113.42" });
  assert.equal(prefetch.status, 405);
  assert.equal(head.status, 405);
  const weak = await call(env, "/patron/recovery/complete", { body: { token, passcode: "short-key" }, ip: "203.0.113.43" });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error, "Court key must be at least 20 letters or numbers.");
  const done = await call(env, "/patron/recovery/complete", {
    body: { token, passcode: KEY_A, email: "attacker@example.net", accountId: "ab".repeat(16), redirect: "https://evil.example" },
    ip: "203.0.113.44",
  });
  assert.equal(done.status, 200);
  assert.equal(done.text, '{"ok":true}');
  assert.equal(done.text.includes(token), false);
  assert.equal(done.headers.get("set-cookie"), null);
  const replay = await call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_B }, ip: "203.0.113.45" });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, "That link is not valid.");
  const oldLogin = await call(env, "/patron/login", { body: { handle: "Cedar_Reset", passcode: account.passcode }, ip: "203.0.113.22" });
  assert.equal(oldLogin.status, 401);
  const vaultAfter = await call(env, "/patron/vault", { method: "GET", headers: { Authorization: "Bearer " + oldBearer } });
  assert.equal(vaultAfter.status, 401);
  const fresh = await login(env, "Cedar_Reset", KEY_A, "203.0.113.23");
  const vaultNew = await call(env, "/patron/vault", { method: "GET", headers: { Authorization: "Bearer " + fresh } });
  assert.equal(vaultNew.status, 200);
  assert.equal(vaultNew.json.handle, "Cedar_Reset");
  const patron = await patronRecord(env, "Cedar_Reset");
  assert.equal(patron.source, "added manually");
  assert.equal(patron.verifiedEmail, "reset@example.com");
  assert.equal(patron.recoveryGen, 3);
  assert.equal(patron.sessionGen, 1);
  const sessions = await env.BUCKET.list({ prefix: `patrons/sess/${patron.id}/` });
  assert.equal(sessions.objects.length, 1);
});

test("one token cannot be redeemed twice at the same time", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Race", "race@example.com");
  await requestReset(env, "Cedar_Race", {}, "203.0.113.100");
  const token = linkToken(env.sink[0].text, "reset");
  const [a, b] = await Promise.all([
    call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_A }, ip: "203.0.113.101" }),
    call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_B }, ip: "203.0.113.102" }),
  ]);
  const wins = [a, b].filter((res) => res.status === 200);
  assert.equal(wins.length, 1);
  assert.equal([a, b].filter((res) => res.status === 400).length, 1);
  const again = await call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_A }, ip: "203.0.113.103" });
  assert.equal(again.status, 400);
  const loginA = await call(env, "/patron/login", { body: { handle: "Cedar_Race", passcode: KEY_A }, ip: "203.0.113.104" });
  const loginB = await call(env, "/patron/login", { body: { handle: "Cedar_Race", passcode: KEY_B }, ip: "203.0.113.105" });
  assert.equal([loginA.status, loginB.status].filter((status) => status === 200).length, 1);
});

test("expired, tampered, reused, and wrong-purpose tokens are rejected", async () => {
  const env = makeEnv();
  const account = await verified(env, "Cedar_Edge", "edge@example.com");
  await requestReset(env, "Cedar_Edge", {}, "203.0.113.110");
  const token = linkToken(env.sink[0].text, "reset");
  const tampered = token.slice(0, 10) + (token[10] === "a" ? "b" : "a") + token.slice(11);
  const bad = await call(env, "/patron/recovery/complete", { body: { token: tampered, passcode: KEY_A }, ip: "203.0.113.111" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "That link is not valid.");
  const malformed = await call(env, "/patron/recovery/complete", { body: { token: "not-a-token", passcode: KEY_A }, ip: "203.0.113.112" });
  assert.equal(malformed.json.error, "That link is not valid.");
  env.clock.t += RECOVERY_TTL_MS;
  const boundary = await call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_A }, ip: "203.0.113.113" });
  assert.equal(boundary.status, 400);
  env.clock.t -= 1;
  const inside = await call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_A }, ip: "203.0.113.114" });
  assert.equal(inside.status, 200, inside.text);
  const loginOld = await call(env, "/patron/login", { body: { handle: "Cedar_Edge", passcode: account.passcode }, ip: "203.0.113.115" });
  assert.equal(loginOld.status, 401);
  assert.equal(PASSCODE_MIN, 20);
});

test("an enrollment token cannot reset a court key, and a reset token cannot verify mail", async () => {
  const env = makeEnv();
  const account = await verified(env, "Cedar_Purpose", "purpose@example.com");
  const bearer = await login(env, "Cedar_Purpose", account.passcode, "203.0.113.24");
  env.sink.length = 0;
  const emailToken = await enroll(env, bearer, "next@example.com", account.passcode, "203.0.113.32");
  const asReset = await call(env, "/patron/recovery/complete", { body: { token: emailToken, passcode: KEY_A }, ip: "203.0.113.120" });
  assert.equal(asReset.status, 400);
  const confirmed = await confirm(env, emailToken, "203.0.113.33");
  assert.equal(confirmed.status, 200, confirmed.text);
  const patron = await patronRecord(env, "Cedar_Purpose");
  assert.equal(patron.verifiedEmail, "next@example.com");
  const still = await login(env, "Cedar_Purpose", account.passcode, "203.0.113.25");
  const vault = await call(env, "/patron/vault", { method: "GET", headers: { Authorization: "Bearer " + still } });
  assert.equal(vault.status, 200);
  env.sink.length = 0;
  await requestReset(env, "Cedar_Purpose", {}, "203.0.113.121");
  const resetToken = linkToken(env.sink[0].text, "reset");
  const asEmail = await call(env, "/patron/recovery/email/confirm", { body: { token: resetToken }, ip: "203.0.113.34" });
  assert.equal(asEmail.status, 400);
  const after = await patronRecord(env, "Cedar_Purpose");
  assert.equal(after.verifiedEmail, "next@example.com");
});

test("confirming a new address retires an outstanding reset link", async () => {
  const env = makeEnv();
  const account = await verified(env, "Cedar_Rotate", "first@example.com");
  await requestReset(env, "Cedar_Rotate", {}, "203.0.113.130");
  const oldLink = linkToken(env.sink[0].text, "reset");
  const bearer = await login(env, "Cedar_Rotate", account.passcode, "203.0.113.26");
  const emailToken = await enroll(env, bearer, "second@example.com", account.passcode, "203.0.113.35");
  assert.equal((await confirm(env, emailToken, "203.0.113.36")).status, 200);
  const retired = await call(env, "/patron/recovery/complete", { body: { token: oldLink, passcode: KEY_A }, ip: "203.0.113.131" });
  assert.equal(retired.status, 400);
  env.sink.length = 0;
  await requestReset(env, "Cedar_Rotate", { email: "first@example.com" }, "203.0.113.132");
  assert.equal(env.sink.length, 1);
  assert.equal(env.sink[0].to, "second@example.com");
});

test("admin reset invalidates a recovery link and does not reveal it", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Admin", "adminpat@example.com");
  await requestReset(env, "Cedar_Admin", {}, "203.0.113.140");
  const token = linkToken(env.sink[0].text, "reset");
  const patron = await patronRecord(env, "Cedar_Admin");
  const cookie = env.adminCookie;
  const reset = await call(env, `/admin/api/patrons/${patron.id}/reset`, {
    origin: WORKER,
    headers: { Cookie: cookie, "X-HOTM-Admin": "1" },
    body: {},
    ip: "203.0.113.141",
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.text.includes(token), false);
  const blocked = await call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_A }, ip: "203.0.113.142" });
  assert.equal(blocked.status, 400);
  const withAdminKey = await call(env, "/patron/login", { body: { handle: "Cedar_Admin", passcode: reset.json.passcode }, ip: "203.0.113.143" });
  assert.equal(withAdminKey.status, 200);
});

test("unknown and known handles share a throttle response", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Limit", "limit@example.com");
  env.sink.length = 0;
  const bodies = [];
  for (let i = 0; i < 5; i++) {
    const res = await requestReset(env, "No_Such_Patron", {}, "203.0.113.150");
    bodies.push(res.text);
    assert.equal(res.status, 200);
  }
  const limitedUnknown = await requestReset(env, "No_Such_Patron", {}, "203.0.113.150");
  const limitedKnown = await requestReset(env, "Cedar_Limit", { email: "limit@example.com" }, "203.0.113.150");
  assert.equal(limitedUnknown.status, 429);
  assert.equal(limitedKnown.status, 429);
  assert.equal(limitedUnknown.text, limitedKnown.text);
  assert.equal(limitedUnknown.text, '{"error":"Too many attempts. Try again later."}');
  assert.equal(env.sink.length, 0);
  assert.equal(new Set(bodies).size, 1);
});

test("mail and origin configuration fail closed without enumerating", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Silent", "silent@example.com");
  env.sink.length = 0;
  env.MAIL = undefined;
  const noMail = await requestReset(env, "Cedar_Silent", {}, "203.0.113.170");
  const unknown = await requestReset(env, "Nobody_Here", {}, "203.0.113.171");
  assert.equal(noMail.text, unknown.text);
  assert.equal(noMail.text, '{"ok":true}');
  const keys = await env.BUCKET.list({ prefix: "patrons/recovery/" });
  assert.equal(keys.objects.length, 0);
  env.MAIL = { async send(msg) { env.sink.push(msg); } };
  env.ALLOWED_ORIGIN = "http://houseofthemonarch.com";
  delete env.CANONICAL_ORIGIN;
  const insecure = await call(env, "/patron/recovery/request", {
    origin: "http://houseofthemonarch.com",
    body: { handle: "Cedar_Silent" },
    ip: "203.0.113.172",
  });
  assert.equal(insecure.text, '{"ok":true}');
  assert.equal(env.sink.length, 0);
});

test("expired recovery records are purged and live accounts are not", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Purge", "purge@example.com");
  await requestReset(env, "Cedar_Purge", {}, "203.0.113.180");
  const token = linkToken(env.sink[0].text, "reset");
  env.clock.t += RECOVERY_TTL_MS + 1;
  await requestReset(env, "Cedar_Purge", {}, "203.0.113.181");
  const live = linkToken(env.sink.at(-1).text, "reset");
  const jobs = [];
  await worker.scheduled({}, env, { waitUntil(job) { jobs.push(job); } });
  await Promise.all(jobs);
  const gone = await call(env, "/patron/recovery/complete", { body: { token, passcode: KEY_A }, ip: "203.0.113.182" });
  assert.equal(gone.status, 400);
  env.clock.t += 1;
  const kept = await call(env, "/patron/recovery/complete", { body: { token: live, passcode: KEY_A }, ip: "203.0.113.183" });
  assert.equal(kept.status, 200, kept.text);
  assert.ok(await patronRecord(env, "Cedar_Purge"));
});

test("enrollment requires a patron session and does not grant the Vault", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_Enroll");
  const anon = await call(env, "/patron/recovery/email", { body: { email: "enroll@example.com" }, ip: "203.0.113.190" });
  assert.equal(anon.status, 401);
  assert.equal(env.sink.length, 0);
  const bearer = await login(env, "Cedar_Enroll", created.passcode, "203.0.113.27");
  const bad = await call(env, "/patron/recovery/email", {
    headers: { Authorization: "Bearer " + bearer },
    body: { email: "not an email" },
    ip: "203.0.113.191",
  });
  assert.equal(bad.status, 400);
  const token = await enroll(env, bearer, "enroll@example.com", created.passcode, "203.0.113.37");
  const vault = await call(env, "/patron/vault", { method: "GET", headers: { Authorization: "Bearer " + token } });
  assert.notEqual(vault.status, 200);
  const wrongKey = await call(env, "/patron/recovery/email", {
    headers: { Authorization: "Bearer " + bearer },
    body: { email: "other@example.com", passcode: "not-the-court-key" },
    ip: "203.0.113.192",
  });
  assert.equal(wrongKey.status, 401);
  assert.equal(env.sink.length, 1);
  const foreign = await call(env, "/patron/recovery/email", {
    origin: "https://evil.example",
    headers: { Authorization: "Bearer " + bearer },
    body: { email: "other@example.com", passcode: created.passcode },
    ip: "203.0.113.193",
  });
  assert.equal(foreign.status, 403);
  assert.equal(env.sink.length, 1);
});

test("two reset links for one account produce one new court key", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Links", "links@example.com");
  await requestReset(env, "Cedar_Links", {}, "203.0.113.220");
  await requestReset(env, "Cedar_Links", {}, "203.0.113.221");
  const first = linkToken(env.sink[0].text, "reset");
  const second = linkToken(env.sink[1].text, "reset");
  assert.notEqual(first, second);
  const [a, b] = await Promise.all([
    call(env, "/patron/recovery/complete", { body: { token: first, passcode: KEY_A }, ip: "203.0.113.222" }),
    call(env, "/patron/recovery/complete", { body: { token: second, passcode: KEY_B }, ip: "203.0.113.223" }),
  ]);
  assert.equal([a, b].filter((res) => res.status === 200).length, 1);
  assert.equal([a, b].filter((res) => res.status === 400).length, 1);
  const loginA = await call(env, "/patron/login", { body: { handle: "Cedar_Links", passcode: KEY_A }, ip: "203.0.113.224" });
  const loginB = await call(env, "/patron/login", { body: { handle: "Cedar_Links", passcode: KEY_B }, ip: "203.0.113.225" });
  assert.equal([loginA.status, loginB.status].filter((status) => status === 200).length, 1);
});

test("a loaded email confirmation cannot replace the address after a reset", async () => {
  const env = makeEnv();
  const account = await verified(env, "Cedar_Stale", "stale@example.com");
  const bearer = await login(env, "Cedar_Stale", account.passcode, "203.0.113.230");
  const token = await enroll(env, bearer, "later@example.com", account.passcode, "203.0.113.231");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const arrivedP = new Promise((resolve) => { arrived = resolve; });
  env.BARRIER = async (name) => {
    if (name !== "confirm:loaded") return;
    arrived();
    await gate;
  };
  const pending = confirm(env, token, "203.0.113.232");
  await arrivedP;
  const before = await patronRecord(env, "Cedar_Stale");
  const reset = await call(env, `/admin/api/patrons/${before.id}/reset`, {
    origin: WORKER,
    headers: { Cookie: env.adminCookie, "X-HOTM-Admin": "1" },
    body: {},
    ip: "203.0.113.233",
  });
  assert.equal(reset.status, 200, reset.text);
  release();
  const done = await pending;
  assert.equal(done.status, 400);
  assert.equal(done.text.includes(token), false);
  assert.equal(done.text.includes("later@example.com"), false);
  const after = await patronRecord(env, "Cedar_Stale");
  assert.equal(after.verifiedEmail, "stale@example.com");
  assert.notEqual(after.hash, before.hash);
});

test("a loaded confirmation loses to a newer enrollment", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_Newer");
  const bearer = await login(env, "Cedar_Newer", created.passcode, "203.0.113.240");
  const older = await enroll(env, bearer, "older@example.com", created.passcode, "203.0.113.241");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const arrivedP = new Promise((resolve) => { arrived = resolve; });
  env.BARRIER = async (name) => {
    if (name !== "confirm:loaded") return;
    arrived();
    await gate;
  };
  const pending = confirm(env, older, "203.0.113.242");
  await arrivedP;
  const newer = await enroll(env, bearer, "newer@example.com", created.passcode, "203.0.113.243");
  release();
  const lost = await pending;
  assert.equal(lost.status, 400);
  env.BARRIER = null;
  const won = await confirm(env, newer, "203.0.113.244");
  assert.equal(won.status, 200, won.text);
  const patron = await patronRecord(env, "Cedar_Newer");
  assert.equal(patron.verifiedEmail, "newer@example.com");
  const vault = await call(env, "/patron/vault", { method: "GET", headers: { Authorization: "Bearer " + bearer } });
  assert.equal(vault.status, 200);
});

test("a court key accepted before reset cannot open a usable session", async () => {
  const env = makeEnv();
  const account = await verified(env, "Cedar_Session", "session@example.com");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const arrivedP = new Promise((resolve) => { arrived = resolve; });
  env.BARRIER = async (name) => {
    if (name !== "login:before-session") return;
    arrived();
    await gate;
  };
  const loginP = call(env, "/patron/login", {
    body: { handle: "Cedar_Session", passcode: account.passcode },
    ip: "203.0.113.250",
  });
  await arrivedP;
  await requestReset(env, "Cedar_Session", {}, "203.0.113.251");
  const resetToken = linkToken(env.sink.at(-1).text, "reset");
  const reset = await call(env, "/patron/recovery/complete", {
    body: { token: resetToken, passcode: KEY_A },
    ip: "203.0.113.252",
  });
  assert.equal(reset.status, 200, reset.text);
  release();
  const stale = await loginP;
  assert.equal(stale.status, 200, stale.text);
  const vault = await call(env, "/patron/vault", {
    method: "GET",
    headers: { Authorization: "Bearer " + stale.json.token },
  });
  assert.equal(vault.status, 401);
  const hijack = await call(env, "/patron/recovery/email", {
    headers: { Authorization: "Bearer " + stale.json.token },
    body: { email: "hijack@example.com", passcode: account.passcode },
    ip: "203.0.113.253",
  });
  assert.equal(hijack.status, 401);
  assert.equal(env.sink.filter((msg) => msg.to === "hijack@example.com").length, 0);
  env.BARRIER = null;
  const bearer = await login(env, "Cedar_Session", KEY_A, "203.0.113.254");
  const enrolled = await enroll(env, bearer, "fresh@example.com", KEY_A, "203.0.113.255");
  env.BARRIER = null;
  assert.equal((await confirm(env, enrolled, "203.0.113.249")).status, 200);
  const patron = await patronRecord(env, "Cedar_Session");
  assert.equal(patron.verifiedEmail, "fresh@example.com");
});

test("malformed recovery bodies do not 500 or echo a token", async () => {
  const env = makeEnv();
  const shapes = [null, [], "string", 4, { token: null }, { token: ["secret-token"] }, { token: { raw: "secret-token" } }, { handle: null }];
  for (const body of shapes) {
    const requested = await call(env, "/patron/recovery/request", { body, ip: "203.0.113.60" });
    const completed = await call(env, "/patron/recovery/complete", { body, ip: "203.0.113.61" });
    assert.notEqual(requested.status, 500, requested.text);
    assert.notEqual(completed.status, 500, completed.text);
    assert.equal(requested.text.includes("secret-token"), false);
    assert.equal(completed.text.includes("secret-token"), false);
    assert.equal(env.logs.some((line) => line.includes("secret-token")), false);
  }
});

test("recovery attempts stay capped when reads are stale", async () => {
  const env = makeEnv();
  const bucket = new MemoryBucket();
  const innerGet = bucket.get.bind(bucket);
  bucket.get = async (key) => {
    const view = await innerGet(key);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return view;
  };
  env.BUCKET = bucket;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => requestReset(env, "Nobody_Race", {}, "203.0.113.77")),
  );
  const allowed = results.filter((res) => res.status === 200);
  const blocked = results.filter((res) => res.status === 429);
  assert.equal(allowed.length, 5);
  assert.equal(blocked.length, 3);
  assert.equal(env.sink.length, 0);
  assert.ok(results.every((res) => res.text === allowed[0].text || res.text === blocked[0].text));
});

test("workerd R2 binding gives one winner for the same key", async (t) => {
  let Miniflare;
  try {
    ({ Miniflare } = await import("miniflare"));
  } catch {
    t.skip("miniflare is not installed in this package");
    return;
  }
  const mf = new Miniflare({
    modules: true,
    script: `
      export default {
        async fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path === "/once") {
            const [a, b] = await Promise.all([
              env.BUCKET.put("once", "a", { onlyIf: new Headers({ "If-None-Match": "*" }) }),
              env.BUCKET.put("once", "b", { onlyIf: new Headers({ "If-None-Match": "*" }) }),
            ]);
            return Response.json({ wins: [a, b].filter(Boolean).length });
          }
          if (path === "/keys") {
            const [a, b] = await Promise.all([
              env.BUCKET.put("token-a", "a", { onlyIf: new Headers({ "If-None-Match": "*" }) }),
              env.BUCKET.put("token-b", "b", { onlyIf: new Headers({ "If-None-Match": "*" }) }),
            ]);
            return Response.json({ a: Boolean(a), b: Boolean(b) });
          }
          await env.BUCKET.put("acct", "0");
          const current = await env.BUCKET.get("acct");
          const etag = current.httpEtag || current.etag;
          const [a, b] = await Promise.all([
            env.BUCKET.put("acct", "1", { onlyIf: new Headers({ "If-Match": String(etag) }) }),
            env.BUCKET.put("acct", "2", { onlyIf: new Headers({ "If-Match": String(etag) }) }),
          ]);
          return Response.json({ wins: [a, b].filter(Boolean).length });
        }
      }
    `,
    r2Buckets: ["BUCKET"],
  });
  try {
    const once = await (await mf.dispatchFetch("http://example.com/once")).json();
    const keys = await (await mf.dispatchFetch("http://example.com/keys")).json();
    const match = await (await mf.dispatchFetch("http://example.com/match")).json();
    assert.equal(once.wins, 1);
    assert.equal(keys.a && keys.b, true);
    assert.equal(match.wins, 1);
  } finally {
    await mf.dispose();
  }
});

test("a configured Workspace SMTP socket mails only the verified patron", async () => {
  const env = makeEnv();
  await verified(env, "Cedar_Smtp", "smtp-patron@example.com");
  env.MAIL = undefined;
  env.SMTP_APP_PASSWORD = "abcdefghijklmnop";
  const server = scriptedSmtp();
  env.SMTP_CONNECT = (address, options) => server.connect(address, options);
  const res = await requestReset(env, "Cedar_Smtp", {
    email: "other@example.net",
    to: "attacker@example.net",
  }, "203.0.113.90");
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"ok":true}');
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].options.secureTransport, "on");
  assert.equal(server.calls[0].address.port, 465);
  assert.deepEqual(
    server.sent.filter((line) => line.startsWith("RCPT TO:")),
    ["RCPT TO:<smtp-patron@example.com>"],
  );
  assert.ok(server.sent.includes("MAIL FROM:<" + WORKSPACE_SENDER + ">"));
  assert.equal(server.sent.join("\n").includes("attacker@example.net"), false);
  assert.equal(server.sent.join("\n").includes("other@example.net"), false);
  assert.equal(res.text.includes("abcdefghijklmnop"), false);
  assert.equal(env.logs.some((line) => line.includes("abcdefghijklmnop") || line.includes("court-key-reset")), false);
  const before = await env.BUCKET.list({ prefix: "patrons/recovery/" });
  const failed = scriptedSmtp({ failAuth: true });
  env.SMTP_CONNECT = (address, options) => failed.connect(address, options);
  const again = await requestReset(env, "Cedar_Smtp", {}, "203.0.113.91");
  assert.equal(again.text, '{"ok":true}');
  assert.equal(again.text.includes("smtp 535"), false);
  const after = await env.BUCKET.list({ prefix: "patrons/recovery/" });
  assert.equal(after.objects.length, before.objects.length);
});
