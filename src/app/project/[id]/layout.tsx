"use client";

import { useEffect, useMemo, useState, createContext, useContext } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProjectData } from "@/hooks/use-project-data";
import { useCalculation } from "@/hooks/use-calculation";
import { FloatingTotals } from "@/components/floating-totals";
import { AppHeader, HeaderContext } from "@/components/app-header";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { Layers, Settings } from "lucide-react";
import { systemTintStyle } from "@/lib/theme";
import type { ProjectCalcResult } from "@/types";

interface ProjectContextType {
  data: ReturnType<typeof useProjectData>;
  calcResult: ProjectCalcResult | null;
  /** Currently selected building (drives the full-page system tint). */
  selectedBuildingId: string | null;
  setSelectedBuildingId: (id: string | null) => void;
  /** True = project-breed, false = enkel geselecteerd gebouw. */
  scopeAll: boolean;
  setScopeAll: (v: boolean) => void;
  /** Scoped totaal zoals de begroting-view het berekent (incl. engineering + disabled vinkjes). */
  scopedTotal: number | null;
  scopedGfa: number | null;
  setScopedTotals: (t: { total: number; gfa: number } | null) => void;
  /** Auto-berekend transport naar de assemblagehal (Transport 3D-modulair).
   *  Wordt door de TransportCalculator geset en in calculateProject opgeteld bij
   *  assemblagehal.transportCost — zodat de gebruiker niet een lege €0-post ziet
   *  als ze nog niet door de Transport-tab zijn. */
  autoAssemblageTransport: number | null;
  setAutoAssemblageTransport: (v: number | null) => void;
}

