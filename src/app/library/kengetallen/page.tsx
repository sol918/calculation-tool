"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { systemTintStyle } from "@/lib/theme";
import { COST_GROUP_LABELS, formatNumber } from "@/lib/calculation";
import { deriveInputsFromModules } from "@/lib/calculation";
import type { Building, BuildingInput, Module } from "@/types";
import { ChevronRight, Plus, Trash2, Layers } from "lucide-react";
import { AppHeader, HeaderContext } from "@/components/app-header";
import { STANDARD_CATEGORIES, BOUWPAKKET_PROCESSING_CATEGORIES, BOUWPAKKET_PROCESSING_LABEL_SET, CATEGORY_GROUP_ORDER, CATEGORY_GROUP_LABELS, SUBGROUP_COLORS } from "@/lib/kengetal-categories";
import type { CategoryGroup, CategorySubgroup } from "@/lib/kengetal-categories";

/** Invoer-labels die meedoen in de afbouwniveau-formule. Match met
 *  calculation.ts (totaal afgewerkt oppervlak = som van deze m²/m¹ × hoogte × 2). */
const AFBOUW_SURFACE_LABELS = new Set([
  "Module Opp Plafond",
  "Module Opp Dak",
  "Dichte gevel",
  "WSW", "Verzwaarde WSW", "Extra verzwaarde WSW",
  "WSW korte zijde", "WSW lange zijde",
  "Binnenwand",
]);
import type { KengetalSet, KengetalRow, KengetalLabour, Material } from "@/types";

