import { createFileRoute } from "@tanstack/react-router";
import { GoldRule, SectionKicker } from "@/components/landing/marks";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/gifts")({ component: GiftsPage });

const GIFTS = [
  {
    src: "/images/throne-crescent-patronage.png",
    title: "Crescent — $100",
    note: "House crest",
  },
  {
    src: "/images/throne-lunar-patronage.png",
    title: "Lunar — $200",
    note: "House crest",
  },
  {
    src: "/images/throne-crescent-waxseal.jpg",
    title: "Crescent — $100",
    note: "Wax seal",
  },
  {
    src: "/images/throne-lunar-waxseal.jpg",
    title: "Lunar — $200",
    note: "Wax seal",
  },
];

function GiftsPage() {
  return (
    <Shell>
      <main className="starfield min-h-dvh px-5 pb-24 pt-28 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <SectionKicker index="08">House icons</SectionKicker>
          <h1 className="mt-5 font-display text-title font-medium text-ivory">
            Patronage marks for Throne.
          </h1>
          <p className="mt-3 max-w-xl text-muted">
            Long-press a picture and choose Save image. Then upload it to the matching
            cash gift on Throne.
          </p>
          <GoldRule className="mt-8 max-w-48" />
          <ul className="mt-10 flex flex-col gap-10">
            {GIFTS.map((gift) => (
              <li key={gift.src}>
                <p className="text-kicker font-medium uppercase tracking-luxury text-gold">
                  {gift.note}
                </p>
                <h2 className="mt-2 font-display text-2xl text-ivory">{gift.title}</h2>
                <img
                  src={gift.src}
                  alt={gift.title}
                  className="mt-4 w-full rounded-xl border border-line"
                />
              </li>
            ))}
          </ul>
        </div>
      </main>
    </Shell>
  );
}
