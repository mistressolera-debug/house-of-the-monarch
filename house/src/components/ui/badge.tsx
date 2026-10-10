import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-3 py-1 text-kicker uppercase tracking-luxury font-medium",
  {
    variants: {
      variant: {
        gold: "border-gold/40 bg-gold/10 text-gold-soft",
        purple: "border-purple-mid/40 bg-purple/20 text-ivory",
        line: "border-line bg-transparent text-muted",
      },
    },
    defaultVariants: {
      variant: "gold",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
