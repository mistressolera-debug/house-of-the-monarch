// Signed-in "Write to the House" desk messages.
// The handle comes only from the patron session. The recipient is a fixed
// mailbox. Court keys, session tokens, IDs, and IPs are never mailed.

import { sendWorkspaceMail, workspaceSmtpReady, WORKSPACE_SENDER } from "./smtp-mail.js";

export const DESK_INBOX = WORKSPACE_SENDER;
export const DESK_HOUR_LIMIT = 5;
export const DESK_DAY_LIMIT = 20;
export const DESK_MESSAGE_MAX = 2000;
export const DESK_UNAVAILABLE = "The desk can't take messages right now.";
const DESK_FOOTER = "Sent from the signed-in patron area of houseofthemonarch.com.";
const NO_REPLY = "Reply-To: none (patron has no verified email)";

const enc = new TextEncoder();
const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");

function nowMs(env) {
  return typeof env.CLOCK === "function" ? Number(env.CLOCK()) : Date.now();
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function textField(record, key) {
  const value = record && record[key];
  return typeof value === "string" ? value : "";
}

export function deskHandle(value) {
  const handle = String(value || "");
  if (!handle || /[\r\n\u0000]/.test(handle)) return null;
  if (!/^[A-Za-z0-9_.@+\- ]{2,64}$/.test(handle)) return null;
  return handle;
}

export function deskMessageText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text || text.length > DESK_MESSAGE_MAX) return null;
  return text;
}

export function deskSubject(handle) {
  return "House Desk message · " + handle;
}

export function deskBody(handle, message, hasVerified) {
  const lines = ["Patron Handle: " + handle];
  if (!hasVerified) lines.push(NO_REPLY);
  lines.push("", message, "", DESK_FOOTER);
  return lines.join("\n");
}

export function deskReplyTo(patron) {
  const email = String(patron && patron.verifiedEmail || "").trim().toLowerCase();
  if (!email) return null;
  if (/[\r\n\u0000,;<>()[\]\\"]/.test(email)) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  return email;
}

async function limitedWindow(env, kind, material, limit, windowMs) {
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

async function sendDesk(env, message) {
  const payload = { to: message.to, subject: message.subject, text: message.text };
  if (message.replyTo) payload.replyTo = message.replyTo;
  if (typeof env.MAIL?.send === "function") {
    await env.MAIL.send(payload);
    return;
  }
  await sendWorkspaceMail(env, payload);
}

function mailReady(env) {
  return typeof env.MAIL?.send === "function" || workspaceSmtpReady(env);
}

export async function deskMessage(req, env, c, api) {
  const session = await api.checkPatron(env, req);
  if (!session) return api.json({ error: "unauthorized" }, 401, c);
  let body;
  try { body = await req.json(); } catch { return api.json({ error: "bad request" }, 400, c); }
  const record = asRecord(body);
  if (!record) return api.json({ error: "bad request" }, 400, c);
  const message = deskMessageText(textField(record, "message"));
  if (!message) return api.json({ error: "bad request" }, 400, c);
  const handle = deskHandle(session.patron && session.patron.handle);
  if (!handle) return api.json({ error: DESK_UNAVAILABLE }, 503, c);
  if (!mailReady(env)) return api.json({ error: DESK_UNAVAILABLE }, 503, c);
  if (await limitedWindow(env, "desk-hour", session.patron.id, DESK_HOUR_LIMIT, 3600 * 1000)) {
    return api.json({ error: "Too many messages. Try again later." }, 429, c);
  }
  if (await limitedWindow(env, "desk-day", session.patron.id, DESK_DAY_LIMIT, 24 * 3600 * 1000)) {
    return api.json({ error: "Too many messages. Try again later." }, 429, c);
  }
  const replyTo = deskReplyTo(session.patron);
  try {
    await sendDesk(env, {
      to: DESK_INBOX,
      subject: deskSubject(handle),
      text: deskBody(handle, message, !!replyTo),
      replyTo: replyTo || undefined,
    });
  } catch {
    return api.json({ error: DESK_UNAVAILABLE }, 503, c);
  }
  return api.json({ ok: true }, 200, c);
}
