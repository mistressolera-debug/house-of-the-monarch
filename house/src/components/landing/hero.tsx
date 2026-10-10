import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Crescent } from "./marks";

export function Hero() {
  return (
    <section
      id="top"
      className="relative isolate overflow-hidden starfield scroll-mt-24 pt-28 pb-16 sm:pt-36 sm:pb-24"
    >
      <Crescent className="pointer-events-none absolute -right-24 top-16 size-[28rem] text-gold/8 sm:size-[36rem]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-bg to-transparent" />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
        <div>
          <Badge>Curated by Mistress Solena</Badge>
          <h1 className="mt-6 font-display text-display font-medium leading-[0.95] text-ivory">
            I am the night.{" "}
            <em className="italic text-gold-soft">I am the moon.</em>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Sovereign of shadows. From the moonlit forests of Ontario, this is the
            house — memberships, signed prints, and private audiences. One door.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <a href="/court">
                Enter the court
                <ArrowRight />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <a href="#offerings">Ways to serve</a>
            </Button>
          </div>
          <p className="mt-6 text-sm text-subtle">
            Adults only. Discretion is the house style.
          </p>
        </div>

        <figure className="relative mx-auto w-full max-w-md">
          <div className="absolute -inset-3 rounded-xl border border-gold/25" />
          <div className="relative overflow-hidden rounded-lg bg-surface shadow-frame">
            <img
              src="/images/solena-portrait.jpg"
              alt="Mistress Solena, the Monarch of the Moon"
              className="aspect-square w-full object-cover object-top"
              width={400}
              height={400}
            />
            <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-bg via-bg/70 to-transparent px-5 pb-5 pt-16">
              <figcaption className="font-display text-2xl text-ivory">Mistress Solena</figcaption>
              <p className="mt-0.5 text-kicker uppercase tracking-luxury text-gold">
                The Monarch of the Moon
              </p>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}
