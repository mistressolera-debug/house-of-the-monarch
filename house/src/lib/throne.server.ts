import { createPublicKey, verify } from "node:crypto";
import { getSql } from "@/lib/db";
import { overlaps, type Duration } from "@/lib/desk-slots";
import { THRONE_USERNAME, tributeCodePattern } from "@/lib/throne";

const THRONE_KEY = createPublicKey({
  key: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPXbUfxh7XL4SYUVcfhmYMIbxvtR9E9LDd8gPJ1PwSD8=
-----END PUBLIC KEY-----`,
  format: "pem",
});

export function verifyThroneSignature(timestamp: string, body: string, signatureHex: string) {
  if (!/^\d+$/.test(timestamp)) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 60 * 24) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return verify(null, Buffer.from(`${timestamp}.${body}`), THRONE_KEY, signature);
  } catch {
    return false;
  }
}

type ThroneEnvelope = {
  event_id?: string;
  event_type?: string;
  data?: {
    creator_username?: string;
    message?: string;
    item_name?: string;
    price?: number;
    amount?: number;
    currency?: string;
  };
};

function centsFrom(data: ThroneEnvelope["data"]) {
  const value = data?.amount ?? data?.price;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function applyThroneGift(body: string): Promise<{ ok: true; matched: boolean }> {
  let payload: ThroneEnvelope;
  try {
    payload = JSON.parse(body) as ThroneEnvelope;
  } catch {
    throw new Error("Bad payload");
  }
  const data = payload.data ?? {};
  const username = (data.creator_username ?? "").toLowerCase();
  if (username && username !== THRONE_USERNAME) {
    return { ok: true, matched: false };
  }
  const code = (data.message ?? "").toUpperCase().match(tributeCodePattern())?.[0];
  if (!code) return { ok: true, matched: false };
  const cents = centsFrom(data);
  const sql = await getSql();
  const rows = await sql<{
    id: number;
    deposit_cents: number;
    status: string;
    starts_at: string;
    duration: string;
  }>`
    select id, deposit_cents, status, starts_at::text as starts_at, duration
    from bookings
    where tribute_code = ${code}
  `;
  const row = rows[0];
  if (!row) return { ok: true, matched: false };
  if (row.status === "held") return { ok: true, matched: true };
  if (row.status !== "pending") return { ok: true, matched: false };
  if (cents < row.deposit_cents) return { ok: true, matched: false };
  const others = await sql<{ starts_at: string; duration: string }>`
    select starts_at::text as starts_at, duration
    from bookings
    where status = 'held' and id <> ${row.id}
  `;
  const mine: Duration = row.duration === "hour" ? "hour" : "half";
  const blocked = others.some((other) =>
    overlaps(
      new Date(row.starts_at).getTime(),
      mine,
      new Date(other.starts_at).getTime(),
      other.duration === "hour" ? "hour" : "half",
    ),
  );
  if (blocked) return { ok: true, matched: false };
  const eventId = payload.event_id ?? `gift-${code}-${Date.now()}`;
  await sql`
    update bookings
    set status = 'held',
        tribute_event_id = ${eventId},
        tribute_sent_at = now()
    where id = ${row.id} and status = 'pending'
  `;
  return { ok: true, matched: true };
}
