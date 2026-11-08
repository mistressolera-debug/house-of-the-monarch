import assert from "node:assert/strict";
import { test } from "node:test";
import { sendWorkspaceMail, WORKSPACE_SENDER } from "../src/smtp-mail.js";
import { scriptedSmtp } from "./scripted-smtp.mjs";

const PASS = "abcdefghijklmnop";
const TO = "patron@example.com";

function envWith(server, extra = {}) {
  return {
    SMTP_APP_PASSWORD: PASS,
    SMTP_CONNECT: (address, options) => server.connect(address, options),
    CLOCK: () => Date.UTC(2026, 10, 8, 15, 0, 0),
    ...extra,
  };
}

const message = {
  to: TO,
  subject: "House of the Monarch court key",
  text: "Open this link:\nhttps://houseofthemonarch.com/#court-key-reset=abc\n.not-a-command\n",
};

test("implicit TLS SMTP sends only as the selected mailbox to the given recipient", async () => {
  const server = scriptedSmtp();
  await sendWorkspaceMail(envWith(server), message);
  assert.equal(server.calls.length, 1);
  assert.deepEqual(server.calls[0].address, { hostname: "smtp.gmail.com", port: 465 });
  assert.equal(server.calls[0].options.secureTransport, "on");
  const auth = server.sent.find((line) => line.startsWith("AUTH PLAIN "));
  const decoded = Buffer.from(auth.slice("AUTH PLAIN ".length), "base64").toString("utf8");
  assert.equal(decoded, "\0" + WORKSPACE_SENDER + "\0" + PASS);
  const rest = server.sent.filter((line) => !line.startsWith("AUTH PLAIN ")).join("\n");
  assert.equal(rest.includes(PASS), false);
  assert.equal(server.sent.filter((line) => line.startsWith("RCPT TO:")).length, 1);
  assert.ok(server.sent.includes("RCPT TO:<" + TO + ">"));
  assert.ok(server.sent.includes("MAIL FROM:<" + WORKSPACE_SENDER + ">"));
  assert.ok(server.sent.includes("..not-a-command"));
  assert.equal(server.sent.some((line) => line.startsWith("Cc:") || line.startsWith("Bcc:")), false);
});

test("missing, mismatched, or injected credentials never open a socket", async () => {
  const cases = [
    { SMTP_APP_PASSWORD: "" },
    { SMTP_APP_PASSWORD: "short" },
    { SMTP_APP_PASSWORD: "abcd efgh ijkl mnop\r\n" },
    { SMTP_APP_PASSWORD: PASS, SMTP_USER: "other@example.com" },
  ];
  for (const extra of cases) {
    const server = scriptedSmtp();
    await assert.rejects(
      sendWorkspaceMail({ ...envWith(server), ...extra }, message),
      (err) => err.message === "smtp not-configured" && !err.message.includes(PASS),
    );
    assert.equal(server.calls.length, 0);
  }
});

test("header injection and extra recipients are refused before connect", async () => {
  const bad = [
    { ...message, to: "patron@example.com\r\nRCPT TO:<evil@example.com>" },
    { ...message, to: "a@example.com,b@example.com" },
    { ...message, subject: "Court key\r\nBcc: evil@example.com" },
  ];
  for (const item of bad) {
    const server = scriptedSmtp();
    await assert.rejects(sendWorkspaceMail(envWith(server), item), /smtp refused/);
    assert.equal(server.calls.length, 0);
  }
});

test("an SMTP rejection does not echo the app password", async () => {
  const server = scriptedSmtp({ failAuth: true });
  await assert.rejects(sendWorkspaceMail(envWith(server), message), (err) => {
    assert.equal(err.message, "smtp 535");
    assert.equal(err.message.includes(PASS), false);
    return true;
  });
});

test("a silent server times out and closes the socket", async () => {
  const server = scriptedSmtp({ greet: false });
  let closed = false;
  const original = server.connect.bind(server);
  server.connect = (address, options) => {
    const socket = original(address, options);
    const close = socket.close.bind(socket);
    socket.close = () => {
      closed = true;
      return close();
    };
    return socket;
  };
  await assert.rejects(
    sendWorkspaceMail({ ...envWith(server), SMTP_TIMEOUT_MS: 30 }, message),
    (err) => err.message === "smtp timeout" && !err.message.includes(PASS),
  );
  assert.equal(closed, true);
  assert.equal(server.calls[0].options.secureTransport, "on");
});
