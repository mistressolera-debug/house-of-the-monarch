const enc = new TextEncoder();
const dec = new TextDecoder();

export function scriptedSmtp({ failAuth = false, greet = true } = {}) {
  const sent = [];
  let buffer = "";
  let mode = "cmd";
  const pending = [];
  let waiter = null;
  let closed = false;

  function push(text) {
    const bytes = enc.encode(text);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: bytes, done: false });
    } else pending.push(bytes);
  }

  function onLine(line) {
    sent.push(line);
    if (mode === "data") {
      if (line === ".") {
        mode = "cmd";
        push("250 2.0.0 OK\r\n");
      }
      return;
    }
    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO")) push("250-smtp.gmail.com\r\n250 AUTH PLAIN\r\n");
    else if (upper.startsWith("AUTH PLAIN ")) push(failAuth ? "535 5.7.8 no\r\n" : "235 2.7.0 Accepted\r\n");
    else if (upper.startsWith("MAIL FROM:")) push("250 2.1.0 OK\r\n");
    else if (upper.startsWith("RCPT TO:")) push("250 2.1.5 OK\r\n");
    else if (upper === "DATA") {
      mode = "data";
      push("354 Go ahead\r\n");
    } else if (upper === "QUIT") push("221 2.0.0 Bye\r\n");
    else push("500 no\r\n");
  }

  if (greet) push("220 smtp.gmail.com ESMTP\r\n");

  const readable = new ReadableStream({
    pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      if (pending.length) {
        controller.enqueue(pending.shift());
        return;
      }
      return new Promise((resolve) => {
        waiter = (result) => {
          if (result.done || closed) controller.close();
          else controller.enqueue(result.value);
          resolve();
        };
      });
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      buffer += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        onLine(line);
      }
    },
  });
  const calls = [];
  return {
    sent,
    calls,
    connect(address, options) {
      calls.push({ address, options });
      if (options?.secureTransport !== "on" || address?.port === 25) {
        throw new Error("refusing insecure socket");
      }
      return {
        readable,
        writable,
        opened: Promise.resolve({}),
        closed: Promise.resolve(),
        close() {
          closed = true;
          if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve({ done: true });
          }
          return Promise.resolve();
        },
      };
    },
  };
}
