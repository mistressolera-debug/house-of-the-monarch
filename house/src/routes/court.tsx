import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { type MemberRecord, type Station, getMember, setStation } from "@/lib/members";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUser, useCurrentUserState } from "@/lib/auth/use-current-user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GoldRule, SectionKicker } from "@/components/landing/marks";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/court")({ component: CourtPage });

const STATION_COPY: Record<
  Station,
  { name: string; blurb: string; featured: boolean }
> = {
  familiar: {
    name: "Familiar",
    blurb: "A seat at the threshold. Enough to know the moon is watching.",
    featured: false,
  },
  devotee: {
    name: "Devotee",
    blurb: "The station most of the court keeps. Depth without spectacle.",
    featured: true,
  },
  sovereign: {
    name: "Sovereign",
    blurb: "Closest to the throne. Private decree, first doors, custom rites.",
    featured: false,
  },
};

function isUnauthorized(err: unknown) {
  return err instanceof Error && err.message === "Unauthorized";
}

function CourtPage() {
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
  if (!user) return <RedirectToSignIn />;
  return <CourtRoom />;
}

function CourtRoom() {
  const user = useCurrentUser();
  const [member, setMember] = useState<MemberRecord | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState<Station | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMember()
      .then((nextMember) => {
        if (cancelled) return;
        setMember(nextMember);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          setUnauthorized(true);
          return;
        }
        setLoadError("The court could not be opened. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unauthorized) return <RedirectToSignIn />;

  async function claim(station: Station) {
    setSaving(station);
    try {
      const next = await setStation({ data: station });
      setMember(next);
      toast.success(`${STATION_COPY[station].name} is now your station.`);
    } catch (err) {
      if (isUnauthorized(err)) {
        setUnauthorized(true);
        return;
      }
      toast.error("The station could not be claimed.");
    } finally {
      setSaving(null);
    }
  }

  const greeting = user?.displayName ?? user?.primaryEmail ?? "member";

  return (
    <Shell>
      <main className="relative isolate starfield min-h-dvh px-5 pb-24 pt-28 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionKicker index="00">Inner court</SectionKicker>
          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="font-display text-title font-medium text-ivory">
                Welcome, {greeting}.
              </h1>
              <p className="mt-3 max-w-xl text-muted">
                This room is yours. Claim a station. Hours are held at the desk.

              </p>
            </div>
            {member ? (
              <Badge>{STATION_COPY[member.station].name}</Badge>
            ) : (
              <div className="h-8 w-24 animate-pulse rounded-full bg-surface-2" />
            )}
          </div>
          <GoldRule className="mt-8 max-w-48" />

          {loadError ? (
            <p className="mt-8 text-sm text-danger" role="alert">
              {loadError}
            </p>
          ) : null}

          <h2 className="mt-12 font-display text-2xl text-ivory">Your station</h2>
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {(Object.keys(STATION_COPY) as Station[]).map((id) => {
              const copy = STATION_COPY[id];
              const current = member?.station === id;
              return (
                <article
                  key={id}
                  className={cn(
                    "flex flex-col rounded-xl border p-6",
                    current ? "border-gold/50 bg-surface shadow-frame" : "border-line bg-surface-2",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-display text-2xl text-ivory">{copy.name}</h3>
                    {current ? <Badge>Held</Badge> : copy.featured ? <Badge>Preferred</Badge> : null}
                  </div>
                  <p className="mt-3 flex-1 text-sm text-muted">{copy.blurb}</p>
                  <Button
                    className="mt-6 w-full"
                    variant={current ? "outline" : copy.featured ? "default" : "outline"}
                    disabled={current || saving !== null || !member}
                    onClick={() => claim(id)}
                  >
                    {current ? "Your station" : saving === id ? "Claiming…" : `Claim ${copy.name}`}
                  </Button>
                </article>
              );
            })}
          </div>

          <section className="mt-16 rounded-xl border border-line bg-surface p-7 sm:p-8">
            <h2 className="font-display text-2xl text-ivory">Private audience</h2>
            <p className="mt-2 max-w-xl text-sm text-muted">
              Hours are held at the booking desk. In person, Ontario, 18+. Book up to
              two hours before. Half hour $225. One hour $450. Cancel more than 48
              hours before, or the deposit stays with the house.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild>
                <a href="/desk">Open the desk</a>
              </Button>
              <Button asChild variant="outline">
                <a href="/vault">Open the vault</a>
              </Button>
            </div>
          </section>
        </div>
      </main>
    </Shell>
  );
}
