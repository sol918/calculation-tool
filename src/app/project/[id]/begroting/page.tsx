"use client";

import { BegrotingView } from "@/components/begroting-view";

/**
 * Full-width begroting — complement to the split-screen view on the project root.
 * Useful when the user wants to see the entire project breakdown without the invoer.
 */
export default function BegrotingPage() {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Volledige begroting · alle gebouwen. Terug naar het split-scherm via het project om invoer te bewerken.
      </div>
      <BegrotingView scope={{ mode: "all" }} density="normal" />
    </div>
  );
}
