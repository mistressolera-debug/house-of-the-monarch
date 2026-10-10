import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";

export const STATIONS = ["familiar", "devotee", "sovereign"] as const;
export type Station = (typeof STATIONS)[number];

export type MemberRecord = {
  userId: string;
  station: Station;
  createdAt: string;
};

export type AudienceRecord = {
  id: number;
  duration: "half" | "hour";
  note: string;
  createdAt: string;
};

function asStation(value: string): Station {
  if (value === "familiar" || value === "devotee" || value === "sovereign") return value;
  return "familiar";
}

export const getMember = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<MemberRecord> => {
    const sql = await getSql();
    const existing = await sql<{ user_id: string; station: string; created_at: string }>`
      select user_id, station, created_at::text as created_at
      from members
      where user_id = ${context.userId}
    `;
    if (existing[0]) {
      return {
        userId: existing[0].user_id,
        station: asStation(existing[0].station),
        createdAt: existing[0].created_at,
      };
    }
    await sql`
      insert into members (user_id, station)
      values (${context.userId}, 'familiar')
      on conflict (user_id) do nothing
    `;
    const created = await sql<{ user_id: string; station: string; created_at: string }>`
      select user_id, station, created_at::text as created_at
      from members
      where user_id = ${context.userId}
    `;
    const row = created[0];
    return {
      userId: row.user_id,
      station: asStation(row.station),
      createdAt: row.created_at,
    };
  });

export const setStation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((station: string) => asStation(station))
  .handler(async ({ context, data: station }): Promise<MemberRecord> => {
    const sql = await getSql();
    const rows = await sql<{ user_id: string; station: string; created_at: string }>`
      insert into members (user_id, station)
      values (${context.userId}, ${station})
      on conflict (user_id) do update set station = excluded.station
      returning user_id, station, created_at::text as created_at
    `;
    const row = rows[0];
    return {
      userId: row.user_id,
      station: asStation(row.station),
      createdAt: row.created_at,
    };
  });

export const listAudiences = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AudienceRecord[]> => {
    const sql = await getSql();
    const rows = await sql<{ id: number; duration: string; note: string; created_at: string }>`
      select id, duration, note, created_at::text as created_at
      from audience_requests
      where user_id = ${context.userId}
      order by id desc
    `;
    return rows.map((row) => ({
      id: row.id,
      duration: row.duration === "hour" ? "hour" : "half",
      note: row.note,
      createdAt: row.created_at,
    }));
  });

export const requestAudience = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { duration: string; note: string }) => {
    const duration = input.duration === "hour" ? "hour" : "half";
    return { duration, note: input.note.trim().slice(0, 280) };
  })
  .handler(async ({ context, data }): Promise<AudienceRecord> => {
    const sql = await getSql();
    const rows = await sql<{ id: number; duration: string; note: string; created_at: string }>`
      insert into audience_requests (user_id, duration, note)
      values (${context.userId}, ${data.duration}, ${data.note})
      returning id, duration, note, created_at::text as created_at
    `;
    const row = rows[0];
    return {
      id: row.id,
      duration: row.duration === "hour" ? "hour" : "half",
      note: row.note,
      createdAt: row.created_at,
    };
  });
