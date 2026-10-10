import { useState } from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SectionKicker } from "./marks";

const TIERS = [
  {
    id: "familiar",
    name: "Familiar",
    monthly: 29,
    blurb: "A seat at the threshold. Enough to know the moon is watching.",
    features: [
      "Court letters each new moon",
      "Member sigil and directory",
      "Moonlit drop archive, delayed",
      "Public ritual calendar",
    ],
    featured: false,
  },
  {
    id: "devotee",
    name: "Devotee",
    monthly: 79,
    blurb: "The station most of the court keeps. Depth without spectacle.",
    features: [
      "Everything in Familiar",
      "Inner rooms and live court",
      "Drops at the hour they land",
      "Monthly rite with the house",
      "Priority on limited keys",
    ],
    featured: true,
  },
  {
    id: "sovereign",
    name: "Sovereign",
    monthly: 190,
    blurb: "Closest to the throne. Private decree, first doors, custom rites.",
    features: [
      "Everything in Devotee",
      "Direct decree from Solena",
      "Private audience slots",
      "Bespoke rites and keys",
      "Name held in the inner book",
    ],
    featured: false,
  },
];

const AUDIENCES = [
  {
    name: "Half hour",
    price: 225,
    detail: "$100 tribute on Throne · $125 in person",
    note: "30 minutes · full session rate",
  },
  {
    name: "One hour",
    price: 450,
    detail: "$200 tribute on Throne · $250 in person",
    note: "60 minutes · full session rate",
  },
];

export function Pricing() {
  const [annual, setAnnual] = useState(true);

  return (
    <section id="court" className="scroll-mt-24 border-t border-line bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <SectionKicker index="03">The Court</SectionKicker>
            <h2 className="mt-5 font-display text-title font-medium text-ivory">
              Three stations. One house.
            </h2>
            <p className="mt-4 max-w-xl text-muted">
              Choose the depth you can keep. Annual keys include two moons free.
            </p>
          </div>

          <div
            className="inline-flex self-start rounded-md border border-line bg-surface p-1"
            role="group"
            aria-label="Billing period"
          >
            <button
              type="button"
              onClick={() => setAnnual(false)}
              aria-pressed={!annual}
              className={cn(
                "min-h-10 rounded-sm px-4 text-sm transition-colors duration-150",
                !annual ? "bg-gold text-bg" : "bg-transparent text-subtle hover:text-ivory",
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setAnnual(true)}
              aria-pressed={annual}
              className={cn(
                "min-h-10 rounded-sm px-4 text-sm transition-colors duration-150",
                annual ? "bg-gold text-bg" : "bg-transparent text-subtle hover:text-ivory",
              )}
            >
              Annual
            </button>
          </div>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {TIERS.map((tier) => {
            const price = annual ? tier.monthly * 10 : tier.monthly;
            return (
              <article
                key={tier.id}
                className={cn(
                  "flex flex-col rounded-xl border p-7 sm:p-8",
                  tier.featured
                    ? "border-gold/50 bg-surface shadow-frame lg:-translate-y-3"
                    : "border-line bg-surface-2",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-2xl font-medium text-ivory">{tier.name}</h3>
                  {tier.featured ? <Badge>Preferred</Badge> : null}
                </div>
                <p className="mt-3 min-h-12 text-sm text-muted">{tier.blurb}</p>
                <p className="mt-6 flex items-baseline gap-1 text-ivory">
                  <span className="font-display text-5xl font-medium tabular-nums">${price}</span>
                  <span className="text-sm text-subtle">{annual ? "/ year" : "/ month"}</span>
                </p>
                {annual ? (
                  <p className="mt-1 text-xs text-gold-dim">Two moons included.</p>
                ) : (
                  <p className="mt-1 text-xs text-subtle">Billed each cycle.</p>
                )}
                <ul className="mt-6 flex flex-1 flex-col gap-3">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-ivory">
                      <Check className="mt-0.5 size-4 shrink-0 text-gold" strokeWidth={1.8} />
                      {f}
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  className="mt-8 w-full"
                  variant={tier.featured ? "default" : "outline"}
                >
                  <a href="/court">Claim {tier.name}</a>
                </Button>
              </article>
            );
          })}
        </div>

        <div className="mt-16 rounded-xl border border-line bg-surface p-7 sm:p-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-kicker font-medium uppercase tracking-luxury text-gold">
                Private audiences
              </p>
              <h3 className="mt-2 font-display text-2xl font-medium text-ivory">
                In person. Ontario. 18+ only.
              </h3>
            </div>
            <p className="max-w-md text-sm text-muted">
              A non-refundable deposit is tribute on Throne when you reserve the hour,
              then applied to the session. Remaining balance is due in cash when the
              audience is honored. Cancel more than 48 hours before and the hour returns
              to the desk. Inside 48 hours the deposit is forfeited.
            </p>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {AUDIENCES.map((slot) => (
              <div
                key={slot.name}
                className="flex items-center justify-between gap-4 rounded-lg border border-line bg-bg px-5 py-5"
              >
                <div>
                  <p className="font-display text-xl text-ivory">{slot.name}</p>
                  <p className="mt-1 text-xs text-subtle">{slot.note}</p>
                  <p className="mt-1 text-xs text-gold-dim">{slot.detail}</p>
                </div>
                <p className="font-display text-3xl text-gold tabular-nums">${slot.price}</p>
              </div>
            ))}
          </div>
          <Button asChild className="mt-8" variant="outline">
            <a href="/desk">Open the booking desk</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
