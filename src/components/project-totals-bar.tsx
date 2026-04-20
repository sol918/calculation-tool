"use client";

import { formatEUR, formatNumber } from "@/lib/calculation";
import type { ProjectCalcResult } from "@/types";

interface Props { result: ProjectCalcResult | null; }

/**
 * Minimal totals line — just the grand total and the density metrics on the right.
 * Per-group breakdowns live inside the begroting itself.
 */
export function ProjectTotalsBar({ result }: Props) {
  if (!result) {
    return (
      <div className="bg-surface-lowest">
        <div className="mx-auto flex h-9 max-w-[1400px] items-center px-6 text-xs text-on-surface-var">
          Berekening laden...
        </div>
      </div>
    );
  }
  return (
    <div className="bg-surface-lowest">
      <div className="mx-auto flex h-9 max-w-[1400px] items-center justify-end gap-4 px-6 text-xs">
        <span className="text-[15px] font-semibold tabular-nums tracking-[0.01em]">{formatEUR(result.totalExVat)}</span>
        {result.pricePerM2 > 0 && (
          <span className="text-on-surface-var tabular-nums">
            {formatEUR(result.pricePerM2)} /m² · {formatNumber(result.totalGFA, 0)} m²
          </span>
        )}
      </div>
    </div>
  );
}
