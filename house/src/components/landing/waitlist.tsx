import { type FormEvent, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GoldRule, SectionKicker } from "./marks";

const STORAGE_KEY = "solena-court-waitlist";

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function readList(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function Waitlist() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [joined, setJoined] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = email.trim().toLowerCase();
    if (!isEmail(next)) {
      setError("A real address, if you please.");
      return;
    }
    const list = readList();
    if (list.includes(next)) {
      setError("");
      setJoined(true);
      toast.message("You are already of the court.");
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...list, next]));
    setError("");
    setJoined(true);
    toast.success("The door has your name.");
  }

  return (
    <section id="waitlist" className="scroll-mt-24 border-t border-line bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-xl px-5 text-center sm:px-8">
        <SectionKicker index="05">Enter</SectionKicker>
        <h2 className="mt-5 font-display text-title font-medium text-ivory">
          Leave your name at the door.
        </h2>
        <p className="mt-4 text-muted">
          Not ready for a key? Leave an address. Members enter the{" "}
          <a href="/court" className="text-gold hover:text-gold-soft">
            inner court
          </a>
          .
        </p>
        <GoldRule className="mx-auto mt-8 max-w-48" />

        {joined ? (
          <div className="mt-10 rounded-xl border border-gold/35 bg-surface px-6 py-10">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-gold text-bg">
              <Check className="size-6" strokeWidth={2} />
            </span>
            <p className="mt-5 font-display text-2xl text-ivory">You are on the list.</p>
            <p className="mt-2 text-sm text-muted">
              Watch this house. When the key is cut, it will find you.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-10" noValidate>
            <label htmlFor="court-email" className="sr-only">
              Email address
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                id="court-email"
                type="email"
                autoComplete="email"
                placeholder="you@domain.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError("");
                }}
                aria-invalid={Boolean(error)}
                className="w-full min-w-0 sm:w-auto sm:flex-1"
              />
              <Button type="submit" size="lg" className="w-full shrink-0 sm:w-auto sm:px-8">
                Request a key
                <ArrowRight />
              </Button>
            </div>
            {error ? (
              <p className="mt-3 text-sm text-danger" role="alert">
                {error}
              </p>
            ) : (
              <p className="mt-3 text-xs text-subtle">
                No blasts. No lists sold. The house writes when it means to.
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
