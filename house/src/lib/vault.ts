import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { type Station } from "@/lib/members";

export type VaultNote = {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type VaultDrop = {
  id: string;
  station: Station;
  title: string;
  kicker: string;
  locked: boolean;
  body: string | null;
};

const RANK: Record<Station, number> = {
  familiar: 0,
  devotee: 1,
  sovereign: 2,
};

const HOUSE_DROPS: Array<{
  id: string;
  station: Station;
  title: string;
  kicker: string;
  body: string;
}> = [
  {
    id: "letter-threshold",
    station: "familiar",
    title: "Letter from the threshold",
    kicker: "New moon",
    body: "You found the door. That is enough for this moon. Keep the house name off careless tongues. When the next letter is cut, it will already know where you sit.",
  },
  {
    id: "sigil-familiar",
    station: "familiar",
    title: "Member sigil",
    kicker: "Familiar",
    body: "Wear the crescent quietly. You are listed. You are not yet in the inner rooms. Service is the only key that turns further.",
  },
  {
    id: "calendar-public",
    station: "familiar",
    title: "Public ritual calendar",
    kicker: "Season",
    body: "New moon letters. Full moon court. Ontario evenings, 18:00–22:00, Wednesday through Saturday. The desk holds the hours. The vault holds the record.",
  },
  {
    id: "inner-rooms",
    station: "devotee",
    title: "Inner rooms",
    kicker: "Devotee",
    body: "The delayed archive is no longer delayed for you. Drops land at the hour they are made. Read them here. Do not screenshot the house into a stranger's camera roll.",
  },
  {
    id: "live-court",
    station: "devotee",
    title: "Live court notes",
    kicker: "This cycle",
    body: "Court is a room, not a broadcast. Arrive on time. Cameras stay down. Release the hour at the desk more than forty-eight hours before, or the deposit stays with the house.",
  },
  {
    id: "print-queue",
    station: "devotee",
    title: "Print queue",
    kicker: "Ontario",
    body: "Signed prints leave Ontario in small numbers. Devotee names are read first. When a canvas is allotted, the house writes here — not on a public listing.",
  },
  {
    id: "private-decree",
    station: "sovereign",
    title: "Private decree",
    kicker: "Sovereign",
    body: "Closest to the throne. You may request a custom rite, a first door, a letter written for one name. The house answers in this vault, never in a crowd.",
  },
  {
    id: "first-doors",
    station: "sovereign",
    title: "First doors",
    kicker: "Held",
    body: "New work is shown to Sovereign before it is shown to the court. What you read here is not yet for Familiar or Devotee. Keep it that way.",
  },
];

export const openVault = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ station: Station; drops: VaultDrop[]; notes: VaultNote[] }> => {
    const sql = await getSql();
    const members = await sql<{ station: string }>`
      select station from members where user_id = ${context.userId}
    `;
    let station: Station = "familiar";
    if (members[0]?.station === "devotee" || members[0]?.station === "sovereign") {
      station = members[0].station;
    } else if (!members[0]) {
      await sql`
        insert into members (user_id, station)
        values (${context.userId}, 'familiar')
        on conflict (user_id) do nothing
      `;
    }
    const rank = RANK[station];
    const drops: VaultDrop[] = HOUSE_DROPS.map((drop) => {
      const locked = RANK[drop.station] > rank;
      return {
        id: drop.id,
        station: drop.station,
        title: drop.title,
        kicker: drop.kicker,
        locked,
        body: locked ? null : drop.body,
      };
    });
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      created_at: string;
      updated_at: string;
    }>`
      select id, title, body, created_at::text as created_at, updated_at::text as updated_at
      from vault_notes
      where user_id = ${context.userId}
      order by id desc
    `;
    const notes: VaultNote[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return { station, drops, notes };
  });

export const saveNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { title: string; body: string }) => {
    const title = input.title.trim().slice(0, 80);
    const body = input.body.trim().slice(0, 4000);
    if (!title) throw new Error("Name the page.");
    return { title, body };
  })
  .handler(async ({ context, data }): Promise<VaultNote> => {
    const sql = await getSql();
    const count = await sql<{ n: number }>`
      select count(*)::int as n from vault_notes where user_id = ${context.userId}
    `;
    if ((count[0]?.n ?? 0) >= 20) {
      throw new Error("Twenty pages is the lockbox limit.");
    }
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      created_at: string;
      updated_at: string;
    }>`
      insert into vault_notes (user_id, title, body)
      values (${context.userId}, ${data.title}, ${data.body})
      returning id, title, body, created_at::text as created_at, updated_at::text as updated_at
    `;
    const row = rows[0];
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

export const updateNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: number; title: string; body: string }) => {
    const title = input.title.trim().slice(0, 80);
    const body = input.body.trim().slice(0, 4000);
    if (!title) throw new Error("Name the page.");
    return { id: input.id, title, body };
  })
  .handler(async ({ context, data }): Promise<VaultNote> => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      created_at: string;
      updated_at: string;
    }>`
      update vault_notes
      set title = ${data.title}, body = ${data.body}, updated_at = now()
      where id = ${data.id} and user_id = ${context.userId}
      returning id, title, body, created_at::text as created_at, updated_at::text as updated_at
    `;
    if (!rows[0]) throw new Error("That page is not in your lockbox.");
    const row = rows[0];
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

export const deleteNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: number) => id)
  .handler(async ({ context, data: id }): Promise<{ id: number }> => {
    const sql = await getSql();
    const rows = await sql<{ id: number }>`
      delete from vault_notes
      where id = ${id} and user_id = ${context.userId}
      returning id
    `;
    if (!rows[0]) throw new Error("That page is not in your lockbox.");
    return { id: rows[0].id };
  });
