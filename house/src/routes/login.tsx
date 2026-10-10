import { type FormEvent, useState } from "react";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Crescent, GoldRule } from "@/components/landing/marks";
import { Shell } from "@/components/shell";

type NextPath = "/court" | "/desk" | "/vault";

function parseNext(search: Record<string, unknown>): { next?: NextPath } {
  if (search.next === "/desk") return { next: "/desk" };
  if (search.next === "/vault") return { next: "/vault" };
  if (search.next === "/court") return { next: "/court" };
  return {};
}

export const Route = createFileRoute("/login")({
  validateSearch: parseNext,
  component: Login,
});

function Login() {
  const { next = "/court" } = Route.useSearch();
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"enter" | "create">("enter");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (isPending) {
    return (
      <Shell>
        <main className="grid min-h-dvh place-items-center px-5 pt-24">
          <div className="h-64 w-full max-w-sm animate-pulse rounded-xl bg-surface" />
        </main>
      </Shell>
    );
  }

  if (user) return <Navigate to={next} />;

  async function onEmail(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "create") {
        const { error: err } = await authClient.signUp.email({
          email: email.trim(),
          password,
          name: name.trim() || email.trim().split("@")[0],
        });
        if (err) throw new Error(err.message ?? "Could not create a key.");
      } else {
        const { error: err } = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        if (err) throw new Error(err.message ?? "The door did not know that name.");
      }
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The door stayed closed.");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <main className="relative isolate starfield min-h-dvh px-5 pb-20 pt-28 sm:pt-32">
        <Crescent className="pointer-events-none absolute -right-16 top-24 size-72 text-gold/8" />
        <div className="relative mx-auto w-full max-w-sm">
          <p className="text-kicker font-medium uppercase tracking-luxury text-gold">The door</p>
          <h1 className="mt-3 font-display text-4xl font-medium text-ivory">Member login</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Enter the inner court. Google, X, or a key of your own.
          </p>
          <GoldRule className="mt-6 max-w-32" />

          {!authEnabled ? (
            <p className="mt-8 text-sm text-muted">Sign-in is disabled.</p>
          ) : (
            <>
              <div className="mt-8 flex flex-col gap-3">
                {GROK_PROVIDERS.map((provider) => (
                  <Button
                    key={provider.providerId}
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => signIn(provider.providerId, { callbackURL: next })}
                  >
                    Continue with {provider.label}
                  </Button>
                ))}
              </div>

              <div className="my-8 flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-line" />
                <span className="text-kicker uppercase tracking-luxury text-subtle">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <div
                className="mb-5 inline-flex rounded-md border border-line bg-surface p-1"
                role="group"
                aria-label="Key type"
              >
                <button
                  type="button"
                  aria-pressed={mode === "enter"}
                  onClick={() => setMode("enter")}
                  className={
                    mode === "enter"
                      ? "min-h-10 rounded-sm bg-gold px-4 text-sm text-bg"
                      : "min-h-10 rounded-sm px-4 text-sm text-subtle hover:text-ivory"
                  }
                >
                  I have a key
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "create"}
                  onClick={() => setMode("create")}
                  className={
                    mode === "create"
                      ? "min-h-10 rounded-sm bg-gold px-4 text-sm text-bg"
                      : "min-h-10 rounded-sm px-4 text-sm text-subtle hover:text-ivory"
                  }
                >
                  Create a key
                </button>
              </div>

              <form onSubmit={onEmail} className="flex flex-col gap-3" noValidate>
                {mode === "create" ? (
                  <div>
                    <label htmlFor="member-name" className="mb-1.5 block text-xs text-subtle">
                      Name the house may use
                    </label>
                    <Input
                      id="member-name"
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="How you are addressed"
                    />
                  </div>
                ) : null}
                <div>
                  <label htmlFor="member-email" className="mb-1.5 block text-xs text-subtle">
                    Email
                  </label>
                  <Input
                    id="member-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@domain.com"
                  />
                </div>
                <div>
                  <label htmlFor="member-password" className="mb-1.5 block text-xs text-subtle">
                    Password
                  </label>
                  <Input
                    id="member-password"
                    type="password"
                    autoComplete={mode === "create" ? "new-password" : "current-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least eight characters"
                  />
                </div>
                {error ? (
                  <p className="text-sm text-danger" role="alert">
                    {error}
                  </p>
                ) : null}
                <Button type="submit" className="mt-2 w-full" disabled={busy}>
                  {busy ? "Turning the key…" : mode === "create" ? "Create a key" : "Enter the court"}
                </Button>
              </form>
            </>
          )}

          <p className="mt-8 text-center text-sm text-subtle">
            <Link to="/" className="text-muted hover:text-gold">
              Return to the house
            </Link>
          </p>
        </div>
      </main>
    </Shell>
  );
}
