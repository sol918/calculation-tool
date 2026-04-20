"use client";

import { formatEUR, formatNumber, computeBuildingScopedTotal } from "@/lib/calculation";
import type { ProjectCalcResult, MarkupRow } from "@/types";

/**
 * Floating pill onderin die scope-bewust is: toont het project-totaal als je in de
 * "alle gebouwen"-view zit, of het subtotaal van één gebouw (1×) als je binnen
 * één gebouw aan het werk bent.
 */
interface Props {
  result: ProjectCalcResult | null;
  scope?: { mode: "all" } | { mode: "building"; buildingId: string };
  markupRows?: MarkupRow[];
  scopedTotalOverride?: number | null;
  scopedGfaOverride?: number | null;
}

export function FloatingTotals({ result, scope, markupRows, scopedTotalOverride, scopedGfaOverride }: Props) {
  if (!result) return null;
  const isBuilding = scope?.mode === "building";
  const br = isBuilding && scope?.mode === "building"
    ? result.buildings.find((b) => b.building.id === scope.buildingId)
    : undefined;

  let total = result.totalExVat;
  let areaM2 = result.totalGFA;
  let label = "Totaal project";
  let pricePerM2 = result.pricePerM2;
  // Als de begroting-view een eigen scoped totaal heeft gepubliceerd (incl. engineering,
  // disabled-vinkjes etc.), gebruik dat in plaats van de gerecomputeerde waarde.
  if (scopedTotalOverride != null) {
    total = scopedTotalOverride;
    areaM2 = scopedGfaOverride ?? areaM2;
    pricePerM2 = areaM2 > 0 ? total / areaM2 : 0;
    label = isBuilding ? "Dit gebouw (1×)" : "Totaal project";
  } else if (isBuilding && br) {
    const gfa = br.effectiveInputs["Module oppervlak"] ?? 0;
    total = computeBuildingScopedTotal(br, markupRows ?? []);
    areaM2 = gfa;
    pricePerM2 = gfa > 0 ? total / gfa : 0;
    label = "Dit gebouw (1×)";
  }

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-40"
      aria-label="Totals"
    >
      <div
        className="pointer-events-auto flex items-baseline gap-3 rounded-full bg-surface-lowest px-4 py-2 backdrop-blur"
        style={{
          boxShadow: "0 8px 24px rgba(24, 28, 30, 0.08), 0 0 0 1px rgba(196, 199, 202, 0.25)",
          backdropFilter: "blur(12px)",
          backgroundColor: "rgba(255, 255, 255, 0.9)",
        }}
      >
        <span className="text-[10px] uppercase tracking-[0.18em] text-on-surface-var">{label}</span>
        <span className="text-[15px] font-semibold tabular-nums tracking-[0.01em]">{formatEUR(total)}</span>
        {pricePerM2 > 0 && (
          <span className="border-l-ghost pl-3 text-xs text-on-surface-var tabular-nums">
            {formatEUR(pricePerM2)} /m² · {formatNumber(areaM2, 0)} m²
          </span>
        )}
      </div>
    </div>
  );
}
