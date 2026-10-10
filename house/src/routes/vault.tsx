import { type FormEvent, useEffect, useState } from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { type Station } from "@/lib/members";
import {
  type VaultDrop,
  type VaultNote,
  deleteNote,
  openVault,
  saveNote,
  updateNote,
} from "@/lib/vault";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { GoldRule, SectionKicker } from "@/components/landing/marks";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/vault")({ component: VaultPage });

const STATION_NAME: Record<Station, string> = {
  familiar: "Familiar",
  devotee: "Devotee",
  sovereign: "Sovereign",
};

function isUnauthorized(err: unknown) {
  return err instanceof Error && err.message === "Unauthorized";
}

function VaultPage() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <Shell>
        <main className="mx-auto max-w-6xl px-5 pb-20 pt-28">
          <div className="h-48 animate-pulse rounded-xl bg-surface" />
        </main>
      </Shell>
    );
  }
  return <VaultRoom signedIn={Boolean(user)} />;
}

function VaultRoom({ signedIn }: { signedIn: boolean }) {
  const [station, setStation] = useState<Station | null>(null);
  const [drops, setDrops] = useState<VaultDrop[]>([]);
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [openId, setOpenId] = useState<string>("");
  const [loadError, setLoadError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    openVault()
      .then((vault) => {
        if (cancelled) return;
        setStation(vault.station);
        setDrops(vault.drops);
        setNotes(vault.notes);
        setOpenId(vault.drops.find((d) => !d.locked)?.id ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          setUnauthorized(true);
          return;
        }
        setLoadError("The vault could not be opened.");
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  if (unauthorized) return <Navigate to="/login" search={{ next: "/vault" }} />;

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (editing !== null) {
        const row = await updateNote({ data: { id: editing, title, body } });
        setNotes((current) => current.map((item) => (item.id === row.id ? row : item)));
        toast.success("The page is rewritten.");
      } else {
        const row = await saveNote({ data: { title, body } });
        setNotes((current) => [row, ...current]);
        toast.success("The page is locked in.");
      }
      setTitle("");
      setBody("");
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The lockbox did not take it.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: number) {
    setBusy(true);
    try {
      await deleteNote({ data: id });
      setNotes((current) => current.filter((item) => item.id !== id));
      if (editing === id) {
        setEditing(null);
        setTitle("");
        setBody("");
      }
      toast.success("The page is burned.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The page stayed.");
    } finally {
      setBusy(false);
    }
  }

  const selected = drops.find((drop) => drop.id === openId);

  return (
    <Shell>
      <main className="relative isolate starfield min-h-dvh px-5 pb-24 pt-28 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionKicker index="07">Private vault</SectionKicker>
          <div className="mt-5 grid items-end gap-8 lg:grid-cols-[1fr_16rem]">
            <div>
              <h1 className="font-display text-title font-medium text-ivory">
                What the house keeps for you.
              </h1>
              <p className="mt-3 max-w-xl text-muted">
                Letters and drops by station. A lockbox only your key can open.
                Higher rooms stay sealed until the court names you.
              </p>
              <div className="mt-4">
                {station ? <Badge>{STATION_NAME[station]}</Badge> : signedIn ? (
                  <div className="h-8 w-24 animate-pulse rounded-full bg-surface-2" />
                ) : (
                  <Badge>Open door</Badge>
                )}
              </div>
            </div>
            <figure className="relative mx-auto w-full max-w-64">
              <div className="absolute -inset-2 rounded-xl border border-gold/25" />
              <img
                src="/images/house-crest.png"
                alt="The house crest, the real vault mark"
                className="relative w-full rounded-lg bg-bg"
                width={512}
                height={512}
              />
            </figure>
          </div>
          <GoldRule className="mt-8 max-w-48" />

          {loadError ? (
            <p className="mt-8 text-sm text-danger" role="alert">
              {loadError}
            </p>
          ) : null}

          {!signedIn ? (
            <div className="mt-12 rounded-xl border border-line bg-surface p-7 sm:p-8">
              <h2 className="font-display text-2xl text-ivory">The rooms stay with the key.</h2>
              <p className="mt-3 max-w-xl text-sm text-muted">
                The crest is the house. Letters and your lockbox open once you enter.
              </p>
              <Button asChild className="mt-6">
                <a href="/login?next=/vault">Enter</a>
              </Button>
            </div>
          ) : (
          <>
          <div className="mt-12 grid gap-10 lg:grid-cols-[20rem_1fr]">
            <ul className="flex flex-col gap-2">
              {drops.map((drop) => (
                <li key={drop.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(drop.id)}
                    className={cn(
                      "flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left",
                      openId === drop.id
                        ? "border-gold/50 bg-surface text-ivory"
                        : "border-line bg-surface-2 text-muted hover:border-gold/35 hover:text-ivory",
                    )}
                  >
                    <span>
                      <span className="block text-kicker uppercase tracking-luxury text-gold">
                        {drop.kicker}
                      </span>
                      <span className="mt-1 block font-display text-lg text-ivory">{drop.title}</span>
                    </span>
                    {drop.locked ? (
                      <Lock className="size-4 shrink-0 text-subtle" />
                    ) : (
                      <LockOpen className="size-4 shrink-0 text-gold" />
                    )}
                  </button>
                </li>
              ))}
            </ul>

            <article className="rounded-xl border border-line bg-surface p-6 sm:p-8">
              {selected ? (
                selected.locked ? (
                  <>
                    <Badge>Requires {STATION_NAME[selected.station]}</Badge>
                    <h2 className="mt-4 font-display text-3xl text-ivory">{selected.title}</h2>
                    <p className="mt-4 text-muted">
                      This room is closed at your station. Claim a higher seat in the inner
                      court, then return.
                    </p>
                    <Button asChild className="mt-6" variant="outline">
                      <a href="/court">Inner court</a>
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-kicker font-medium uppercase tracking-luxury text-gold">
                      {selected.kicker}
                    </p>
                    <h2 className="mt-3 font-display text-3xl text-ivory">{selected.title}</h2>
                    <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
                      {selected.body}
                    </p>
                  </>
                )
              ) : (
                <p className="text-sm text-subtle">The vault is setting the shelves.</p>
              )}
            </article>
          </div>

          <section className="mt-16">
            <h2 className="font-display text-2xl text-ivory">Your lockbox</h2>
            <p className="mt-2 max-w-xl text-sm text-muted">
              Pages only you can read. Twenty at most. The house does not open them.
            </p>

            <form onSubmit={onSave} className="mt-6 grid gap-3 rounded-xl border border-line bg-surface p-6">
              <div>
                <label htmlFor="vault-title" className="mb-1.5 block text-xs text-subtle">
                  Title
                </label>
                <Input
                  id="vault-title"
                  value={title}
                  maxLength={80}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Name the page"
                  required
                />
              </div>
              <div>
                <label htmlFor="vault-body" className="mb-1.5 block text-xs text-subtle">
                  Page
                </label>
                <textarea
                  id="vault-body"
                  value={body}
                  maxLength={4000}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  placeholder="What you keep."
                  className="flex min-h-32 w-full rounded-md border border-line bg-bg px-4 py-3 text-ivory placeholder:text-subtle focus-visible:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={busy}>
                  {busy ? "Locking…" : editing !== null ? "Rewrite page" : "Lock this page"}
                </Button>
                {editing !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(null);
                      setTitle("");
                      setBody("");
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>

            <ul className="mt-6 flex flex-col gap-3">
              {notes.length === 0 ? (
                <li className="text-sm text-subtle">The lockbox is empty.</li>
              ) : (
                notes.map((note) => (
                  <li
                    key={note.id}
                    className="rounded-lg border border-line bg-surface px-5 py-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="font-display text-xl text-ivory">{note.title}</h3>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{note.body}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setEditing(note.id);
                            setTitle(note.title);
                            setBody(note.body);
                          }}
                        >
                          Rewrite
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void onDelete(note.id)}
                        >
                          Burn
                        </Button>
                      </div>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>
          </>
          )}
        </div>
      </main>
    </Shell>
  );
}
