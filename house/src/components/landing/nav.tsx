import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { AuthSlot } from "@/components/landing/auth-slot";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Wordmark } from "./marks";

const LINKS = [
  { href: "/#house", id: "house", label: "The House" },
  { href: "/#offerings", id: "offerings", label: "Ways to serve" },
  { href: "/desk", id: "desk", label: "Desk" },
  { href: "/vault", id: "vault", label: "Vault" },
];

export function Nav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const ids = LINKS.filter((l) => l.href.startsWith("/#")).map((l) => l.id);
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActive(visible.target.id);
      },
      { rootMargin: "-40% 0px -50% 0px", threshold: [0.1, 0.25, 0.5] },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,box-shadow] duration-200",
        scrolled || open
          ? "border-b border-line bg-bg/92 shadow-[0_8px_30px_#00000066]"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:h-18 sm:px-8">
        <a href="/" className="relative z-10" aria-label="Monarch of the Moon home">
          <Wordmark />
        </a>

        <nav className="hidden items-center gap-8 lg:flex" aria-label="Primary">
          {LINKS.map((link) => {
            const isActive =
              pathname === link.href || (link.href.startsWith("/#") && active === link.id);
            return (
              <a
                key={link.href}
                href={link.href}
                className={cn(
                  "text-sm tracking-wide transition-colors duration-150",
                  isActive ? "text-gold" : "text-muted hover:text-ivory",
                )}
              >
                {link.label}
              </a>
            );
          })}
        </nav>

        <div className="hidden lg:block">
          <AuthSlot />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X /> : <Menu />}
        </Button>
      </div>

      <div
        className={cn(
          "lg:hidden overflow-hidden border-t border-line bg-bg transition-[max-height,opacity] duration-200 ease-smooth-out",
          open ? "max-h-[32rem] opacity-100" : "max-h-0 opacity-0 border-t-transparent",
        )}
      >
        <nav className="flex flex-col gap-1 px-5 py-4" aria-label="Mobile">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center text-lg font-display text-ivory"
            >
              {link.label}
            </a>
          ))}
          <div className="mt-3">
            <AuthSlot onNavigate={() => setOpen(false)} />
          </div>
        </nav>
      </div>
    </header>
  );
}
