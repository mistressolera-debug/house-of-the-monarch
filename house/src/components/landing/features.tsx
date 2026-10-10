import { Calendar, Crown, Frame, KeyRound, Moon, Sparkles } from "lucide-react";
import { SectionKicker } from "./marks";

const FEATURES = [
  {
    icon: Crown,
    title: "The Inner Court",
    body: "Private memberships, not a public feed. Stations with doors that stay closed to everyone else.",
  },
  {
    icon: Moon,
    title: "Digital offerings",
    body: "4K work and photo sets released to those who hold a key. The vault is here, not scattered across spare URLs.",
  },
  {
    icon: Frame,
    title: "Signed prints",
    body: "Museum-quality prints and limited canvases, signed and shipped from Ontario. Physical work for the devoted.",
  },
  {
    icon: Sparkles,
    title: "Private audiences",
    body: "In-person sessions, 18+, arranged with intention. Online audiences are granted separately, never as a cart item.",
  },
  {
    icon: Calendar,
    title: "Ritual calendar",
    body: "Tarot, live court, and seasonal rites on a schedule you can keep — not a scramble of notifications.",
  },
  {
    icon: KeyRound,
    title: "Patronage, discreet",
    body: "Tribute handled as patronage. Quiet, exact, and worthy of the house it funds.",
  },
];

export function Features() {
  return (
    <section id="offerings" className="scroll-mt-24 border-t border-line bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionKicker index="02">Ways to serve</SectionKicker>
        <h2 className="mt-5 max-w-2xl font-display text-title font-medium text-ivory">
          What the house actually holds.
        </h2>
        <p className="mt-4 max-w-xl text-muted">
          Court, vault, print, and audience. Six rooms. One house.
        </p>

        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((item) => (
            <li
              key={item.title}
              className="rounded-xl border border-line bg-bg p-6 shadow-[0_0_0_1px_#c9a22714] transition-[border-color,transform] duration-200 hover:border-gold/35"
            >
              <span className="flex size-11 items-center justify-center rounded-md border border-gold/25 bg-gold/10 text-gold">
                <item.icon className="size-5" strokeWidth={1.6} />
              </span>
              <h3 className="mt-5 font-display text-xl font-medium text-ivory">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
