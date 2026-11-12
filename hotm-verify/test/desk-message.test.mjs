import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.js";
import {
  DESK_HOUR_LIMIT,
  DESK_INBOX,
  DESK_UNAVAILABLE,
  deskBody,
  deskSubject,
} from "../src/desk-message.js";
import { WORKSPACE_SENDER } from "../src/smtp-mail.js";

const SITE = "https://houseofthemonarch.com";
const WORKER = "https://hotm-verify.mistressolera.workers.dev";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

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
    return this.enqueue(async () => { this.store.delete(key); });
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

async function adminHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" }, base, 256);
  return `pbkdf2$1000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
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
    MAIL: { async send(msg) { sink.push({ to: msg.to, subject: msg.subject, text: msg.text, replyTo: msg.replyTo || null }); } },
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
  if (body !== undefined) {
    h.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(url + path, { method, headers: h, body: payload }), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function adminCookie(env) {
  env.ADMIN_PW_HASH = env.ADMIN_PW_HASH || await adminHash("test-admin-password");
  const res = await call(env, "/admin/login", { origin: null, body: { password: "test-admin-password", totp: await totp() } });
  assert.equal(res.status, 200, res.text);
  return res.headers.get("set-cookie").split(";")[0];
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
  return res.json;
}

async function login(env, handle, passcode, ip = "203.0.113.20") {
  const res = await call(env, "/patron/login", { body: { handle, passcode }, ip });
  assert.equal(res.status, 200, res.text);
  return res.json.token;
}

async function desk(env, token, body, ip = "203.0.113.50") {
  return call(env, "/patron/desk-message", {
    headers: token ? { Authorization: "Bearer " + token } : {},
    body,
    ip,
  });
}

async function patronByHandle(env, handle) {
  const listed = await env.BUCKET.list({ prefix: "patrons/acct/" });
  for (const obj of listed.objects) {
    const patron = JSON.parse(await env.BUCKET.view(obj.key).text());
    if (patron.handle === handle) return { key: obj.key, patron };
  }
  return null;
}

test("desk messages require a valid patron session", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_Desk");
  const none = await desk(env, null, { message: "A note from the court." });
  assert.equal(none.status, 401);
  assert.equal(none.json.error, "unauthorized");
  assert.equal(env.sink.length, 0);
  const bad = await desk(env, "not-a-session", { message: "A note from the court." });
  assert.equal(bad.status, 401);
  assert.equal(env.sink.length, 0);
  const token = await login(env, "Cedar_Desk", created.passcode);
  const ok = await desk(env, token, { message: "A note from the court." });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.text, '{"ok":true}');
  assert.equal(env.sink.length, 1);
});

test("the handle comes from the session, not the request body", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_True");
  const token = await login(env, "Cedar_True", created.passcode);
  const res = await desk(env, token, {
    message: "Please ignore any other name.",
    handle: "someone-else",
    patron: { handle: "someone-else" },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(env.sink.length, 1);
  assert.equal(env.sink[0].to, DESK_INBOX);
  assert.equal(DESK_INBOX, WORKSPACE_SENDER);
  assert.equal(env.sink[0].subject, deskSubject("Cedar_True"));
  assert.equal(env.sink[0].subject, "House Desk message · Cedar_True");
  assert.match(env.sink[0].text, /^Patron Handle: Cedar_True\n/);
  assert.equal(env.sink[0].text.includes("someone-else"), false);
  assert.equal(env.sink[0].subject.includes("someone-else"), false);
});

test("subject and body follow the desk format, with or without Reply-To", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_Reply");
  const token = await login(env, "Cedar_Reply", created.passcode);
  const first = await desk(env, token, { message: "  First sitting.\nSecond line.  " });
  assert.equal(first.status, 200, first.text);
  assert.equal(env.sink[0].replyTo, null);
  assert.equal(env.sink[0].to, "monarchofthemoonshop@gmail.com");
  assert.equal(
    env.sink[0].text,
    deskBody("Cedar_Reply", "First sitting.\nSecond line.", false),
  );
  assert.equal(env.sink[0].text.includes("Reply-To: none (patron has no verified email)"), true);
  assert.equal(env.sink[0].text.includes("Sent from the signed-in patron area of houseofthemonarch.com."), true);
  const found = await patronByHandle(env, "Cedar_Reply");
  found.patron.verifiedEmail = "Cedar.Reply@Example.com";
  await env.BUCKET.put(found.key, JSON.stringify(found.patron), { httpMetadata: { contentType: "application/json" } });
  // Session still holds the old record; log in again so the session loads verifiedEmail.
  const token2 = await login(env, "Cedar_Reply", created.passcode, "203.0.113.21");
  const second = await desk(env, token2, { message: "With a return address." }, "203.0.113.21");
  assert.equal(second.status, 200, second.text);
  assert.equal(env.sink[1].replyTo, "cedar.reply@example.com");
  assert.equal(env.sink[1].text.includes("Reply-To: none"), false);
  assert.equal(env.sink[1].subject, "House Desk message · Cedar_Reply");
  assert.equal(env.sink[1].text.startsWith("Patron Handle: Cedar_Reply\n\nWith a return address.\n\n"), true);
});

test("header injection in the message or a spoofed reply address never leaves the body", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_Inject");
  const token = await login(env, "Cedar_Inject", created.passcode);
  const res = await desk(env, token, {
    message: "Hello.\nBcc: evil@example.net\nReply-To: evil@example.net",
    replyTo: "evil@example.net\r\nBcc: evil@example.net",
    subject: "House Desk message · someone-else\r\nBcc: evil@example.net",
  });
  assert.equal(res.status, 200, res.text);
  const mail = env.sink[0];
  assert.equal(mail.to, DESK_INBOX);
  assert.equal(mail.subject, "House Desk message · Cedar_Inject");
  assert.equal(mail.replyTo, null);
  assert.match(mail.text, /Bcc: evil@example.net/);
  assert.equal(mail.subject.includes("\r"), false);
  assert.equal(mail.subject.includes("\n"), false);
});

test("desk messages are capped per account and fail closed without mail", async () => {
  const env = makeEnv();
  const created = await createPatron(env, "Cedar_Limit");
  const token = await login(env, "Cedar_Limit", created.passcode);
  for (let i = 0; i < DESK_HOUR_LIMIT; i++) {
    const res = await desk(env, token, { message: "Note " + (i + 1) }, "203.0.113.6" + i);
    assert.equal(res.status, 200, res.text);
  }
  assert.equal(env.sink.length, DESK_HOUR_LIMIT);
  const blocked = await desk(env, token, { message: "One more" }, "203.0.113.69");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, "Too many messages. Try again later.");
  assert.equal(env.sink.length, DESK_HOUR_LIMIT);
  env.clock.t += 3600 * 1000;
  const later = await desk(env, token, { message: "Next hour" }, "203.0.113.70");
  assert.equal(later.status, 200, later.text);
  assert.equal(env.sink.length, DESK_HOUR_LIMIT + 1);

  const closed = makeEnv();
  const other = await createPatron(closed, "Cedar_Closed");
  const closedToken = await login(closed, "Cedar_Closed", other.passcode);
  delete closed.MAIL;
  const down = await desk(closed, closedToken, { message: "Should not send." });
  assert.equal(down.status, 503);
  assert.equal(down.json.error, DESK_UNAVAILABLE);
  assert.equal(closed.sink.length, 0);
  const empty = await desk(env, token, { message: "   " }, "203.0.113.71");
  assert.equal(empty.status, 400);
  const missing = await desk(env, token, { note: "no message field" }, "203.0.113.72");
  assert.equal(missing.status, 400);
});