export default function KengetallenLibraryPage() {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get("project");
  const [projectName, setProjectName] = useState<string>("");
  const { role } = useRole();
  const [sets, setSets] = useState<KengetalSet[]>([]);
  const [activeSetId, setActiveSetId] = useState<string>("");
  const [rows, setRows] = useState<KengetalRow[]>([]);
  const [labour, setLabour] = useState<KengetalLabour[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  /** Project context — ingevuld zodra ?project=X aanwezig is. */
  const [projectBuildings, setProjectBuildings] = useState<
    { building: Building; inputs: BuildingInput[]; modules: Module[] }[]
  >([]);

  useEffect(() => {
    if (!projectId) { setProjectName(""); setProjectBuildings([]); return; }
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((p) => setProjectName(p?.name ?? ""));
    fetch(`/api/projects/${projectId}/buildings`).then((r) => r.json()).then(async (buildings: Building[]) => {
      const loaded = await Promise.all(buildings.map(async (b) => {
        const [i, m] = await Promise.all([
          fetch(`/api/buildings/${b.id}/inputs`).then((r) => r.json()),
          fetch(`/api/buildings/${b.id}/modules`).then((r) => r.json()),
        ]);
        return { building: b, inputs: i as BuildingInput[], modules: m as Module[] };
      }));
      setProjectBuildings(loaded);
    });
  }, [projectId]);

  const canEdit = role === "owner" || role === "assembler";

  useEffect(() => {
    Promise.all([
      fetch("/api/kengetal-sets").then((r) => r.json()),
      fetch("/api/materials").then((r) => r.json()),
    ]).then(([s, m]: [KengetalSet[], Material[]]) => {
      setSets(s);
      setMaterials(m);
      // Source van het actieve bouwsysteem in volgorde van prio:
      //   1. URL `?set=...`     (gedeeld linkje vanuit een project)
      //   2. localStorage       (laatste selectie van deze gebruiker)
      //   3. eerste set         (fallback bij eerste bezoek)
      const requested = params.get("set");
      const stored = typeof window !== "undefined"
        ? window.localStorage.getItem("kengetallen.activeSetId")
        : null;
      const initial =
        (requested && s.find((x) => x.id === requested) ? requested : null) ??
        (stored && s.find((x) => x.id === stored) ? stored : null) ??
        (s[0]?.id ?? "");
      setActiveSetId(initial);
    });
  }, []);

  // Persist actieve set zodra die wijzigt — overleeft navigatie en page refresh.
  useEffect(() => {
    if (!activeSetId) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem("kengetallen.activeSetId", activeSetId);
    }
    fetch(`/api/kengetal-sets/${activeSetId}/rows`).then((r) => r.json()).then(setRows);
    fetch(`/api/kengetal-sets/${activeSetId}/labour`).then((r) => r.json()).then(setLabour);
    setSelectedLabel(null);
  }, [activeSetId]);

  const activeSet = sets.find((s) => s.id === activeSetId) ?? null;
  const tintStyle = systemTintStyle(activeSet?.themeColor);

  // Group rows by inputLabel
  const labelGroups = useMemo(() => {
    const g = new Map<string, { unit: string; rows: KengetalRow[] }>();
    for (const r of rows) {
      const existing = g.get(r.inputLabel);
      if (existing) existing.rows.push(r);
      else g.set(r.inputLabel, { unit: r.inputUnit, rows: [r] });
    }
    return g;
  }, [rows]);

  const detailRows = selectedLabel ? (labelGroups.get(selectedLabel)?.rows ?? []) : [];
  const matById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);

  // Union of standard categories and any custom labels already in the set.
  // Bevat ook labels die alleen in kengetal_labour staan (arbeid zonder materialen),
  // zodat geen categorie "verborgen" is voor de gebruiker.
  // (Bewerkings-categorieën Gezaagd / CNC / Kramerijen zijn géén top-level
  // invoercategorieën — die komen inline onder een categorie-detail.)
  type CatEntry = { label: string; unit: string; count: number; isStandard: boolean; group: CategoryGroup; subgroup: CategorySubgroup | null };
  const allCategories = useMemo(() => {
    const merged = new Map<string, CatEntry>();
    for (const s of STANDARD_CATEGORIES) {
      const match = labelGroups.get(s.label);
      merged.set(s.label, { label: s.label, unit: s.unit, count: match?.rows.length ?? 0, isStandard: true, group: s.group, subgroup: s.subgroup });
    }
    for (const [label, g] of labelGroups) {
      if (merged.has(label)) continue;
      if (BOUWPAKKET_PROCESSING_LABEL_SET.has(label)) continue;
      merged.set(label, { label, unit: g.unit, count: g.rows.length, isStandard: false, group: "overig", subgroup: null });
    }
    for (const lr of labour) {
      if (merged.has(lr.inputLabel)) continue;
      if (BOUWPAKKET_PROCESSING_LABEL_SET.has(lr.inputLabel)) continue;
      const unit = /oppervlak|Opp /i.test(lr.inputLabel) ? "m²"
        : /Aantal|Badkamers|toilet|kozijnen|voordeuren|binnendeuren|Balkons stuks/i.test(lr.inputLabel) ? "stuks"
        : /lengte|breedte|Binnenwand|WSW|omtrek|m1|m¹/i.test(lr.inputLabel) ? "m¹"
        : "stuks";
      merged.set(lr.inputLabel, { label: lr.inputLabel, unit, count: 0, isStandard: false, group: "overig", subgroup: null });
    }
    return Array.from(merged.values());
  }, [labelGroups, labour]);

  // Gegroepeerd voor het linker-paneel. Volgorde van labels per groep volgt
  // STANDARD_CATEGORIES; custom labels komen onder "Overig".
  const groupedCategories = useMemo(() => {
    const order = new Map(STANDARD_CATEGORIES.map((s, i) => [s.label, i]));
    const byGroup = new Map<CategoryGroup, CatEntry[]>();
    for (const c of allCategories) {
      const list = byGroup.get(c.group) ?? [];
      list.push(c);
      byGroup.set(c.group, list);
    }
    for (const list of byGroup.values()) {
      list.sort((a, b) => (order.get(a.label) ?? 999) - (order.get(b.label) ?? 999));
    }
    return CATEGORY_GROUP_ORDER.map((g) => ({ group: g, items: byGroup.get(g) ?? [] })).filter((x) => x.items.length > 0);
  }, [allCategories]);

  // Per-label totaal qty + materiaal-kosten in het project (alle gebouwen die
  // dit bouwsysteem gebruiken). Resulteert in { qty, cost } voor elke standard
  // category — getoond rechts op de invoer-rij in grijs ter check.
  const projectTotals = useMemo(() => {
    const totals = new Map<string, { qty: number; cost: number }>();
    if (!projectId || projectBuildings.length === 0) return totals;
    const matById = new Map(materials.map((m) => [m.id, m]));
    const rateMap = new Map(rows.map((r) => [`${r.inputLabel}|${r.materialId}`, r]));

    for (const pb of projectBuildings) {
      if (pb.building.kengetalSetId && pb.building.kengetalSetId !== activeSetId) continue;
      const oppBGG = pb.inputs.find((i) => i.inputLabel === "_opp_begane_grond")?.quantity ?? 0;
      const derived = deriveInputsFromModules(pb.modules, oppBGG);
      const eff: Record<string, number> = {};
      for (const inp of pb.inputs) eff[inp.inputLabel] = inp.quantity;
      for (const [k, v] of Object.entries(derived)) eff[k] = v;
      const buildingMult = pb.building.count || 1;

      for (const c of allCategories) {
        const qty = (eff[c.label] ?? 0) * buildingMult;
        let cost = 0;
        // Som van (qty × ratio × (1+loss) × prijs) over alle kengetal-rijen voor dit label.
        for (const kg of rows.filter((r) => r.inputLabel === c.label)) {
          const mat = matById.get(kg.materialId);
          if (!mat) continue;
          cost += qty * kg.ratio * (1 + mat.lossPct) * mat.pricePerUnit;
        }
        const ex = totals.get(c.label) ?? { qty: 0, cost: 0 };
        ex.qty += qty;
        ex.cost += cost;
        totals.set(c.label, ex);
      }
    }
    return totals;
  }, [projectBuildings, allCategories, rows, materials, activeSetId, projectId]);

  const selectedUnit = (selectedLabel
    ? (labelGroups.get(selectedLabel)?.unit ?? STANDARD_CATEGORIES.find((s) => s.label === selectedLabel)?.unit)
    : undefined) ?? "m²";

  async function addRow() {
    if (!activeSetId) return;
    const label = selectedLabel ?? "Nieuw veld";
    const unit = selectedUnit;
    const firstMat = materials[0];
    if (!firstMat) { alert("Geen materialen beschikbaar"); return; }
    const res = await fetch(`/api/kengetal-sets/${activeSetId}/rows`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputLabel: label, inputUnit: unit, materialId: firstMat.id, ratio: 0 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Toevoegen mislukt: ${err.error ?? res.statusText}`);
      return;
    }
    const next = await fetch(`/api/kengetal-sets/${activeSetId}/rows`).then((r) => r.json());
    setRows(next);
  }

  async function updateRow(row: KengetalRow, updates: Partial<KengetalRow>) {
    const res = await fetch(`/api/kengetal-sets/${activeSetId}/rows`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, ...updates }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Update mislukt: ${err.error ?? res.statusText}`);
      return;
    }
    const next = await fetch(`/api/kengetal-sets/${activeSetId}/rows`).then((r) => r.json());
    setRows(next);
    // If we renamed the label and had it selected, follow it.
    if (updates.inputLabel && row.inputLabel === selectedLabel) setSelectedLabel(updates.inputLabel);
  }

  async function deleteRow(id: string) {
    await fetch(`/api/kengetal-sets/${activeSetId}/rows?rowId=${id}`, { method: "DELETE" });
    const next = await fetch(`/api/kengetal-sets/${activeSetId}/rows`).then((r) => r.json());
    setRows(next);
  }

  async function upsertLabour(inputLabel: string, updates: {
    hoursPerInput?: number;
    installatieHoursPerInput?: number;
    arbeidBuitenHrsPerInput?: number;
    projectmgmtHrsPerInput?: number;
    gezaagdM3PerInput?: number;
    cncSimpelM3PerInput?: number;
    cncComplexM3PerInput?: number;
    description?: string;
  }) {
    const res = await fetch(`/api/kengetal-sets/${activeSetId}/labour`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputLabel, ...updates }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Arbeid opslaan mislukt: ${err.error ?? res.statusText}`);
      return;
    }
    const next = await fetch(`/api/kengetal-sets/${activeSetId}/labour`).then((r) => r.json());
    setLabour(next);
  }

  const selectedLabour = selectedLabel ? labour.find((l) => l.inputLabel === selectedLabel) : undefined;

  /**
   * Totaal-hoeveelheid van de geselecteerde categorie over alle gebouwen van het project
   * die dit bouwsysteem gebruiken. Inclusief module-derivaties (Opp BG, Plafond, Aantal BG/Dak/etc.).
   */
  const projectTotalForSelected = useMemo(() => {
    if (!selectedLabel || !projectId || projectBuildings.length === 0) return null;
    let total = 0;
    let nBuildings = 0;
    for (const pb of projectBuildings) {
      if (pb.building.kengetalSetId && pb.building.kengetalSetId !== activeSetId) continue;
      nBuildings++;
      const oppBGG = pb.inputs.find((i) => i.inputLabel === "_opp_begane_grond")?.quantity ?? 0;
      const derived = deriveInputsFromModules(pb.modules, oppBGG);
      const eff: Record<string, number> = {};
      for (const inp of pb.inputs) eff[inp.inputLabel] = inp.quantity;
      for (const [k, v] of Object.entries(derived)) eff[k] = v;
      const qty = eff[selectedLabel] ?? 0;
      total += qty * (pb.building.count || 1);
    }
    return { total, nBuildings };
  }, [selectedLabel, projectId, projectBuildings, activeSetId]);

  // Role-gate: developer (VORM) mag de kengetallen-bibliotheek niet openen.
  if (role === "developer") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="max-w-sm rounded-lg bg-white p-8 text-center shadow-sm ring-1 ring-gray-200">
          <div className="mb-2 text-sm font-semibold text-gray-900">Geen toegang</div>
          <p className="text-xs text-gray-500">
            De kengetallen-bibliotheek is alleen beschikbaar voor Sustainer en Stamhuis.
          </p>
          <button onClick={() => router.push("/")}
            className="mt-4 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800">
            Terug naar projecten
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen transition-colors" style={{ ...tintStyle, backgroundColor: "var(--system-tint-soft)" }}>
      <AppHeader
        backLink={projectId && projectName ? { label: projectName, href: `/project/${projectId}` } : undefined}
        materialsHref={projectId ? `/library/materials?project=${projectId}` : undefined}
        style={{ boxShadow: "inset 0 3px 0 0 var(--system-tint)" }}
        center={
          <HeaderContext
            icon={Layers}
            iconColor="var(--system-tint)"
            title="Kengetallen"
            subtitle="Bouwsysteem"
          >
            <Select value={activeSetId} onValueChange={setActiveSetId}>
              <SelectTrigger className="h-7 min-w-[180px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {sets.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: s.themeColor }} />
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </HeaderContext>
        }
      />

      <main className="mx-auto max-w-[1400px] px-6 pb-6 pt-10">
        {activeSet && activeSet.description && (
          <p className="mb-3 text-xs text-muted-foreground">{activeSet.description}</p>
        )}

        <div className="grid gap-4 md:grid-cols-[340px_1fr]">
          {/* Left: input-label overview — gegroepeerd op modules / gevels / wanden /
              installaties / overig, met sub-groep kleurindicator zodat verwante
              labels (b.v. alle Module Opp X) in één tint staan. */}
          <div className="rounded-md border bg-white">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
              <span className="font-semibold">Invoercategorieën</span>
              <span className="text-muted-foreground">{allCategories.length}</span>
            </div>
            <div className="max-h-[75vh] overflow-auto">
              {groupedCategories.map(({ group, items }) => (
                <div key={group}>
                  <div className="sticky top-0 z-10 border-b bg-gray-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {CATEGORY_GROUP_LABELS[group]}
                  </div>
                  {items.map((c) => {
                    const active = selectedLabel === c.label;
                    const colors = c.subgroup ? SUBGROUP_COLORS[c.subgroup] : null;
                    const totals = projectTotals.get(c.label);
                    return (
                      <button
                        key={c.label}
                        onClick={() => setSelectedLabel(c.label)}
                        className={`flex w-full items-stretch border-b text-left text-xs last:border-0 hover:bg-gray-50 ${active ? "bg-gray-50" : ""} ${c.count === 0 ? "text-muted-foreground" : ""}`}
                      >
                        <div
                          className="w-1 shrink-0"
                          style={{ backgroundColor: colors ? colors.bar : "transparent" }}
                          title={colors?.label}
                        />
                        <div className="flex flex-1 items-center justify-between px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">{c.label}</div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {c.count} materialen · {c.unit}
                              {!c.isStandard && " · custom"}
                              {totals && totals.qty > 0 && (
                                <span className="ml-1 text-[10px] text-gray-400">
                                  · {formatNumber(totals.qty, totals.qty < 10 ? 1 : 0)} {c.unit}
                                  {totals.cost > 0 && ` · €${formatNumber(totals.cost, 0)}`}
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Right: detail for selected label */}
          <div className="rounded-md border bg-white">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
              <span className="font-semibold">
                {selectedLabel ?? "Kies een invoercategorie"}
              </span>
              {canEdit && (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={addRow}>
                  <Plus className="mr-1 h-3 w-3" /> {selectedLabel ? "Rij toevoegen" : "Nieuwe categorie"}
                </Button>
              )}
            </div>

            {selectedLabel && projectTotalForSelected && projectTotalForSelected.nBuildings > 0 && (
              <div className="border-b bg-emerald-50/70 px-3 py-1.5 text-[11px] text-emerald-900">
                <span className="font-semibold">In dit project:</span>{" "}
                <span className="tabular-nums">{formatNumber(projectTotalForSelected.total, 1)}</span>{" "}
                {selectedUnit}{" "}
                <span className="opacity-70">
                  ({projectTotalForSelected.nBuildings} {projectTotalForSelected.nBuildings === 1 ? "gebouw" : "gebouwen"})
                </span>
              </div>
            )}

            {selectedLabel && (() => {
              const isAfbouwSurface = AFBOUW_SURFACE_LABELS.has(selectedLabel);
              // Grid-kolommen ZELFDE als de materiaal-tabel hieronder, zodat de
              // input-cellen verticaal uitlijnen met de Ratio-kolom van de tabel.
              //   col1 (1fr) = label · col2 (5rem) = empty · col3 (5rem) = input
              //   col4 (5rem) = unit · col5 (rest) = bestemming-hint
              // Grid-kolommen ZELFDE als de materiaal-tabel (nu zonder "Groep"-col):
              //   col1 (1fr) = label · col2 (5rem) = input · col3 (5rem) = eenheid
              //   col4 (7rem) = hint
              const labRow = (label: string, value: number, key: string, onSave: (v: number) => void, dest: string, auto?: boolean) => (
                <div className="grid grid-cols-[1fr_5rem_5rem_7rem] items-center gap-x-2 px-3 py-1.5 text-[11px]">
                  <span className="font-medium text-foreground">{label}{auto && <span className="ml-1 text-[10px] text-muted-foreground">(auto)</span>}</span>
                  {auto || !canEdit ? (
                    <span className="text-right tabular-nums text-muted-foreground">{formatNumber(value, 4)}</span>
                  ) : (
                    <Input
                      key={key}
                      className="h-7 w-full text-right text-xs tabular-nums"
                      inputMode="decimal"
                      defaultValue={value}
                      onBlur={(e) => {
                        const raw = e.target.value.replace(",", ".").trim();
                        if (raw === "") return;
                        const v = parseFloat(raw);
                        if (!isNaN(v) && v !== value) onSave(v);
                      }}
                    />
                  )}
                  <span className="text-[10px] text-muted-foreground">u/{selectedUnit}</span>
                  <span className="text-[10px] text-muted-foreground"><span className="opacity-60">→ {dest}</span></span>
                </div>
              );
              return (
                <div className="border-b py-1 text-[11px]">
                  <div className="mb-1 px-3 text-muted-foreground">
                    Invoer in <span className="font-medium text-foreground">{selectedUnit}</span>.
                    Ratio = materiaal per {selectedUnit}.
                  </div>
                  {labRow("Assemblagearbeid",
                    selectedLabour?.hoursPerInput ?? 0,
                    `lab-asm-${selectedLabel}-${selectedLabour?.hoursPerInput ?? 0}`,
                    (v) => upsertLabour(selectedLabel, { hoursPerInput: v }),
                    "arbeid",
                  )}
                  {labRow("Installatiearbeid",
                    selectedLabour?.installatieHoursPerInput ?? 0,
                    `lab-inst-${selectedLabel}-${selectedLabour?.installatieHoursPerInput ?? 0}`,
                    (v) => upsertLabour(selectedLabel, { installatieHoursPerInput: v }),
                    "installateur",
                  )}
                  {labRow("Arbeid buiten",
                    (selectedLabour as any)?.arbeidBuitenHrsPerInput ?? 0,
                    `lab-arbb-${selectedLabel}-${(selectedLabour as any)?.arbeidBuitenHrsPerInput ?? 0}`,
                    (v) => upsertLabour(selectedLabel, { arbeidBuitenHrsPerInput: v }),
                    "arbeid buiten",
                  )}
                  {/* Afbouw — read-only, alleen op afbouw-relevante oppervlakte-categorieën. */}
                  {isAfbouwSurface && (() => {
                    // Lees afbouwniveau uit eerste gebouw van het project (bij project-context).
                    // Default 2 (Q2/C) als niets gekozen of geen project context.
                    const RATES: Record<number, { uren: number; label: string }> = {
                      1: { uren: 0.10, label: "Q1 / Klasse E" },
                      4: { uren: 0.23, label: "Q1+spuit" },
                      2: { uren: 0.30, label: "Q2 / Klasse C" },
                      3: { uren: 1.00, label: "Q4 / Klasse A" },
                    };
                    const lvl = projectBuildings[0]?.inputs.find((i) => i.inputLabel === "_afbouwniveau")?.quantity;
                    const lvlNum = lvl ? Math.round(lvl) : 2;
                    const cfg = RATES[lvlNum] ?? RATES[2];
                    return (
                      <div className="grid grid-cols-[1fr_5rem_5rem_7rem] items-center gap-x-2 px-3 py-1.5 text-[11px]">
                        <span className="font-medium text-foreground">
                          Afbouw <span className="ml-1 text-[10px] text-muted-foreground">(auto · {cfg.label})</span>
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">{formatNumber(cfg.uren, 2)}</span>
                        <span className="text-[10px] text-muted-foreground">u/m²</span>
                        <span className="text-[10px] text-muted-foreground"><span className="opacity-60">→ assemblagehal</span></span>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {selectedLabel && detailRows.length > 0 ? (
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  <col />                         {/* Materiaal — flex */}
                  <col className="w-[5rem]" />    {/* Ratio input */}
                  <col className="w-[5rem]" />    {/* Eenheid */}
                  <col className="w-[7rem]" />    {/* Toelichting */}
                  {canEdit && <col className="w-8" />}
                </colgroup>
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Materiaal</th>
                    <th className="px-3 py-1.5 text-right font-medium">Ratio</th>
                    <th className="px-3 py-1.5 font-medium">Eenheid</th>
                    <th className="px-3 py-1.5 font-medium">Toelichting</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((row) => {
                    const m = matById.get(row.materialId);
                    const ratioUnit = m ? `${m.unit}/${selectedUnit}` : "";
                    return (
                      <tr key={row.id} className="odd:bg-white even:bg-gray-50/40">
                        <td className="px-3 py-1">
                          {canEdit ? (
                            <Select value={row.materialId} onValueChange={(v) => updateRow(row, { materialId: v })}>
                              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {materials.map((x) => (
                                  <SelectItem key={x.id} value={x.id}>{x.code} — {x.name} ({x.unit})</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (<span>{m?.code} — {m?.name}</span>)}
                        </td>
                        <td className="px-3 py-1">
                          {canEdit ? (
                            <Input
                              key={`${row.id}-ratio-${row.ratio}`}
                              className="h-7 w-full text-right text-xs tabular-nums"
                              inputMode="decimal"
                              defaultValue={row.ratio}
                              onBlur={(e) => {
                                const raw = e.target.value.replace(",", ".").trim();
                                if (raw === "") return;
                                const v = parseFloat(raw);
                                if (!isNaN(v) && v !== row.ratio) updateRow(row, { ratio: v });
                              }}
                            />
                          ) : (<span className="block text-right tabular-nums">{row.ratio}</span>)}
                        </td>
                        <td className="px-3 py-1">
                          <div className="text-[10px] text-muted-foreground">{ratioUnit}</div>
                        </td>
                        <td className="px-3 py-1">
                          {canEdit ? (
                            <Input
                              key={`${row.id}-desc-${row.description ?? ""}`}
                              className="h-7 text-xs"
                              defaultValue={row.description ?? ""}
                              onBlur={(e) => {
                                if (e.target.value !== (row.description ?? "")) {
                                  updateRow(row, { description: e.target.value });
                                }
                              }} />
                          ) : (<span className="text-muted-foreground">{row.description}</span>)}
                        </td>
                        {canEdit && (
                          <td className="px-2 py-1">
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteRow(row.id)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
                {selectedLabel
                  ? "Geen rijen voor deze categorie."
                  : "Kies een invoercategorie links om de gekoppelde materialen en ratios te bekijken."}
              </div>
            )}

            {selectedLabel && (() => {
              // Totaal bouwpakket-m³ per categorie-eenheid: som van ratios van
              // bouwpakket-materiaal-rijen in m³. I-joists (m1) en folies (m²)
              // tellen NIET mee — Gezaagd/CNC/Steenachtig/Kramerijen gaan puur over volumes.
              // Steenachtig = FERM18 + FERM10 + CEMVIN (auto-afgeleid, niet bewerkbaar).
              let totalBouwpakketM3 = 0;
              let steenachtigAuto = 0;
              for (const r of detailRows) {
                const m = matById.get(r.materialId);
                if (!m || m.costGroup !== "bouwpakket") continue;
                const u = m.unit.toLowerCase();
                if (u !== "m³" && u !== "m3") continue;
                totalBouwpakketM3 += r.ratio;
                if (m.code === "FERM18" || m.code === "FERM10" || m.code === "CEMVIN") steenachtigAuto += r.ratio;
              }
              if (totalBouwpakketM3 <= 0) return null;

              const procFields: { key: "gezaagdM3PerInput" | "cncSimpelM3PerInput" | "cncComplexM3PerInput"; label: string }[] = [
                { key: "gezaagdM3PerInput",     label: "Gezaagd" },
                { key: "cncSimpelM3PerInput",   label: "CNC simpel" },
                { key: "cncComplexM3PerInput",  label: "CNC complex" },
              ];
              const processedSum =
                (selectedLabour?.gezaagdM3PerInput ?? 0) +
                (selectedLabour?.cncSimpelM3PerInput ?? 0) +
                (selectedLabour?.cncComplexM3PerInput ?? 0) +
                steenachtigAuto; // Steenachtig = auto-afgeleid uit Fermacell + Cemvin
              const diff = Math.abs(processedSum - totalBouwpakketM3);
              // Waarschuwing pas tonen bij een duidelijk verschil — kleine floating-point
              // of afrondingsresten (< 0,0005 m³) verbergen we.
              const matches = diff < 5e-4;
              const unitSuffix = `m³/${selectedUnit}`;

              return (
                <div className="border-t bg-gray-50/50 px-3 py-2">
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Bouwpakket-bewerking
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      totaal bouwpakket {formatNumber(totalBouwpakketM3, 4)} {unitSuffix}
                    </span>
                  </div>
                  <div className="grid grid-cols-[auto_6rem_auto] items-center gap-x-2 gap-y-1 text-xs">
                    {procFields.map((f) => (
                      <div key={f.key} className="contents">
                        <span className="text-foreground">{f.label}</span>
                        {canEdit ? (
                          <Input
                            key={`${selectedLabel}-${f.key}-${selectedLabour?.[f.key] ?? 0}`}
                            className="h-7 w-20 text-right text-xs tabular-nums"
                            inputMode="decimal"
                            defaultValue={selectedLabour?.[f.key] ?? 0}
                            onBlur={(e) => {
                              const raw = e.target.value.replace(",", ".").trim();
                              if (raw === "") return;
                              const v = parseFloat(raw);
                              const cur = selectedLabour?.[f.key] ?? 0;
                              if (!isNaN(v) && v !== cur) {
                                upsertLabour(selectedLabel, { [f.key]: v });
                              }
                            }}
                          />
                        ) : (
                          <span className="tabular-nums">{selectedLabour?.[f.key] ?? 0}</span>
                        )}
                        <span className="text-[10px] text-muted-foreground">{unitSuffix}</span>
                      </div>
                    ))}
                    {steenachtigAuto > 0 && (
                      <div className="contents">
                        <span className="text-muted-foreground">Steenachtig <span className="text-[10px] opacity-70">(auto · Fermacell + Cemvin)</span></span>
                        <span className="pr-2 text-right tabular-nums text-muted-foreground">
                          {formatNumber(steenachtigAuto, 4)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{unitSuffix}</span>
                      </div>
                    )}
                    <div className="contents">
                      <span className="text-muted-foreground">Kramerijen <span className="text-[10px] opacity-70">(auto)</span></span>
                      <span className="pr-2 text-right tabular-nums text-muted-foreground">
                        {formatNumber(totalBouwpakketM3, 4)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{unitSuffix}</span>
                    </div>
                  </div>
                  {!matches && (
                    <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                      ⚠ Gezaagd + CNC simpel + CNC complex + Steenachtig = {formatNumber(processedSum, 4)} {unitSuffix},
                      maar het bouwpakket-totaal is {formatNumber(totalBouwpakketM3, 4)} {unitSuffix}.
                      Verschil: {formatNumber(processedSum - totalBouwpakketM3, 4)} {unitSuffix}.
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </main>
    </div>
  );
}
