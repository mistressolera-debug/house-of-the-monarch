import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Crescent({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("fill-current", className)} aria-hidden="true">
      <path d="M40.2 8.4A24 24 0 1 0 55.6 40.8 20 20 0 0 1 32 12a19.6 19.6 0 0 1 8.2-3.6Z" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5 text-ivory", className)}>
      <Crescent className="size-6 text-gold" />
      <span className="flex flex-col leading-none">
        <span className="font-display text-lg font-semibold tracking-wide">Monarch</span>
        <span className="mt-1 text-kicker uppercase tracking-luxury text-gold">
          of the Moon
        </span>
      </span>
    </span>
  );
}

export function GoldRule({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)} aria-hidden="true">
      <span className="h-px flex-1 bg-gold/35" />
      <Crescent className="size-3.5 text-gold" />
      <span className="h-px flex-1 bg-gold/35" />
    </div>
  );
}

export function SectionKicker({
  index,
  children,
}: {
  index: string;
  children: ReactNode;
}) {
  return (
    <p className="flex items-center gap-3 text-kicker font-medium uppercase tracking-luxury text-gold">
      <span className="tabular-nums text-gold-dim">{index}</span>
      <span className="h-px w-8 bg-gold/40" aria-hidden="true" />
      {children}
    </p>
  );
}
