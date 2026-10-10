import { createFileRoute } from "@tanstack/react-router";
import { applyThroneGift, verifyThroneSignature } from "@/lib/throne.server";

export const Route = createFileRoute("/api/throne/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.text();
        const timestamp = request.headers.get("x-signature-timestamp") ?? "";
        const signature = request.headers.get("x-signature-ed25519") ?? "";
        if (!verifyThroneSignature(timestamp, body, signature)) {
          return new Response("unauthorized", { status: 401 });
        }
        try {
          await applyThroneGift(body);
        } catch {
          return new Response("bad payload", { status: 400 });
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
