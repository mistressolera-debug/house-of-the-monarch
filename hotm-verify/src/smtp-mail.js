// Gmail SMTP for the one mailbox the house selected.
// Implicit TLS to smtp.gmail.com:465 via Workers connect({ secureTransport: "on" }).
// Port 25 is refused. AUTH PLAIN is sent only on that TLS socket.
// The From address and AUTH username are fixed. The recipient is the address
// the caller already resolved from the patron record. No Cc, Bcc, or override.

export const WORKSPACE_SENDER = "monarchofthemoonshop@gmail.com";
export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 465;
const TIMEOUT_MS = 12000;
const enc = new TextEncoder();

export function appPassword(env) {
  const raw = String(env.SMTP_APP_PASSWORD || "");
  if (raw.includes("\u0000")) return null;
  // Strip Unicode whitespace (including NBSP and newlines) and zero-width
  // characters often copied from a browser or dashboard paste.
  const compact = raw.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
  if (!/^[A-Za-z]{16}$/.test(compact)) return null;
  return compact;
}

export function workspaceSmtpReady(env) {
  if (!appPassword(env)) return false;
  const user = String(env.SMTP_USER || WORKSPACE_SENDER).trim().toLowerCase();
  return user === WORKSPACE_SENDER;
}

function oneRecipient(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v.length < 6 || v.length > 128) return null;
  if (/[\u0000-\u0020,;<>()[\]\\"]/.test(v)) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v;
}

function safeSubject(value) {
  const subject = String(value || "");
  if (subject.length < 1 || subject.length > 120) return null;
  if (/[\r\n\u0000]/.test(subject)) return null;
  // Printable ASCII, plus the middle dot used in House Desk subjects.
  if (!/^[\x20-\x7E\u00B7]+$/.test(subject)) return null;
  return subject;
}

function safeBody(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8000) return null;
  if (value.includes("\u0000")) return null;
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function dotStuff(text) {
  return text.split("\n").map((line) => (line.startsWith(".") ? "." + line : line)).join("\r\n");
}

function authPlain(user, password) {
  return btoa(`\0${user}\0${password}`);
}

function createReader(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async line() {
      while (true) {
        const idx = buf.indexOf("\r\n");
        if (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) throw smtpError("closed");
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 65536) throw smtpError("overflow");
      }
    },
  };
}

function smtpError(code) {
  const err = new Error("smtp " + code);
  err.code = "smtp";
  return err;
}

async function readReply(lines) {
  const status = [];
  while (status.length < 40) {
    const line = await lines.line();
    const match = /^(\d{3})([ -])/.exec(line);
    if (!match) throw smtpError("reply");
    status.push(match[1]);
    if (match[2] === " ") return Number(match[1]);
  }
  throw smtpError("reply");
}

async function expectCode(lines, wanted) {
  const code = await readReply(lines);
  if (code !== wanted) throw smtpError(code);
}

function messageBytes({ to, subject, text, now, replyTo }) {
  const body = dotStuff(text);
  const date = new Date(now).toUTCString();
  const raw = [
    "From: House of the Monarch <" + WORKSPACE_SENDER + ">",
    "To: <" + to + ">",
    ...(replyTo ? ["Reply-To: <" + replyTo + ">"] : []),
    "Subject: " + subject,
    "Date: " + date,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    ".",
    "",
  ].join("\r\n");
  return enc.encode(raw);
}

async function runSession(socket, { to, subject, text, replyTo, password, now }) {
  const lines = createReader(socket.readable);
  const writer = socket.writable.getWriter();
  const say = async (line) => {
    await writer.write(enc.encode(line + "\r\n"));
  };
  await expectCode(lines, 220);
  await say("EHLO houseofthemonarch.com");
  await expectCode(lines, 250);
  await say("AUTH PLAIN " + authPlain(WORKSPACE_SENDER, password));
  await expectCode(lines, 235);
  await say("MAIL FROM:<" + WORKSPACE_SENDER + ">");
  await expectCode(lines, 250);
  await say("RCPT TO:<" + to + ">");
  await expectCode(lines, 250);
  await say("DATA");
  await expectCode(lines, 354);
  await writer.write(messageBytes({ to, subject, text, now, replyTo }));
  await expectCode(lines, 250);
  await say("QUIT");
  await readReply(lines).catch(() => {});
  await writer.close().catch(() => {});
}

async function defaultConnect(address, options) {
  const { connect } = await import("cloudflare:sockets");
  return connect(address, options);
}

export async function sendWorkspaceMail(env, message) {
  if (!workspaceSmtpReady(env)) throw smtpError("not-configured");
  const to = oneRecipient(message && message.to);
  const subject = safeSubject(message && message.subject);
  const text = safeBody(message && message.text);
  const replyTo = message && message.replyTo != null && message.replyTo !== ""
    ? oneRecipient(message.replyTo)
    : null;
  if ((message && message.replyTo) && !replyTo) throw smtpError("refused");
  if (!to || !subject || text == null) throw smtpError("refused");
  const password = appPassword(env);
  const connect = typeof env.SMTP_CONNECT === "function" ? env.SMTP_CONNECT : defaultConnect;
  const socket = await connect(
    { hostname: SMTP_HOST, port: SMTP_PORT },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const timeoutMs = Number.isFinite(Number(env.SMTP_TIMEOUT_MS)) && Number(env.SMTP_TIMEOUT_MS) > 0
    ? Number(env.SMTP_TIMEOUT_MS)
    : TIMEOUT_MS;
  let timer;
  let settled = false;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close?.().catch(() => {});
        reject(smtpError("timeout"));
      }, timeoutMs);
      runSession(socket, {
        to,
        subject,
        text,
        replyTo,
        password,
        now: typeof env.CLOCK === "function" ? Number(env.CLOCK()) : Date.now(),
      }).then(
        () => { if (!settled) { settled = true; resolve(); } },
        (err) => { if (!settled) { settled = true; reject(err); } },
      );
    });
  } finally {
    clearTimeout(timer);
    await socket.close?.().catch(() => {});
  }
}