export const ProjectContext = createContext<ProjectContextType | null>(null);
export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext must be used inside project layout");
  return ctx;
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const data = useProjectData(projectId);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [scopeAll, setScopeAll] = useState<boolean>(false);
  const [scopedTotals, setScopedTotals] = useState<{ total: number; gfa: number } | null>(null);
  const [autoAssemblageTransport, setAutoAssemblageTransport] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Hydrate van de DB-persisted waarde — ALTIJD syncen wanneer die wijzigt, niet
  // alleen op eerste mount. Anders blijft een verouderde React-state hangen
  // terwijl de DB al is bijgewerkt. De persisted waarde wordt door zowel
  // TransportCalculator als de layout-background-fetch ververst (na POST).
  useEffect(() => {
    const persisted = (data.project as any)?.autoAssemblageTransportCost;
    if (typeof persisted === "number" && persisted > 0) {
      setAutoAssemblageTransport(persisted);
    }
  }, [data.project?.id, (data.project as any)?.autoAssemblageTransportCost]);

  // Auto-select first building once loaded
  useEffect(() => {
    if (!selectedBuildingId && data.buildings.length > 0) {
      setSelectedBuildingId(data.buildings[0].id);
    }
    if (selectedBuildingId && !data.buildings.find((b) => b.id === selectedBuildingId) && data.buildings.length > 0) {
      setSelectedBuildingId(data.buildings[0].id);
    }
  }, [data.buildings, selectedBuildingId]);

  // Achtergrond-fetch van het project-brede transport naar de assemblagehal.
  // Draait zodra er een destinationAddress + minimaal één gebouw bekend is, zodat de
  // begroting direct een realistisch assemblagehal-transport laat zien — ook als de
  // gebruiker de Transport-tab nog niet heeft geopend. Re-fetcht bij elke wijziging
  // die de transport-prijs beïnvloedt: modules (L/W/H/aantal voor bin-packing),
  // adressen, laad-/lostijd, werkdag, retour, extra ritten.
  const buildingsSig = data.buildings.map((b) => b.id).join(",");
  const modulesSig = useMemo(() => {
    const parts: string[] = [];
    for (const [bid, mods] of data.modules) {
      const sorted = [...mods].sort((a, b) => a.id.localeCompare(b.id));
      for (const m of sorted) parts.push(`${bid}:${m.lengthM}x${m.widthM}x${m.heightM}x${m.count}`);
    }
    return parts.join("|");
  }, [data.modules]);
  // Single signature van alles wat transport-prijs beïnvloedt — als deze string
  // verandert, fire'en we een nieuwe project-brede berekening die persist.
  const transportSig = useMemo(() => {
    const p = data.project;
    return JSON.stringify({
      pid: projectId,
      dest: p?.destinationAddress ?? "",
      way:  p?.waypointAddress ?? "",
      ret:  p?.returnToStart ? 1 : 0,
      load: p?.loadTimeMinutes ?? 0,
      work: p?.workdayHours ?? 0,
      extC: p?.extraTripsCount ?? 0,
      extA: p?.extraTripsAuto ? 1 : 0,
      extCost: p?.extraTripCost ?? 0,
      bldgs: buildingsSig,
      mods: modulesSig,
    });
  }, [
    projectId, data.project?.destinationAddress, data.project?.waypointAddress,
    data.project?.returnToStart, data.project?.loadTimeMinutes, data.project?.workdayHours,
    data.project?.extraTripsCount, data.project?.extraTripsAuto, data.project?.extraTripCost,
    buildingsSig, modulesSig,
  ]);
  useEffect(() => {
    if (!data.project?.destinationAddress || data.buildings.length === 0) {
      // Geen reset op null als we al een persisted waarde hebben — anders zou de
      // begroting tijdens loading de transport-post tijdelijk verliezen.
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/transport/calculate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && typeof body.totalCost === "number") {
          setAutoAssemblageTransport(body.totalCost);
          // Trigger een refetch van data.project zodat de DB-waarde (zojuist
          // gepersist door /api/transport/calculate) ook in data.project landt.
          // Hierdoor blijft hydrate-logic + state consistent na een refresh.
          data.refetch();
        }
      } catch { /* stil falen — persisted waarde blijft staan */ }
    })();
    return () => { cancelled = true; };
  }, [transportSig]);

  const calcResult = useCalculation({
    project: data.project,
    buildings: data.buildings,
    modules: data.modules,
    buildingInputs: data.buildingInputs,
    overrides: data.overrides,
    materialsMap: data.materialsMap,
    kengetalRowsBySet: data.kengetalRowsBySet,
    kengetalLabourBySet: data.kengetalLabourBySet,
    allKengetalSets: data.allKengetalSets,
    transport: data.transport,
    markupRows: data.markupRows,
    labourRates: data.labourRates,
    csvAggregatesByBuilding: data.csvAggregatesByBuilding,
    csvOverridesByBuilding: data.csvOverridesByBuilding,
    autoAssemblageTransport,
  });

  // Active system = selected building's system (fall back to any system in the project)
  const activeSystem = useMemo(() => {
    const selected = data.buildings.find((b) => b.id === selectedBuildingId);
    if (selected?.kengetalSetId) {
      return data.allKengetalSets.find((s) => s.id === selected.kengetalSetId) ?? null;
    }
    // Fallback: first system encountered among buildings
    for (const b of data.buildings) {
      if (b.kengetalSetId) {
        const s = data.allKengetalSets.find((x) => x.id === b.kengetalSetId);
        if (s) return s;
      }
    }
    return null;
  }, [data.buildings, selectedBuildingId, data.allKengetalSets]);

  const tintStyle = systemTintStyle(activeSystem?.themeColor);

  const systemsInUse = Array.from(new Set(data.buildings.map((b) => b.kengetalSetId).filter(Boolean)))
    .map((id) => data.allKengetalSets.find((s) => s.id === id)).filter(Boolean);

  return (
    <ProjectContext.Provider value={{ data, calcResult, selectedBuildingId, setSelectedBuildingId, scopeAll, setScopeAll, scopedTotal: scopedTotals?.total ?? null, scopedGfa: scopedTotals?.gfa ?? null, setScopedTotals, autoAssemblageTransport, setAutoAssemblageTransport }}>
      <div className="min-h-screen transition-colors" style={{ ...tintStyle, backgroundColor: "var(--system-tint-soft)" }}>
        <AppHeader
          kengetalHref={
            projectId
              ? `/library/kengetallen?project=${projectId}${activeSystem ? `&set=${activeSystem.id}` : ""}`
              : undefined
          }
          materialsHref={projectId ? `/library/materials?project=${projectId}` : undefined}
          labourHref={projectId ? `/library/labour?project=${projectId}` : undefined}
          center={
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-[13px] font-semibold leading-tight tracking-[0.01em] text-gray-900">
                  {data.project?.name || "Laden..."}
                </h1>
                {data.project && (
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                    title="Projectinstellingen"
                    aria-label="Open projectinstellingen"
                  >
                    <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                {data.project?.client && <span>{data.project.client}</span>}
                {data.project?.client && data.project?.assemblyParty && <span className="text-gray-300">·</span>}
                {data.project?.assemblyParty && <span>{data.project.assemblyParty}</span>}
                {systemsInUse.length > 0 && (<>
                  <span className="text-gray-300">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <Layers className="h-3 w-3" strokeWidth={1.75} />
                    {systemsInUse.map((s) => {
                      const isActive = activeSystem?.id === s!.id;
                      return (
                        <span key={s!.id}
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            isActive ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
                          }`}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s!.themeColor }} />
                          {s!.name}
                        </span>
                      );
                    })}
                  </span>
                </>)}
              </div>
            </div>
          }
        />

        <main className="mx-auto max-w-[1400px] px-6 pb-6 pt-10">{children}</main>
        <FloatingTotals
          result={calcResult}
          scope={!scopeAll && selectedBuildingId ? { mode: "building", buildingId: selectedBuildingId } : { mode: "all" }}
          markupRows={data.markupRows}
          scopedTotalOverride={scopedTotals?.total}
          scopedGfaOverride={scopedTotals?.gfa}
        />
        {data.project && (
          <ProjectSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            project={data.project}
            onChanged={data.refetch}
          />
        )}
      </div>
    </ProjectContext.Provider>
  );
}
