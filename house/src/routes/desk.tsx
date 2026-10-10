import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  type BookingRecord,
  type DeskSlot,
  type Duration,
  type HeldInterval,
  cancelBooking,
  confirmTribute,
  createBooking,
  listDesk,
  listMyBookings,
} from "@/lib/bookings";
import { CANCEL_HOURS, depositFor, slotFits } from "@/lib/desk-slots";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GoldRule, SectionKicker } from "@/components/landing/marks";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/desk")({ component: DeskPage });

function isUnauthorized(err: unknown) {
  return err instanceof Error && err.message === "Unauthorized";
}

function DeskPage() {
  const { user, isPending } = useCurrentUserState();
  const [slots, setSlots] = useState<DeskSlot[]>([]);
  const [taken, setTaken] = useState<HeldInterval[]>([]);
  const [mine, setMine] = useState<BookingRecord[]>([]);
  const [loadError, setLoadError] = useState("");
  const [duration, setDuration] = useState<Duration>("hour");
  const [day, setDay] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function refresh() {
    return listDesk()
      .then((desk) => {
        setSlots(desk.slots);
        setTaken(desk.taken);
        setDay((current) => current || desk.slots[0]?.localDate || "");
      })
      .catch(() => {
        setLoadError("The desk could not be opened.");
      });
  }

  useEffect(() => {
    let cancelled = false;
    listDesk()
      .then((desk) => {
        if (cancelled) return;
        setSlots(desk.slots);
        setTaken(desk.taken);
        setDay(desk.slots[0]?.localDate ?? "");
      })
      .catch(() => {
        if (!cancelled) setLoadError("The desk could not be opened.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isPending || !user) {
      setMine([]);
      return;
    }
    let cancelled = false;
    listMyBookings()
      .then((rows) => {
        if (!cancelled) setMine(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled && !isUnauthorized(err)) {
          toast.error("Your hours could not be read.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, isPending]);

  const days = useMemo(() => {
    const seen = new Map<string, DeskSlot>();
    for (const slot of slots) {
      if (!seen.has(slot.localDate)) seen.set(slot.localDate, slot);
    }
    return [...seen.values()];
  }, [slots]);

  const daySlots = useMemo(
    () => slots.filter((slot) => slot.localDate === day),
    [slots, day],
  );

  const selectedSlot = slots.find((slot) => slot.startIso === selected);
  const selectedOpen = selected ? slotFits(selected, duration, taken) : false;
  const money = depositFor(duration);
  const activeMine = mine.filter(
    (row) =>
      (row.status === "held" || row.status === "pending") && new Date(row.startIso) > new Date(),
  );

  async function book() {
    if (!selected || !selectedOpen) return;
    setBusy(true);
    try {
      const row = await createBooking({
        data: { startIso: selected, duration, note },
      });
      setMine((current) => [row, ...current.filter((item) => item.id !== row.id)]);
      setNote("");
      setSelected("");
      await refresh();
      toast.success("The hour is reserved. Send the deposit on Throne.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The desk did not take the hour.");
    } finally {
      setBusy(false);
    }
  }

  async function release(id: number) {
    setBusy(true);
    try {
      const row = await cancelBooking({ data: id });
      setMine((current) => current.map((item) => (item.id === id ? row : item)));
      await refresh();
      toast.success("The hour is returned to the desk.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The hour could not be released.");
    } finally {
      setBusy(false);
    }
  }

  async function markTribute(id: number) {
    setBusy(true);
    try {
      const row = await confirmTribute({ data: id });
      setMine((current) => current.map((item) => (item.id === id ? row : item)));
      await refresh();
      toast.success("The house will match the tribute on Throne.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The desk could not mark the tribute.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Tribute code copied.");
    } catch {
      toast.error("Copy the code by hand.");
    }
  }

  return (
    <Shell>
      <main className="relative isolate starfield min-h-dvh px-5 pb-24 pt-28 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionKicker index="06">Booking desk</SectionKicker>
          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="font-display text-title font-medium text-ivory">
                Choose an hour with the house.
              </h1>
              <p className="mt-3 max-w-xl text-muted">
                In person, Ontario, 18+. Wednesdays through Saturdays, 18:00–22:00.
                Book up to two hours before. Deposit is tribute on Throne.
              </p>
            </div>
            <Badge>America / Toronto</Badge>
          </div>
          <GoldRule className="mt-8 max-w-48" />

          {loadError ? (
            <p className="mt-8 text-sm text-danger" role="alert">
              {loadError}
            </p>
          ) : null}

          <div
            className="mt-10 inline-flex rounded-md border border-line bg-surface p-1"
            role="group"
            aria-label="Length"
          >
            <button
              type="button"
              aria-pressed={duration === "half"}
              onClick={() => setDuration("half")}
              className={cn(
                "min-h-11 rounded-sm px-4 text-sm",
                duration === "half" ? "bg-gold text-bg" : "text-subtle hover:text-ivory",
              )}
            >
              Half hour · $225
            </button>
            <button
              type="button"
              aria-pressed={duration === "hour"}
              onClick={() => setDuration("hour")}
              className={cn(
                "min-h-11 rounded-sm px-4 text-sm",
                duration === "hour" ? "bg-gold text-bg" : "text-subtle hover:text-ivory",
              )}
            >
              One hour · $450
            </button>
          </div>

          <div className="mt-8 flex gap-3 overflow-x-auto pb-2">
            {days.map((item) => (
              <button
                key={item.localDate}
                type="button"
                onClick={() => {
                  setDay(item.localDate);
                  setSelected("");
                }}
                className={cn(
                  "min-h-16 shrink-0 rounded-lg border px-4 py-3 text-left",
                  day === item.localDate
                    ? "border-gold/50 bg-surface text-ivory"
                    : "border-line bg-surface-2 text-muted hover:border-gold/35 hover:text-ivory",
                )}
              >
                <span className="block text-kicker uppercase tracking-luxury text-gold">
                  {item.weekday}
                </span>
                <span className="mt-1 block font-display text-xl">{item.dayLabel.replace(/^[A-Za-z]{3} /, "")}</span>
              </button>
            ))}
          </div>

          <ul className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {daySlots.map((slot) => {
              const open = slotFits(slot.startIso, duration, taken);
              const mineHere = activeMine.some(
                (row) => row.startIso === slot.startIso && row.status === "held",
              );
              const active = selected === slot.startIso;
              return (
                <li key={slot.startIso}>
                  <button
                    type="button"
                    disabled={!open}
                    onClick={() => setSelected(slot.startIso)}
                    className={cn(
                      "flex min-h-12 w-full items-center justify-center rounded-md border text-sm tracking-wide",
                      !open && "cursor-not-allowed border-line bg-bg text-subtle",
                      open && !active && "border-line bg-surface text-ivory hover:border-gold/50",
                      active && "border-gold bg-gold text-bg",
                      mineHere && !active && "border-gold/40 text-gold",
                    )}
                  >
                    {slot.localTime}
                    {mineHere ? " · yours" : !open ? " · held" : ""}
                  </button>
                </li>
              );
            })}
          </ul>

          {daySlots.length === 0 && !loadError ? (
            <p className="mt-8 text-sm text-subtle">The desk is setting the hours.</p>
          ) : null}

          <section className="mt-10 rounded-xl border border-line bg-surface p-6 sm:p-8">
            {selectedSlot && selectedOpen ? (
              <>
                <h2 className="font-display text-2xl text-ivory">Reserve this hour</h2>
                <p className="mt-2 text-sm text-muted">
                  {selectedSlot.dayLabel} at {selectedSlot.localTime} ·{" "}
                  {duration === "hour" ? "one hour" : "half hour"} · ${money.deposit} tribute on
                  Throne, of ${money.total}
                </p>
                <label htmlFor="desk-note" className="mt-5 mb-1.5 block text-xs text-subtle">
                  Note for the house
                </label>
                <input
                  id="desk-note"
                  value={note}
                  maxLength={280}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Where you are coming from. Optional."
                  className="flex h-12 w-full rounded-md border border-line bg-bg px-4 text-ivory placeholder:text-subtle focus-visible:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                />
                {user ? (
                  <Button className="mt-5" disabled={busy} onClick={() => void book()}>
                    {busy ? "Reserving…" : "Reserve this hour"}
                  </Button>
                ) : (
                  <Button asChild className="mt-5">
                    <Link to="/login" search={{ next: "/desk" }}>
                      Member login to hold
                    </Link>
                  </Button>
                )}
              </>
            ) : (
              <>
                <h2 className="font-display text-2xl text-ivory">An hour is not yet chosen.</h2>
                <p className="mt-2 text-sm text-muted">
                  Pick a day, then a time. The deposit is tribute on Throne — $100 for a half
                  hour, $200 for an hour — and is applied to the audience. Remaining balance is
                  due in person, in cash.
                </p>
              </>
            )}
          </section>

          {user ? (
            <section className="mt-12">
              <h2 className="font-display text-2xl text-ivory">Hours in your name</h2>
              <ul className="mt-5 flex flex-col gap-3">
                {activeMine.length === 0 ? (
                  <li className="text-sm text-subtle">The desk holds nothing for you yet.</li>
                ) : (
                  activeMine.map((row) => {
                    const pending = row.status === "pending";
                    const canRelease =
                      pending ||
                      new Date(row.startIso).getTime() - Date.now() > CANCEL_HOURS * 60 * 60 * 1000;
                    return (
                      <li
                        key={row.id}
                        className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-5 py-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="font-display text-xl text-ivory">
                              {row.dayLabel} · {row.localTime}
                            </p>
                            <p className="mt-1 text-xs text-gold">
                              {row.duration === "hour" ? "One hour" : "Half hour"} · $
                              {row.deposit} tribute
                              {row.note ? ` · ${row.note}` : ""}
                            </p>
                            {pending ? (
                              <p className="mt-2 max-w-md text-sm text-muted">
                                Put this code in the Throne gift message so the desk can match
                                it:{" "}
                                <span className="font-mono text-gold">{row.tributeCode}</span>
                              </p>
                            ) : (
                              <p className="mt-2 text-sm text-muted">
                                Tribute marked. Remaining balance is cash in Ontario.
                              </p>
                            )}
                          </div>
                          {canRelease ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void release(row.id)}
                            >
                              Release
                            </Button>
                          ) : (
                            <p className="text-xs text-subtle">
                              Inside 48 hours. The house keeps it.
                            </p>
                          )}
                        </div>
                        {pending ? (
                          <div className="flex flex-wrap gap-2">
                            <Button asChild>
                              <a href={row.throneUrl} rel="noreferrer" target="_blank">
                                Pay ${row.deposit} on Throne
                              </a>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void copyCode(row.tributeCode)}
                            >
                              Copy code
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void markTribute(row.id)}
                            >
                              Tribute is sent
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
            </section>
          ) : null}
        </div>
      </main>
    </Shell>
  );
}
