export const HOUSE_TZ = "America/Toronto";
export const OPEN_WEEKDAYS = new Set([3, 4, 5, 6]); // Wed–Sat
export const OPEN_HOUR = 18;
export const CLOSE_HOUR = 22;
export const NOTICE_HOURS = 2;
export const CANCEL_HOURS = 48;
export const HORIZON_DAYS = 21;

export type Duration = "half" | "hour";

export type DeskSlot = {
  startIso: string;
  localDate: string;
  localTime: string;
  weekday: string;
  dayLabel: string;
};

export type HeldInterval = {
  startIso: string;
  duration: Duration;
};

export function durationMs(duration: Duration) {
  return (duration === "hour" ? 60 : 30) * 60 * 1000;
}

export function depositFor(duration: Duration) {
  return duration === "hour" ? { deposit: 200, total: 450 } : { deposit: 100, total: 225 };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function partsInTz(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: HOUSE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const seen = partsInTz(new Date(utcGuess));
  const asLocal = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  return new Date(utcGuess + (desired - asLocal));
}

function monthShort(month: number) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    month - 1
  ];
}

export function describe(date: Date) {
  const p = partsInTz(date);
  return {
    localDate: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    localTime: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday: p.weekday,
    dayLabel: `${p.weekday} ${p.day} ${monthShort(p.month)}`,
  };
}

export function overlaps(aStart: number, aDur: Duration, bStart: number, bDur: Duration) {
  const aEnd = aStart + durationMs(aDur);
  const bEnd = bStart + durationMs(bDur);
  return aStart < bEnd && bStart < aEnd;
}

export function earliestBookable(now = new Date()) {
  return new Date(now.getTime() + NOTICE_HOURS * 60 * 60 * 1000);
}

export function generateOpenStarts(now: Date): Date[] {
  const today = partsInTz(now);
  const starts: Date[] = [];
  for (let offset = 0; offset < HORIZON_DAYS; offset += 1) {
    const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();
    if (!OPEN_WEEKDAYS.has(weekday)) continue;
    for (let hour = OPEN_HOUR; hour < CLOSE_HOUR; hour += 1) {
      for (const minute of [0, 30]) {
        starts.push(zonedLocalToUtc(year, month, day, hour, minute));
      }
    }
  }
  return starts;
}

export function toSlot(date: Date): DeskSlot {
  return { startIso: date.toISOString(), ...describe(date) };
}

export function isHouseStart(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return generateOpenStarts(now).some((start) => start.getTime() === date.getTime());
}

export function slotFits(
  startIso: string,
  duration: Duration,
  taken: HeldInterval[],
  now = new Date(),
) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return false;
  if (start.getTime() < earliestBookable(now).getTime()) return false;
  const p = partsInTz(start);
  const endMinutes = p.hour * 60 + p.minute + (duration === "hour" ? 60 : 30);
  if (endMinutes > CLOSE_HOUR * 60) return false;
  return !taken.some((hold) =>
    overlaps(start.getTime(), duration, new Date(hold.startIso).getTime(), hold.duration),
  );
}
