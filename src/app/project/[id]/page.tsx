"use client";

import { useState, useMemo, useEffect } from "react";
import { useProjectContext } from "./layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BegrotingView } from "@/components/begroting-view";
import { NewModuleDialog } from "@/components/new-module-dialog";
import { StructuredInputs } from "@/components/structured-inputs";
import { formatQty } from "@/lib/calculation";
import { Plus, Trash2, Globe, Layers, ChevronLeft, ChevronRight } from "lucide-react";
import { MODULE_DERIVED_LABELS } from "@/types";
import type { Module } from "@/types";

const DERIVED_LABELS = new Set<string>(Object.values(MODULE_DERIVED_LABELS));

export default function ProjectPage() {
  const { data, calcResult, selectedBuildingId, setSelectedBuildingId, scopeAll, setScopeAll } = useProjectContext();
  const [moduleDialogOpen, setModuleDialogOpen] = useState(false);
  // Linker-paneel inklapbaar. Keuze blijft bewaard per browser.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("project-sidebar-collapsed") : null;
    if (saved === "1") setSidebarCollapsed(true);
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("project-sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  const { project, buildings, buildingInputs, modules, allKengetalSets, refetch } = data;

  const selectedBuilding = buildings.find((b) => b.id === selectedBuildingId) ?? null;
  const currentInputs = selectedBuildingId ? (buildingInputs.get(selectedBuildingId) ?? []) : [];
  const currentModules = selectedBuildingId ? (modules.get(selectedBuildingId) ?? []) : [];
  const currentBuildingCalc = useMemo(() =>
    calcResult?.buildings.find((b) => b.building.id === selectedBuildingId) ?? null,
  [calcResult, selectedBuildingId]);

  async function addBuilding() {
    const res = await fetch(`/api/projects/${project!.id}/buildings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const b = await res.json();
    setSelectedBuildingId(b.id);
    refetch();
  }
  async function patchBuilding(id: string, updates: Record<string, any>) {
    await fetch(`/api/projects/${project!.id}/buildings`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    refetch();
  }
  async function deleteBuilding(id: string) {
    if (!confirm("Gebouw verwijderen?")) return;
    await fetch(`/api/projects/${project!.id}/buildings?id=${id}`, { method: "DELETE" });
    refetch();
  }
  async function addModule(values: { lengthM: number; widthM: number; heightM: number; count: number; isRoof: boolean }) {
    if (!selectedBuildingId) return;
    await fetch(`/api/buildings/${selectedBuildingId}/modules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", ...values }),
    });
    refetch();
  }
  async function patchModule(id: string, updates: Partial<Module>) {
    await fetch(`/api/buildings/${selectedBuildingId}/modules`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    refetch();
  }
  async function deleteModule(id: string) {
    await fetch(`/api/buildings/${selectedBuildingId}/modules?id=${id}`, { method: "DELETE" });
    refetch();
  }
  async function updateInput(inputId: string, quantity: number) {
    if (!selectedBuildingId) return;
    const inputs = buildingInputs.get(selectedBuildingId) ?? [];
    await fetch(`/api/buildings/${selectedBuildingId}/inputs`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: inputs.map((inp) =>
          inp.id === inputId ? { id: inp.id, quantity } : { id: inp.id, quantity: inp.quantity },
        ),
      }),
    });
    refetch();
  }

  if (data.loading || !project) {
    return <div className="py-12 text-center text-muted-foreground">Laden...</div>;
  }

  const invulDisabled = scopeAll;
  const rightScope = scopeAll
    ? { mode: "all" as const }
    : selectedBuildingId
      ? { mode: "building" as const, buildingId: selectedBuildingId }
      : { mode: "all" as const };

  const derived = currentBuildingCalc?.derivedInputs ?? {};

  return (
    <div className="space-y-3">
      {/* Split — linker- en rechterkolom starten op exact dezelfde Y. De scope-
           toggle zit in het header-rijtje boven de modules-tabel (links), zodat
           hij niet als losse rij boven de grid komt te zweven. Een verticaal
           divider-paneel tussen de twee kolommen is de klikbare collapse-zone
           (zie het `divider`-grid-item hieronder). */}
      <div className={`relative grid items-start transition-[grid-template-columns] ${
        sidebarCollapsed
          ? "grid-cols-[0_24px_1fr]"
          : "grid-cols-[minmax(360px,440px)_24px_1fr]"
      }`}>
        <div
          className={`${sidebarCollapsed ? "overflow-hidden opacity-0 pointer-events-none" : ""}`}
          title={invulDisabled ? "Invoer werkt alleen per gebouw. Kies een gebouw-tab om te bewerken." : undefined}
          aria-hidden={sidebarCollapsed}
        >
          {/* Folder-tabs — "Totaal" + gebouwen + "+". Zelfde hoogte als de
               Begroting-tabs rechts, zodat beide panelen op exact dezelfde Y
               beginnen. Actieve tab is donker, inactieve grijs; allemaal lijnen
               ze naadloos aan op de witte content-container hieronder via de
               negative-margin truc. */}
          <div className="flex items-end gap-0 border-b border-gray-200 pl-1">
            <LeftTab
              active={scopeAll}
              onClick={() => setScopeAll(true)}
              icon={<Globe className="h-3 w-3" strokeWidth={1.75} />}
              label="Totaal"
              title="Alle gebouwen samen"
            />
            {buildings.map((b) => {
              const sys = allKengetalSets.find((s) => s.id === b.kengetalSetId);
              return (
                <LeftTab
                  key={b.id}
                  active={!scopeAll && b.id === selectedBuildingId}
                  onClick={() => { setScopeAll(false); setSelectedBuildingId(b.id); }}
                  dotColor={sys?.themeColor}
                  label={`${b.name} ×${b.count}`}
                  onDelete={buildings.length > 1 ? () => {
                    if (confirm(`Weet je zeker dat je "${b.name}" wilt verwijderen?\n\nAlle modules, inputs en instellingen van dit gebouw worden gewist. Deze actie kan niet ongedaan worden gemaakt.`)) {
                      deleteBuilding(b.id);
                    }
                  } : undefined}
                />
              );
            })}
            <button
              onClick={addBuilding}
              className="flex items-center gap-1 rounded-t-md border-b border-gray-200 px-2 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-900"
              title="Nieuw gebouw toevoegen"
              aria-label="Nieuw gebouw"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>

          {/* Content-container van het linkerpaneel — folder-tab sluit er met
               -mb-[1px] op aan. Inhoud is gedimd (niet-bewerkbaar) wanneer
               "Totaal" geselecteerd is. */}
          <div className={`rounded-b-md border border-t-0 border-gray-200 bg-white p-3 space-y-3 ${invulDisabled ? "pointer-events-none opacity-50" : ""}`}>

          {selectedBuilding && (
            <div className="rounded-md border bg-white" style={{ borderTopColor: "var(--system-tint)", borderTopWidth: 3 }}>
              <div className="flex items-center gap-2 border-b p-2">
                <Input
                  key={`name-${selectedBuilding.id}-${selectedBuilding.name}`}
                  className="h-7 flex-1 text-xs font-medium"
                  defaultValue={selectedBuilding.name}
                  onBlur={(e) => {
                    if (e.target.value !== selectedBuilding.name) {
                      patchBuilding(selectedBuilding.id, { name: e.target.value });
                    }
                  }}
                />
                <label className="text-xs text-muted-foreground">Aantal</label>
                <Input
                  key={`count-${selectedBuilding.id}-${selectedBuilding.count}`}
                  className="h-7 w-14 text-right text-xs tabular-nums"
                  type="number" min={1}
                  defaultValue={selectedBuilding.count}
                  onBlur={(e) => {
                    const v = parseInt(e.target.value) || 1;
                    if (v !== selectedBuilding.count) patchBuilding(selectedBuilding.id, { count: v });
                  }}
                />
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteBuilding(selectedBuilding.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>

              <div className="flex items-center gap-2 border-b bg-gray-50/60 p-2 text-xs">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Bouwsysteem:</span>
                <Select
                  value={selectedBuilding.kengetalSetId ?? ""}
                  onValueChange={(v) => patchBuilding(selectedBuilding.id, { kengetalSetId: v })}
                >
                  <SelectTrigger className="h-7 flex-1 text-xs"><SelectValue placeholder="Kies..." /></SelectTrigger>
                  <SelectContent>
                    {allKengetalSets.map((ks) => (
                      <SelectItem key={ks.id} value={ks.id}>
                        <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: ks.themeColor }} />
                        {ks.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="border-b p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-on-surface-var">Modules</span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setModuleDialogOpen(true)}>
                    <Plus className="mr-1 h-3 w-3" /> Toevoegen
                  </Button>
                </div>
                {currentModules.length > 0 ? (
                  <table className="w-full text-xs">
                    <colgroup>
                      <col style={{ width: "24%" }} />
                      <col style={{ width: "24%" }} />
                      <col style={{ width: "24%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "10%" }} />
                    </colgroup>
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-on-surface-var">
                        <th className="px-0.5 py-1 text-center font-medium">Lengte</th>
                        <th className="px-0.5 py-1 text-center font-medium">Breedte</th>
                        <th className="px-0.5 py-1 text-center font-medium">Hoogte</th>
                        <th className="px-0.5 py-1 text-center font-medium">Aantal</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {currentModules.map((m) => {
                        const lenWarn = m.lengthM > 0 && (m.lengthM < 2.0 || m.lengthM > 7.2)
                          ? `Modulelengte buiten Sustainer-bereik (2,0–7,2 m).` : null;
                        const brWarn = m.widthM > 0 && (m.widthM < 2.0 || m.widthM > 4.5)
                          ? `Modulebreedte buiten Sustainer-bereik (2,0–4,5 m).` : null;
                        const hWarn = m.heightM > 0 && (m.heightM < 3.1 || m.heightM > 3.2)
                          ? `Sustainer-modules zijn standaard 3,155 m hoog.` : null;
                        return (
                        <tr key={m.id}>
                          <td className="px-0.5 py-0.5">
                            <Input className={`h-7 w-full text-right text-xs tabular-nums ${lenWarn ? "border-amber-400 focus-visible:ring-amber-300" : ""}`}
                              type="number" step="0.001" defaultValue={m.lengthM.toFixed(3)}
                              title={lenWarn ?? undefined}
                              onBlur={(e) => patchModule(m.id, { lengthM: parseFloat(e.target.value) || 0 })} />
                          </td>
                          <td className="px-0.5 py-0.5">
                            <Input className={`h-7 w-full text-right text-xs tabular-nums ${brWarn ? "border-amber-400 focus-visible:ring-amber-300" : ""}`}
                              type="number" step="0.001" defaultValue={m.widthM.toFixed(3)}
                              title={brWarn ?? undefined}
                              onBlur={(e) => patchModule(m.id, { widthM: parseFloat(e.target.value) || 0 })} />
                          </td>
                          <td className="px-0.5 py-0.5">
                            <Input className={`h-7 w-full text-right text-xs tabular-nums ${hWarn ? "border-amber-400 focus-visible:ring-amber-300" : ""}`}
                              type="number" step="0.001" defaultValue={m.heightM.toFixed(3)}
                              title={hWarn ?? undefined}
                              onBlur={(e) => patchModule(m.id, { heightM: parseFloat(e.target.value) || 0 })} />
                          </td>
                          <td className="px-0.5 py-0.5">
                            <Input className="h-7 w-full text-right text-xs tabular-nums" type="number" min={1} defaultValue={m.count}
                              onBlur={(e) => patchModule(m.id, { count: parseInt(e.target.value) || 1 })} />
                          </td>
                          <td className="py-0.5">
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteModule(m.id)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="py-2 text-center text-[11px] text-on-surface-var">
                    Geen modules. Voeg er één toe om afgeleide invoer (oppervlak, aantal) te berekenen.
                  </p>
                )}

                {currentModules.length > 0 && (
                  <div className="mt-2 grid grid-cols-[1fr_6rem_3rem] items-center gap-x-2 gap-y-1 rounded bg-surface-low py-1.5 text-xs">
                    <span className="text-on-surface-var">Module oppervlak</span>
                    <span className="pr-3 text-right tabular-nums">{formatQty(derived[MODULE_DERIVED_LABELS.AREA] ?? 0)}</span>
                    <span className="text-on-surface-var">m²</span>
                    <span className="text-on-surface-var">Module Aant BG</span>
                    <span className="pr-3 text-right tabular-nums">{formatQty(derived[MODULE_DERIVED_LABELS.COUNT_BG] ?? 0)}</span>
                    <span className="text-on-surface-var"></span>
                    <span className="text-on-surface-var">Module Aant Dak</span>
                    <span className="pr-3 text-right tabular-nums">{formatQty(derived[MODULE_DERIVED_LABELS.COUNT_DAK] ?? 0)}</span>
                    <span className="text-on-surface-var"></span>
                    <span className="text-on-surface-var">Module Aant Tussenvd</span>
                    <span className="pr-3 text-right tabular-nums">{formatQty(derived[MODULE_DERIVED_LABELS.COUNT_TUSSEN] ?? 0)}</span>
                    <span className="text-on-surface-var"></span>
                    <span className="text-on-surface-var">Module lengte totaal</span>
                    <span className="pr-3 text-right tabular-nums">{formatQty(derived[MODULE_DERIVED_LABELS.LENGTH_TOTAL] ?? 0)}</span>
                    <span className="text-on-surface-var">m¹</span>
                    <span className="text-on-surface-var">Module breedte totaal</span>
                    <span className="pr-3 text-right tabular-nums">{formatQty(derived[MODULE_DERIVED_LABELS.WIDTH_TOTAL] ?? 0)}</span>
                    <span className="text-on-surface-var">m¹</span>
                  </div>
                )}
              </div>

              <div className="px-2 pb-2">
                <StructuredInputs
                  buildingId={selectedBuilding.id}
                  inputs={currentInputs}
                  modules={currentModules}
                  onChanged={refetch}
                  kengetalSetName={allKengetalSets.find((s) => s.id === selectedBuilding.kengetalSetId)?.name ?? null}
                  knownLabels={(() => {
                    const setId = selectedBuilding.kengetalSetId;
                    const kgRows = setId ? data.kengetalRowsBySet.get(setId) ?? [] : [];
                    return Array.from(new Set(kgRows.map((k) => k.inputLabel)));
                  })()}
                />
              </div>
            </div>
          )}
          </div>
        </div>

        {/* Verticale divider = klikbare collapse-zone. Hele strook is klikbaar;
             de grip-pill in het midden is een prominente, duidelijke knop met
             eigen border + shadow-md zodat hij opvalt als handvat. Click-to-toggle. */}
        <button
          onClick={() => setSidebarCollapsed((v) => !v)}
          className="group relative mx-auto flex h-full w-[24px] cursor-pointer items-center justify-center transition-colors hover:bg-gray-100/50"
          title={sidebarCollapsed ? "Invoer tonen" : "Invoer verbergen"}
          aria-label={sidebarCollapsed ? "Invoer tonen" : "Invoer verbergen"}
          aria-expanded={!sidebarCollapsed}
        >
          {/* Verticale lijn — subtiel, verdwijnt onder de grip-pill. */}
          <span aria-hidden className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-gray-200" />
          {/* Grip-pill — prominent: brede verticale pil met shadow-md en z-20 zodat
               hij duidelijk boven de inhoud zweeft als klikbaar handvat. */}
          <span
            aria-hidden
            className="relative z-20 flex h-10 w-3 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 shadow-sm transition-colors group-hover:border-gray-400 group-hover:bg-gray-50 group-hover:text-gray-900"
          >
            {sidebarCollapsed
              ? <ChevronRight className="h-3 w-3" strokeWidth={2} />
              : <ChevronLeft className="h-3 w-3" strokeWidth={2} />}
          </span>
        </button>

        <div className="min-w-0">
          <BegrotingView scope={rightScope} density="dense" />
        </div>
      </div>

      <NewModuleDialog
        open={moduleDialogOpen}
        onOpenChange={setModuleDialogOpen}
        onSubmit={addModule}
        tintColor={allKengetalSets.find((s) => s.id === selectedBuilding?.kengetalSetId)?.themeColor}
      />
    </div>
  );
}

// ── LeftTab ────────────────────────────────────────────────────────
// Folder-tab voor het linkerpaneel. Gedraagt zich als de TabPill van de
// Begroting: actieve tab zit via -mb-[1px] over de top-rand van de content-
// container heen, inactief is gedempt en zit ernáást op dezelfde baseline.
// Extra: optionele delete-knop verschijnt bij hover op de actieve tab.
function LeftTab({
  active, onClick, label, icon, dotColor, onDelete, title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  dotColor?: string;
  onDelete?: () => void;
  title?: string;
}) {
  // Folder-tab: exact dezelfde styling als de rechter-paneel-tabs — witte
  // achtergrond + donkere tekst voor actief, muted grijs voor inactief. De
  // gekleurde dot (bouwsysteem) is voldoende om het actieve gebouw visueel te
  // markeren; de folder-tab connect-truc (-mb-[1px] + border-b-white + z-10)
  // werkt alleen als de tab-bg 1-op-1 matcht met de content-container.
  if (active) {
    // Active tab: overlaps container's top border exactly (the -mb-[1px] +
    // border-b-white truc). Exact match met TabPill op het rechterpaneel.
    return (
      <div
        className="group relative z-10 -mb-[1px] flex h-[30px] items-center gap-1.5 rounded-t-md border border-b-white border-gray-200 bg-white px-3 text-xs font-semibold text-gray-900"
        title={title}
      >
        {icon}
        {dotColor && <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: dotColor }} />}
        <button onClick={onClick} className="flex items-center">
          <span>{label}</span>
        </button>
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="rounded p-0.5 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-destructive group-hover:opacity-60 hover:!opacity-100"
            title="Verwijder gebouw"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      className="flex h-[30px] items-center gap-1.5 rounded-t-md border-b border-gray-200 bg-gray-100 px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
      title={title}
    >
      {icon}
      {dotColor && <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: dotColor }} />}
      <span>{label}</span>
    </button>
  );
}
