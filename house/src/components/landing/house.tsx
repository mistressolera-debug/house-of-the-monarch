import { SectionKicker } from "./marks";

const STEPS = [
  {
    n: "01",
    title: "Request a key",
    body: "Leave your name at this door. The court is not open enrollment — it is an invitation you earn by asking properly.",
  },
  {
    n: "02",
    title: "Take your station",
    body: "Familiar, Devotee, or Sovereign. Each station opens a different depth: drops, ritual, prints, and private audience.",
  },
  {
    n: "03",
    title: "Keep the house",
    body: "Once inside, you are not a subscriber. You are of the court. Service is how you stay.",
  },
];

export function House() {
  return (
    <section id="house" className="scroll-mt-24 border-t border-line bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionKicker index="01">The House</SectionKicker>
        <div className="mt-5 grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-end">
          <h2 className="font-display text-title font-medium text-ivory">
            One house. One door. This is it.
          </h2>
          <p className="max-w-lg text-base leading-relaxed text-muted">
            The court, the vault, and the calendar live here. Keys, moonlit drops,
            signed work from Ontario, and private audiences kept with the care of a salon.
          </p>
        </div>

        <ol className="mt-14 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n} className="bg-surface p-7 sm:p-8">
              <p className="font-display text-3xl text-gold">{step.n}</p>
              <h3 className="mt-4 font-display text-2xl font-medium text-ivory">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
