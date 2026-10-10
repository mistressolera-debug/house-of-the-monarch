import { SectionKicker } from "./marks";

const VOICES = [
  {
    quote:
      "The house feels like a secret I was always meant to keep. Nothing here performs. It simply rules.",
    name: "Adrian",
    station: "Devotee",
    initial: "A",
  },
  {
    quote:
      "She does not run a brand. She keeps a court. The difference is the reason I stayed past the first moon.",
    name: "M.",
    station: "Sovereign",
    initial: "M",
  },
  {
    quote:
      "I joined for the drops. I remained because the ritual actually means something — and the letters arrive like they were written to me.",
    name: "Elise",
    station: "Familiar",
    initial: "E",
  },
];

export function Testimonials() {
  return (
    <section id="voices" className="scroll-mt-24 border-t border-line bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionKicker index="04">Voices of the court</SectionKicker>
        <h2 className="mt-5 max-w-2xl font-display text-title font-medium text-ivory">
          Those who already keep the door.
        </h2>

        <ul className="mt-12 grid gap-5 lg:grid-cols-3">
          {VOICES.map((v) => (
            <li
              key={v.name}
              className="flex flex-col rounded-xl border border-line bg-bg p-7"
            >
              <p className="font-display text-2xl leading-snug text-ivory">
                <span className="text-gold">“</span>
                {v.quote}
                <span className="text-gold">”</span>
              </p>
              <div className="mt-8 flex items-center gap-3">
                <span
                  className="flex size-11 items-center justify-center rounded-full border border-gold/40 bg-purple-deep font-display text-lg text-gold-soft"
                  aria-hidden="true"
                >
                  {v.initial}
                </span>
                <div>
                  <p className="text-sm font-medium text-ivory">{v.name}</p>
                  <p className="text-kicker uppercase tracking-luxury text-gold">{v.station}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
