import { Crescent, GoldRule, Wordmark } from "./marks";

export function Footer() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Wordmark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
              Mistress Solena. The Monarch of the Moon. The only door. A private court
              for those who serve with intention.
            </p>
          </div>
          <div className="flex flex-col gap-3 text-sm">
            <a className="text-muted hover:text-gold" href="/#house">
              The House
            </a>
            <a className="text-muted hover:text-gold" href="/#court">
              Stations
            </a>
            <a className="text-muted hover:text-gold" href="/gifts">
              House icons
            </a>
            <a
              className="text-muted hover:text-gold"
              href="https://throne.com/mistresssolena"
              rel="noreferrer"
              target="_blank"
            >
              Throne
            </a>
            <a
              className="text-muted hover:text-gold"
              href="https://x.com/MistressSolera"
              rel="noreferrer"
              target="_blank"
            >
              @MistressSolera
            </a>
          </div>
        </div>
        <GoldRule className="mt-12" />
        <div className="mt-6 flex flex-col gap-2 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Monarch of the Moon. All rights reserved.</p>
          <p className="flex items-center gap-2">
            <Crescent className="size-3 text-gold" />
            The house is for adults.
          </p>
        </div>
      </div>
    </footer>
  );
}
