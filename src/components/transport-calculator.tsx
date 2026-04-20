"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatEUR, formatNumber } from "@/lib/calculation";
import { Truck, AlertTriangle, Info, RefreshCw } from "lucide-react";
import type { Project } from "@/types";

interface Leg { from: string; to: string; distanceM: number; durationS: number; source: string; }
interface Pattern { description: string; trucksPerInstance: number; totalTrucks: number; modulesPerTruck: number; }
interface BuildingGroup {
  buildingName: string; buildingCount: number;
  modulesPerInstance: number; trucksPerInstance: number; totalTrucks: number;
  patterns: Pattern[];
}
interface TrailerResult {
  trailer: string; trailerLabel: string;
  modulesTotal: number; trucksPacked: number; trucksExtra: number; trucksTotal: number;
  hoursPerTruck: number;
  maxWidth: number; dayRate: number; hourlyRate: number; surcharge: number; cost: number;
  truckUtilizationPct: number;
  buildings: BuildingGroup[];
}
interface Result {
  scope: "all" | "building"; buildingName: string | null;
  route: {
    totalDistanceKm: number; totalDurationHours: number; legs: Leg[];
    startAddress: string; waypointAddress: string | null; destinationAddress: string; returnToStart: boolean;
  };
  trailers: TrailerResult[];
  totalTrucksAll: number;
  trailerCost: number;
  extras: { total: number; auto: boolean; pct: number };
  totalCost: number;
  warnings: { severity: "warn" | "error"; message: string }[];
  assumptions: {
    maxTransportHeightM: number; roofHeightExtraM: number;
    trailers: { id: string; label: string; floorHeight: number; maxLength: number; maxWidth: number; surcharge: number }[];
    widthTariffs: { widthMax: number; rate: number }[];
    loadTimeMinutes: number; workdayHours: number;
    detourFactor: number; hgvAvgKmh: number; extraTripsAutoPct: number;
  };
}

interface Props {
  project: Project & { extraTripsAuto?: boolean };
  scope: { mode: "all" } | { mode: "building"; buildingId: string };
  onProjectChange: () => void;
  onTotalChange?: (total: number | null) => void;
}

