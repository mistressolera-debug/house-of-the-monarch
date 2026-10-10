import { createFileRoute } from "@tanstack/react-router";
import { Features } from "@/components/landing/features";
import { Hero } from "@/components/landing/hero";
import { House } from "@/components/landing/house";
import { Pricing } from "@/components/landing/pricing";
import { Testimonials } from "@/components/landing/testimonials";
import { Waitlist } from "@/components/landing/waitlist";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <Shell>
      <main>
        <Hero />
        <House />
        <Features />
        <Pricing />
        <Testimonials />
        <Waitlist />
      </main>
    </Shell>
  );
}
