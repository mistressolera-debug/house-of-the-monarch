import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { Footer } from "@/components/landing/footer";
import { Nav } from "@/components/landing/nav";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="grain min-h-dvh overflow-x-hidden bg-bg">
      <Nav />
      {children}
      <Footer />
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          className: "font-sans",
          style: {
            background: "var(--color-surface)",
            border: "1px solid var(--color-line)",
            color: "var(--color-ivory)",
          },
        }}
      />
    </div>
  );
}