export function TransportCalculator({ project, scope, onProjectChange, onTotalChange }: Props) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const lastKeyRef = useRef<string>("");

  const buildingId = scope.mode === "building" ? scope.buildingId : undefined;
  const extraTripsAuto = (project as any).extraTripsAuto !== false;

  const calculate = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/transport/calculate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, buildingId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Berekening mislukt"); setResult(null); onTotalChange?.(null); return; }
      setResult(data);
      onTotalChange?.(data.totalCost);
    } catch (e: any) {
      setError(e.message ?? "Onbekende fout");
    } finally { setLoading(false); }
  }, [project.id, buildingId, onTotalChange]);

  useEffect(() => {
    if (!project.destinationAddress) { setResult(null); return; }
    const key = [
      project.id, buildingId ?? "",
      project.destinationAddress, project.waypointAddress ?? "",
      project.returnToStart ? 1 : 0, project.loadTimeMinutes, project.workdayHours,
      project.extraTripsCount, project.extraTripCost, extraTripsAuto ? 1 : 0,
    ].join("|");
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    calculate();
  }, [
    project.id, buildingId, project.destinationAddress, project.waypointAddress,
    project.returnToStart, project.loadTimeMinutes, project.workdayHours,
    project.extraTripsCount, project.extraTripCost, extraTripsAuto,
    calculate,
  ]);

  async function patchProject(updates: Record<string, any>) {
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    onProjectChange();
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-surface-lowest p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Truck className="h-4 w-4" />
            Transportcalculator
            <span className="text-[11px] font-normal text-on-surface-var">
              {scope.mode === "all" ? "· alle gebouwen" : `· dit gebouw${result?.buildingName ? ` (${result.buildingName})` : ""}`}
            </span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={calculate} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Opnieuw
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Startlocatie">
            <Input className="h-7 text-xs" value="Raamsdonksveer, Nederland" disabled />
          </Field>
          <Field label="Bestemming">
            <Input
              className="h-7 text-xs"
              defaultValue={project.destinationAddress ?? ""}
              placeholder="Bv. Amsterdam, Nederland"
              onBlur={(e) => patchProject({ destinationAddress: e.target.value })}
            />
          </Field>
          <Field label="Tussenstop (optioneel)">
            <Input
              className="h-7 text-xs"
              defaultValue={project.waypointAddress ?? ""}
              placeholder="Bv. overslagdepot"
              onBlur={(e) => patchProject({ waypointAddress: e.target.value || null })}
            />
          </Field>
          <Field label="Laad-/lostijd per rit (min)">
            <Input
              className="h-7 text-xs"
              type="number"
              defaultValue={project.loadTimeMinutes}
              onBlur={(e) => patchProject({ loadTimeMinutes: parseInt(e.target.value) || 120 })}
            />
          </Field>
        </div>
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      </div>

      {loading && !result && (
        <div className="rounded-md bg-surface-lowest p-6 text-center text-xs text-on-surface-var">
          Transport berekenen...
        </div>
      )}

      {result && (
        <>
          <div className="rounded-md bg-surface-lowest p-3 text-xs">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-on-surface-var">Route</div>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-medium">{result.route.startAddress}</span>
              <span className="text-on-surface-var">→</span>
              {result.route.waypointAddress && (<>
                <span className="font-medium">{result.route.waypointAddress}</span>
                <span className="text-on-surface-var">→</span>
              </>)}
              <span className="font-medium">{result.route.destinationAddress}</span>
              {result.route.returnToStart && (<>
                <span className="text-on-surface-var">→</span>
                <span className="font-medium">{result.route.startAddress}</span>
              </>)}
            </div>
            <div className="mt-1 text-on-surface-var">
              <span className="tabular-nums text-on-surface">{formatNumber(result.route.totalDistanceKm, 0)} km</span>
              {" · "}
              <span className="tabular-nums text-on-surface">{formatNumber(result.route.totalDurationHours, 1)} uur</span> rijtijd (HGV)
            </div>
          </div>

          {result.trailers.map((t) => (
            <div key={t.trailer} className="rounded-md bg-surface-lowest">
              <div className="flex items-center justify-between border-b-ghost px-3 py-2">
                <div>
                  <div className="text-sm font-semibold">{t.trailerLabel}</div>
                  <div className="text-[10px] text-on-surface-var">
                    {t.modulesTotal} modules · {t.trucksPacked} gepland
                    {t.trucksExtra > 0 && <> + {t.trucksExtra} extra = <span className="font-medium text-on-surface">{t.trucksTotal} trucks</span></>}
                    {t.trucksExtra === 0 && <> trucks</>}
                    {" · "}{t.hoursPerTruck} uur/truck · beladingsgraad {formatNumber(t.truckUtilizationPct, 0)}%
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums">{formatEUR(t.cost)}</div>
                  <div className="text-[10px] text-on-surface-var tabular-nums">
                    {formatEUR(t.hourlyRate)}/u × {t.hoursPerTruck} u × {t.trucksTotal} × ×{t.surcharge.toFixed(2)}
                  </div>
                </div>
              </div>
              {/* Per building */}
              {t.buildings.map((b) => (
                <div key={b.buildingName} className="border-b-ghost">
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="font-medium">
                      {b.buildingName}
                      {b.buildingCount > 1 && <span className="ml-1 text-on-surface-var">×{b.buildingCount}</span>}
                    </span>
                    <span className="text-on-surface-var">
                      {b.modulesPerInstance} modules/gebouw · {b.trucksPerInstance} trucks/gebouw ·{" "}
                      <span className="font-medium text-on-surface">{b.totalTrucks} trucks totaal</span>
                    </span>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-on-surface-var">
                        <th className="px-3 py-1 font-medium">Trucks/gebouw</th>
                        <th className="px-3 py-1 font-medium">Lading per truck</th>
                        <th className="px-3 py-1 text-right font-medium">Totaal trucks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.patterns.map((p, i) => (
                        <tr key={i} className="border-t-ghost">
                          <td className="px-3 py-1 tabular-nums">{p.trucksPerInstance}×</td>
                          <td className="px-3 py-1">{p.description}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{p.totalTrucks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {/* Buffer voor pakverlies — alleen relevant bij gemixte trucks (>1 module/truck) */}
              {(() => {
                const hasMixed = t.buildings.some((b) => b.patterns.some((p) => p.modulesPerTruck > 1));
                return (
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-on-surface-var" title="Extra trucks als buffer voor pakverlies (modules passen niet altijd ideaal)">
                        Buffer pakverlies
                      </span>
                      {hasMixed ? (
                        <>
                          <label className="flex items-center gap-1 text-[10px] text-on-surface-var">
                            <input
                              type="checkbox"
                              checked={extraTripsAuto}
                              onChange={(e) => patchProject({ extraTripsAuto: e.target.checked })}
                            />
                            auto ({(result.assumptions.extraTripsAutoPct * 100).toFixed(0)}%)
                          </label>
                          {!extraTripsAuto && (
                            <Input
                              className="h-6 w-16 text-right text-xs tabular-nums"
                              type="number" min={0}
                              defaultValue={project.extraTripsCount}
                              onBlur={(e) => patchProject({ extraTripsCount: parseInt(e.target.value) || 0 })}
                            />
                          )}
                        </>
                      ) : (
                        <span className="text-[10px] italic text-on-surface-var">n.v.t. — 1 module per truck</span>
                      )}
                    </div>
                    <span className="tabular-nums text-on-surface-var">
                      {t.trucksExtra > 0 ? `+${t.trucksExtra} trucks` : "—"}
                    </span>
                  </div>
                );
              })()}
            </div>
          ))}

          {/* Totals */}
          <div className="rounded-md bg-surface-lowest p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Totaal transport</span>
              <span className="text-sm font-semibold tabular-nums">{formatEUR(result.totalCost)}</span>
            </div>
            <div className="mt-0.5 text-right text-[11px] text-on-surface-var tabular-nums">
              {result.totalTrucksAll} trucks totaal
            </div>
          </div>

          {result.warnings.length > 0 && (
            <div className="space-y-1.5">
              {result.warnings.map((w, i) => (
                <div key={i}
                  className={`flex items-start gap-2 rounded-md p-2.5 text-xs ${w.severity === "error" ? "bg-[#fee2e2] text-[#991b1b]" : "bg-[#fef3c7] text-[#92400e]"}`}>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md bg-surface-lowest">
            <button
              onClick={() => setShowAssumptions((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface-low"
            >
              <Info className="h-3.5 w-3.5 text-on-surface-var" />
              <span className="font-medium">Aannames</span>
              <span className="ml-auto text-on-surface-var">{showAssumptions ? "verbergen" : "tonen"}</span>
            </button>
            {showAssumptions && (
              <div className="space-y-2 border-t-ghost p-3 text-[11px] text-on-surface-var">
                <div>
                  Max. transporthoogte: {result.assumptions.maxTransportHeightM} m · dakopbouw +{result.assumptions.roofHeightExtraM} m ·
                  laad/lostijd {result.assumptions.loadTimeMinutes} min · detour-factor {result.assumptions.detourFactor} ·
                  HGV-snelheid {result.assumptions.hgvAvgKmh} km/h (fallback) ·
                  extra transporten {(result.assumptions.extraTripsAutoPct * 100).toFixed(0)}% van trucks
                </div>
                <div>
                  <div className="mb-0.5 font-medium text-on-surface">Trailer-types</div>
                  <table className="w-full">
                    <tbody>
                      {result.assumptions.trailers.map((t) => (
                        <tr key={t.id}>
                          <td className="py-0.5">{t.label}</td>
                          <td className="py-0.5 text-right tabular-nums">vloer {t.floorHeight} m</td>
                          <td className="py-0.5 text-right tabular-nums">{t.maxLength} × {t.maxWidth} m</td>
                          <td className="py-0.5 text-right tabular-nums">×{t.surcharge.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="mb-0.5 font-medium text-on-surface">Dagtarief per breedte</div>
                  <table className="w-full">
                    <tbody>
                      {result.assumptions.widthTariffs.map((t, i) => (
                        <tr key={i}>
                          <td className="py-0.5">
                            {i === 0 ? `≤ ${t.widthMax.toFixed(2)} m` : `> ${result.assumptions.widthTariffs[i - 1].widthMax.toFixed(2)} m`}
                          </td>
                          <td className="py-0.5 text-right tabular-nums">{formatEUR(t.rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <label className="text-[10px] uppercase tracking-wider text-on-surface-var">{label}</label>
      {children}
    </div>
  );
}
