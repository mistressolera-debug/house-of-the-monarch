import { randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env.server";
import { THRONE_HALF_URL, THRONE_HOUR_URL } from "@/lib/throne";
import {
  type DeskSlot,
  type Duration,
  type HeldInterval,
  depositFor,
  describe,
  generateOpenStarts,
  isHouseStart,
  slotFits,
  toSlot,
  CANCEL_HOURS,
} from "@/lib/desk-slots";

export type { DeskSlot, Duration, HeldInterval };

export type BookingStatus = "pending" | "held" | "cancelled";

export type BookingRecord = {
  id: number;
  startIso: string;
  duration: Duration;
  status: BookingStatus;
  note: string;
  tributeCode: string;
  deposit: number;
  throneUrl: string;
  localDate: string;
  localTime: string;
  weekday: string;
  dayLabel: string;
};

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function asStatus(value: string): BookingStatus {
  if (value === "pending" || value === "held" || value === "cancelled") return value;
  return "held";
}

function newTributeCode() {
  const bytes = randomBytes(4);
  let code = "DESK-";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function throneUrlFor(duration: Duration) {
  const keyed = duration === "hour" ? env("THRONE_HOUR_URL") : env("THRONE_HALF_URL");
  if (keyed) return keyed;
  return duration === "hour" ? THRONE_HOUR_URL : THRONE_HALF_URL;
}

function toBooking(row: {
  id: number;
  starts_at: string;
  duration: string;
  status: string;
  note: string;
  tribute_code: string | null;
  deposit_cents: number | null;
}): BookingRecord {
  const start = new Date(row.starts_at);
  const duration: Duration = row.duration === "hour" ? "hour" : "half";
  return {
    id: row.id,
    startIso: start.toISOString(),
    duration,
    status: asStatus(row.status),
    note: row.note,
    tributeCode: row.tribute_code ?? "",
    deposit: Math.round((row.deposit_cents ?? 0) / 100),
    throneUrl: throneUrlFor(duration),
    ...describe(start),
  };
}

type BookingRow = {
  id: number;
  starts_at: string;
  duration: string;
  status: string;
  note: string;
  tribute_code: string | null;
  deposit_cents: number | null;
};

async function expireStalePending() {
  const sql = await getSql();
  await sql`
    update bookings
    set status = 'cancelled'
    where status = 'pending'
      and created_at < now() - interval '60 minutes'
  `;
}

export const listDesk = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ slots: DeskSlot[]; taken: HeldInterval[] }> => {
    await expireStalePending();
    const sql = await getSql();
    const rows = await sql<{ starts_at: string; duration: string }>`
      select starts_at::text as starts_at, duration
      from bookings
      where status = 'held' and starts_at > now()
    `;
    const taken: HeldInterval[] = rows.map((row) => ({
      startIso: new Date(row.starts_at).toISOString(),
      duration: row.duration === "hour" ? "hour" : "half",
    }));
    return { slots: generateOpenStarts(new Date()).map(toSlot), taken };
  },
);

export const listMyBookings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<BookingRecord[]> => {
    await expireStalePending();
    const sql = await getSql();
    const rows = await sql<BookingRow>`
      select id, starts_at::text as starts_at, duration, status, note,
             tribute_code, deposit_cents
      from bookings
      where user_id = ${context.userId}
      order by starts_at desc
    `;
    return rows.map(toBooking);
  });

export const createBooking = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { startIso: string; duration: string; note: string }) => {
    const duration: Duration = input.duration === "hour" ? "hour" : "half";
    if (!isHouseStart(input.startIso)) throw new Error("That hour is not on the desk.");
    return { startIso: input.startIso, duration, note: input.note.trim().slice(0, 280) };
  })
  .handler(async ({ context, data }): Promise<BookingRecord> => {
    await expireStalePending();
    const sql = await getSql();
    const held = await sql<{ starts_at: string; duration: string }>`
      select starts_at::text as starts_at, duration
      from bookings
      where status = 'held' and starts_at > now()
    `;
    const taken: HeldInterval[] = held.map((row) => ({
      startIso: new Date(row.starts_at).toISOString(),
      duration: row.duration === "hour" ? "hour" : "half",
    }));
    if (!slotFits(data.startIso, data.duration, taken)) {
      throw new Error("That hour is already held, or it is less than two hours away.");
    }
    const upcoming = await sql<{ n: number }>`
      select count(*)::int as n
      from bookings
      where user_id = ${context.userId}
        and status in ('held', 'pending')
        and starts_at > now()
    `;
    if ((upcoming[0]?.n ?? 0) >= 3) {
      throw new Error("Three hours is the most the desk will hold for one name.");
    }
    const money = depositFor(data.duration);
    const depositCents = money.deposit * 100;
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = newTributeCode();
      try {
        const rows = await sql<BookingRow>`
          insert into bookings (user_id, starts_at, duration, note, status, tribute_code, deposit_cents)
          values (
            ${context.userId},
            ${data.startIso},
            ${data.duration},
            ${data.note},
            'pending',
            ${code},
            ${depositCents}
          )
          returning id, starts_at::text as starts_at, duration, status, note,
                    tribute_code, deposit_cents
        `;
        return toBooking(rows[0]);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The desk could not mint a tribute code.");
  });

export const confirmTribute = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: number) => id)
  .handler(async (): Promise<BookingRecord> => {
    throw new Error("The hour is held when Throne confirms the deposit.");
  });

export const cancelBooking = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: number) => id)
  .handler(async ({ context, data: id }): Promise<BookingRecord> => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      starts_at: string;
      duration: string;
      status: string;
      note: string;
      tribute_code: string | null;
      deposit_cents: number | null;
    }>`
      select id, starts_at::text as starts_at, duration, status, note,
             tribute_code, deposit_cents
      from bookings
      where id = ${id} and user_id = ${context.userId}
    `;
    const row = rows[0];
    if (!row) throw new Error("The desk does not have that hour under your name.");
    if (row.status === "held" && new Date(row.starts_at).getTime() < Date.now() + CANCEL_HOURS * 60 * 60 * 1000) {
      throw new Error("Less than 48 hours. The house keeps the hour.");
    }
    const updated = await sql<BookingRow>`
      update bookings
      set status = 'cancelled'
      where id = ${id}
        and user_id = ${context.userId}
        and status in ('held', 'pending')
      returning id, starts_at::text as starts_at, duration, status, note,
                tribute_code, deposit_cents
    `;
    if (!updated[0]) throw new Error("That hour was already released.");
    return toBooking(updated[0]);
  });
