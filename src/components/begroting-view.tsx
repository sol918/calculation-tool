"use client";

import React, { useRef, useState } from "react";
import { useProjectContext } from "@/app/project/[id]/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatEUR, formatEURsmart, formatNumber, formatQty, COST_GROUP_LABELS, BASIS_LABELS, computeAutoPolandTransport, computeLearningFactor, computeEngineering, computeKolomCorrectie, csvQtyForMaterial, computeBvo, DEFAULT_EFFICIENCY } from "@/lib/calculation";
import { ChevronDown, ChevronRight, Plus, Trash2, Truck, Receipt, TrendingDown, Download, Settings, Wrench, Columns, FileSpreadsheet, Upload, ClipboardList } from "lucide-react";
import { BegrotingSunburst, THEME_COLORS, type SunburstNode } from "@/components/begroting-pie";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { TransportCalculator } from "@/components/transport-calculator";
import type {
  BuildingCalcResult, GroupTotals, MaterialCalcRow, CostGroup,
  MarkupRow, MarkupCalcRow, CategoryLabourEntry,
} from "@/types";

type Scope = { mode: "all" } | { mode: "building"; buildingId: string };
type Tab = "begroting" | "transport" | "efficientie" | "engineering" | "kolomcorrectie" | "csv" | "planning";

interface Props { scope: Scope; density?: "normal" | "dense"; }


export function BegrotingView({ scope, density = "normal" }: Props) {
  const { data, calcResult, setScopedTotals, autoAssemblageTransport, setAutoAssemblageTransport } = useProjectContext();
  const [tab, setTab] = useState<Tab>("begroting");
  // BVO per gebouw — bouwsysteem-afhankelijk (.home gebruikt andere factoren dan .optop).
  const kengetalSetNameFor = (br: BuildingCalcResult): string | null => {
    const setId = br.building.kengetalSetId ?? data.project?.defaultKengetalSetId ?? null;
    if (!setId) return null;
    return data.allKengetalSets.find((s) => s.id === setId)?.name ?? null;
  };
  const computeBvoFor = (br: BuildingCalcResult): number =>
    computeBvo(br.effectiveInputs, kengetalSetNameFor(br));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["bouwpakket"]));
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  /** Per groep: klapt de "Arbeid per invoercategorie"-sectie open (default dicht). */
  const [expandedLabour, setExpandedLabour] = useState<Set<string>>(new Set());
  /** Per materiaal-rij: toont de invoercategorie-bijdrage breakdown (1 niveau dieper). */
  const [expandedMats, setExpandedMats] = useState<Set<string>>(new Set());
  const toggleMat = (key: string) => setExpandedMats((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const [effSettingsOpen, setEffSettingsOpen] = useState(false);
  const [effHover, setEffHover] = useState<{ cx: number; cy: number; label: string; color: string } | null>(null);
  const [transportTotal, setTransportTotal] = useState<number | null>(null);
  // Uit/aan-zetten van begrotingsposten (per project, in localStorage). Keys:
  //   "grp:{group}"              — hele groep uit
  //   "cat:{group}:{category}"   — materiaal-categorie uit
  //   "mk:{markupId}"            — individuele markup uit
  //
  // Persistentie: we schrijven SYNCHROON naar localStorage vanuit `setKeyDisabled`
  // (de enige plek waar de gebruiker iets aan/uit zet). Géén save-`useEffect` die
  // op elke state-change vuurt — dat veroorzaakte een race waarbij de lege
  // initial-state werd weggeschreven vóórdat het load-effect de waarde kon
  // hydrateren, met als gevolg dat vinkjes "verdwenen" na een reload.
  const [disabledKeys, setDisabledKeys] = useState<Set<string>>(() => new Set());
  const storageKey = data.project ? `begroting-disabled:${data.project.id}` : null;
  const loadedKeyRef = useRef<string | null>(null);
  React.useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
      setDisabledKeys(raw ? new Set(JSON.parse(raw)) : new Set());
    } catch { setDisabledKeys(new Set()); }
    loadedKeyRef.current = storageKey;
  }, [storageKey]);

  const isDisabled = (key: string) => disabledKeys.has(key);
  const setKeyDisabled = (key: string, disabled: boolean) => {
    setDisabledKeys((prev) => {
      const next = new Set(prev);
      if (disabled) next.add(key); else next.delete(key);
      // Synchrone write — alleen als we zijn gehydrateerd vanaf deze key (anders
      // zou een snelle toggle voordat het load-effect is gedraaid alsnog de
      // opgeslagen waarde overschrijven).
      if (typeof window !== "undefined" && storageKey && loadedKeyRef.current === storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(Array.from(next))); } catch { /* negeer */ }
      }
      return next;
    });
  };
  const toggleKey = (key: string) => setKeyDisabled(key, !isDisabled(key));
  // Groep-checkbox: als de groep uit staat, tel dan ook alles in die groep als uit.
  const isRowEnabled = (groupName: string, categoryName: string) =>
    !isDisabled(`grp:${groupName}`) && !isDisabled(`cat:${groupName}:${categoryName}`);
  const isMarkupEnabled = (groupName: string | null, markupId: string) =>
    !isDisabled(`mk:${markupId}`) && (groupName ? !isDisabled(`grp:${groupName}`) : true);

  if (!calcResult) return <div className="text-sm text-muted-foreground">Berekening laden...</div>;

  const isAll = scope.mode === "all";
  const brForScope: BuildingCalcResult | undefined = !isAll
    ? calcResult.buildings.find((b) => b.building.id === scope.buildingId)
    : undefined;

  // Voor de per-gebouw-view rekenen we auto-transport (Polen) en de Marge-bouwpakket
  // percentage WEL mee, zodat de bouwpakket-prijs voor één gebouw een volledige
  // optelling is — geen verborgen regels meer.
  function singleBuildingGroups(br: BuildingCalcResult): GroupTotals[] {
    // "arbeid" is gedissolveerd — assemblage-labour zit nu in assemblagehal.
    const groups: CostGroup[] = ["bouwpakket", "installateur", "assemblagehal", "derden", "hoofdaannemer"];

    // Auto-assemblagehal-transport (3D modulair) is een project-brede waarde. Voor
    // per-gebouw-view verdelen we het proportioneel op basis van modules van dít
    // gebouw t.o.v. totaal-project-modules, en delen door building.count voor 1×.
    const thisModules = br.effectiveInputs["Aantal modules"] ?? 0;
    const totalProjectModules = calcResult!.buildings.reduce(
      (s, bb) => s + (bb.effectiveInputs["Aantal modules"] ?? 0) * bb.building.count, 0,
    );
    const autoAsmPerInstance =
      totalProjectModules > 0 && (autoAssemblageTransport ?? 0) > 0
        ? (autoAssemblageTransport! * thisModules) / totalProjectModules
        : 0;

    // Fase 1 — directe kosten per groep (materiaal + arbeid + transport).
    const raw = groups.map((g) => {
      const rows = br.rows.filter((r) => r.material.costGroup === g);
      const materialCost = rows.reduce((s, r) => s + r.materialCost, 0);
      const labourFromCats = br.labourEntries
        .filter((e) => e.costGroup === g)
        .reduce((s, e) => s + e.cost, 0);
      const laborCost = rows.reduce((s, r) => s + r.laborCost, 0) + labourFromCats;
      let transportCost = 0;
      if (g === "bouwpakket") {
        const auto = computeAutoPolandTransport(rows);
        transportCost = auto.inboundCost + auto.outboundCost;
      } else if (g === "assemblagehal") {
        transportCost = autoAsmPerInstance;
      }
      return { g, rows, materialCost, laborCost, transportCost, directCost: materialCost + laborCost + transportCost };
    });
    const directByGroup = new Map(raw.map((r) => [r.g, r.directCost]));
    const buildingGfa = br.effectiveInputs["Module oppervlak"] ?? 0;

    // Fase 2 — markups toepassen. Drie passes: eerst directe/lopende, dan totaal_ex_derden,
    // dan grand_total (wat pas bekend is ná de vorige twee).
    const sortedMarkups = [...data.markupRows].sort((a, b) => a.sortOrder - b.sortOrder);
    const resultsByGroup = new Map<CostGroup, MarkupCalcRow[]>();
    const deferred: Set<string> = new Set(["totaal_ex_derden", "grand_total", "bouwpakket_plus_assemblage"]);
    for (const g of groups) {
      const rowsForGroup = sortedMarkups.filter((m) => m.costGroup === g);
      const direct = directByGroup.get(g) ?? 0;
      let cumulative = direct;
      const out: MarkupCalcRow[] = [];
      for (const m of rowsForGroup) {
        if (deferred.has(m.basis)) {
          out.push({ id: m.id, name: m.name, type: m.type as any, value: m.value,
            basis: m.basis as any, basisAmount: 0, amount: 0 }); // placeholder
          continue;
        }
        const basisAmount =
          m.basis === "group_direct" ? direct
          : m.basis === "group_cumulative" ? cumulative
          : m.basis === "inkoop_derden" ? (directByGroup.get("derden") ?? 0)
          : 0;
        let amount = 0;
        if (m.type === "percentage") amount = basisAmount * (m.value / 100);
        else if (m.type === "fixed") amount = m.value;
        else if (m.type === "per_m2") amount = m.value * buildingGfa;
        out.push({ id: m.id, name: m.name, type: m.type as any, value: m.value,
          basis: m.basis as any, basisAmount, amount });
        cumulative += amount;
      }
      resultsByGroup.set(g, out);
    }

    // Provisional totaal_ex_derden = bp + inst + asm (direct + niet-deferred markups).
    const totaalExDerden = (["bouwpakket","installateur","assemblagehal"] as CostGroup[])
      .map((g) => (directByGroup.get(g) ?? 0) + (resultsByGroup.get(g) ?? [])
        .reduce((s, m) => s + (deferred.has(m.basis) ? 0 : m.amount), 0))
      .reduce((a, b) => a + b, 0);

    // Fase 3 — totaal_ex_derden invullen.
    const resolve = (basis: string, basisAmount: number) => {
      for (const g of groups) {
        const out = resultsByGroup.get(g)!;
        for (let i = 0; i < out.length; i++) {
          const m = out[i];
          if (m.basis !== basis) continue;
          const src = sortedMarkups.find((s) => s.id === m.id)!;
          let amount = 0;
          if (src.type === "percentage") amount = basisAmount * (src.value / 100);
          else if (src.type === "fixed") amount = src.value;
          else if (src.type === "per_m2") amount = src.value * buildingGfa;
          out[i] = { ...m, basisAmount, amount };
        }
      }
    };
    resolve("totaal_ex_derden", totaalExDerden);

    // Fase 4 — grand_total = totaalExDerden + derden.subtotal (incl. AK+W&R), vóór hoofdaannemer-zelf.
    const derdenSubtotal = (directByGroup.get("derden") ?? 0)
      + (resultsByGroup.get("derden") ?? []).reduce((s, m) => s + m.amount, 0);
    resolve("grand_total", totaalExDerden + derdenSubtotal);

    // Fase 5 — bouwpakket_plus_assemblage (voor "onvoorzien"-opslag).
    const bpSub = (directByGroup.get("bouwpakket") ?? 0)
      + (resultsByGroup.get("bouwpakket") ?? []).reduce((s, m) => s + m.amount, 0);
    const asmSub = (directByGroup.get("assemblagehal") ?? 0)
      + (resultsByGroup.get("assemblagehal") ?? []).reduce((s, m) => s + m.amount, 0);
    resolve("bouwpakket_plus_assemblage", bpSub + asmSub);

    return raw.map((r) => {
      const markups = resultsByGroup.get(r.g) ?? [];
      const totalMarkups = markups.reduce((s, m) => s + m.amount, 0);
      return {
        group: r.g,
        materialCost: r.materialCost, laborCost: r.laborCost, transportCost: r.transportCost,
        directCost: r.directCost,
        markups, totalMarkups,
        subtotal: r.directCost + totalMarkups,
        rows: r.rows,
      };
    });
  }

  /** Aggregate category-labour entries per cost-group across the visible scope.
   * Voor de bouwpakket-groep rollen we de vele "{categorie} — gezaagd/CNC simpel/CNC complex/steenachtig"
   * rijen op tot vier aparte totalen, zodat je per bewerking-type ziet wat het kost.
   * CNC Fermacell en Kramerijen komen als auto-afgeleide materialen in dezelfde sectie terecht. */
  function labourEntriesForGroup(g: CostGroup): CategoryLabourEntry[] {
    const sources = isAll ? calcResult!.buildings : (brForScope ? [brForScope] : []);

    if (g === "bouwpakket") {
      const buckets = {
        "Gezaagd":     { m3: 0, cost: 0, suffix: "— gezaagd" },
        "CNC simpel":  { m3: 0, cost: 0, suffix: "— CNC simpel" },
        "CNC complex": { m3: 0, cost: 0, suffix: "— CNC complex" },
        "Steenachtig": { m3: 0, cost: 0, suffix: "— steenachtig" },
      } as const;
      for (const br of sources) {
        const mult = isAll ? br.building.count : 1;
        for (const e of br.labourEntries) {
          if (e.costGroup !== "bouwpakket") continue;
          for (const [, b] of Object.entries(buckets)) {
            if (e.inputLabel.endsWith(b.suffix)) {
              // as any: suffix is 'as const', so TS allows the mutation with a cast
              (b as { m3: number; cost: number }).m3 += e.totalHours * mult;
              (b as { m3: number; cost: number }).cost += e.cost * mult;
              break;
            }
          }
        }
      }
      const out: CategoryLabourEntry[] = [];
      for (const [label, b] of Object.entries(buckets)) {
        if (b.cost > 0) out.push({ inputLabel: label, costGroup: "bouwpakket", hoursPerInput: 0, inputQty: 0, totalHours: b.m3, cost: b.cost });
      }
      return out;
    }

    /** Vouw "Module Aant BG/Dak/Tussenvd [— suffix]" samen tot "Module Aant [— suffix]". */
    const collapseLabel = (label: string) =>
      label.replace(/^Module Aant (BG|Dak|Tussenvd)(\s—|$)/, "Module Aant$2");

    const merged = new Map<string, CategoryLabourEntry>();
    for (const br of sources) {
      const mult = isAll ? br.building.count : 1;
      for (const e of br.labourEntries) {
        if (e.costGroup !== g) continue;
        const key = collapseLabel(e.inputLabel);
        const existing = merged.get(key);
        if (existing) {
          merged.set(key, {
            ...existing,
            inputQty: existing.inputQty + e.inputQty * mult,
            totalHours: existing.totalHours + e.totalHours * mult,
            cost: existing.cost + e.cost * mult,
          });
        } else {
          merged.set(key, {
            ...e,
            inputLabel: key,
            inputQty: e.inputQty * mult,
            totalHours: e.totalHours * mult,
            cost: e.cost * mult,
          });
        }
      }
    }
    // Project-niveau labour (PM, arbeid-buiten) — staat buiten br.labourEntries omdat
    // het projectbrede overhead is. In scope=all volledig tonen; in scope=building
    // proportioneel verdelen op basis van modules van dit gebouw t.o.v. projecttotaal.
    const plLabour = (calcResult?.projectLevelLabour ?? []).filter((e) => e.costGroup === g);
    if (plLabour.length > 0) {
      const ratio = isAll
        ? 1
        : (() => {
            const total = calcResult?.totalModules ?? 0;
            if (total <= 0 || !brForScope) return 0;
            const here = brForScope.effectiveInputs["Aantal modules"] ?? 0;
            return here / total;
          })();
      for (const e of plLabour) {
        if (ratio <= 0) continue;
        merged.set(e.inputLabel, {
          ...e,
          totalHours: e.totalHours * ratio,
          cost: e.cost * ratio,
        });
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.cost - a.cost);
  }

  const groupsToShow: GroupTotals[] = (() => {
    const all = isAll ? calcResult.groups : (brForScope ? singleBuildingGroups(brForScope) : []);
    return all.filter((g) => {
      // Arbeid + hoofdaannemer alleen tonen als er daadwerkelijk iets in zit.
      if (g.group === "arbeid" || g.group === "hoofdaannemer") {
        return g.materialCost + g.laborCost + g.transportCost + g.totalMarkups > 0;
      }
      return true;
    });
  })();

  // Engineering-fee per gebouw (afgeleid; niet opgenomen in calcResult).
  function engForBuilding(br: BuildingCalcResult) {
    const mods = data.modules.get(br.building.id) ?? [];
    const bvo = computeBvoFor(br);
    const area = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
    const bgg = br.effectiveInputs["_opp_begane_grond"] ?? 0;
    const floorsRaw = area > 0 && bgg > 0 ? area / bgg : 1;
    const floors = Math.abs(floorsRaw - Math.round(floorsRaw)) < 0.1 ? Math.round(floorsRaw) : floorsRaw;
    return computeEngineering(mods, bvo, floors);
  }
  const engineeringScoped = isAll
    ? calcResult.buildings.reduce((s, br) => s + engForBuilding(br).grandTotal * br.building.count, 0)
    : brForScope ? engForBuilding(brForScope).grandTotal : 0;

  // Effectieve directe kosten per groep (materiaal + arbeid + transport) ZONDER
  // markups, met alle disabled-vinkjes toegepast. Vormt de basis voor de
  // herberekening van cross-group markup-percentages (totaal_ex_derden, etc.) —
  // anders blijft b.v. AK Assemblagehal 12,5% rekenen over installateur ook als
  // de gebruiker installateur uitvinkt.
  function effectiveGroupDirect(g: GroupTotals): number {
    if (isDisabled(`grp:${g.group}`)) return 0;
    const byCat = new Map<string, MaterialCalcRow[]>();
    for (const r of g.rows) {
      const list = byCat.get(r.material.category) ?? [];
      list.push(r); byCat.set(r.material.category, list);
    }
    let total = 0;
    for (const [cat, rows] of byCat) {
      if (!isRowEnabled(g.group, cat)) continue;
      for (const r of rows) {
        if (isDisabled(`mat:${r.material.id}`)) continue;
        total += r.materialCost + r.laborCost;
      }
    }
    if (!isDisabled(`labgroup:${g.group}`)) {
      const labEntries = labourEntriesForGroup(g.group);
      for (const e of labEntries) if (!isDisabled(`lab:${g.group}:${e.inputLabel}`)) total += e.cost;
    }
    if (!isDisabled(`tr:${g.group}`)) total += g.transportCost;
    // Handmatige posten (per-project) — tellen op bij de directe kosten van deze
    // groep, behalve wanneer individueel uitgevinkt via xl:{id}.
    for (const x of (data.extraLines ?? [])) {
      if (x.costGroup !== g.group) continue;
      if (isDisabled(`xl:${x.id}`)) continue;
      total += (x.quantity ?? 0) * (x.pricePerUnit ?? 0);
    }
    return total;
  }

  // Berekenen op groepen die de huidige scope bevat. Wordt door de cross-group
  // markup-bases (totaal_ex_derden / inkoop_derden / grand_total / bp+asm)
  // gebruikt om hun bedragen te herberekenen na het uit/aan-zetten van groepen.
  const groupsForBases: GroupTotals[] = isAll
    ? calcResult.groups
    : brForScope ? singleBuildingGroups(brForScope) : [];
  const effectiveDirects: Record<CostGroup, number> = {
    bouwpakket: 0, installateur: 0, assemblagehal: 0, derden: 0, hoofdaannemer: 0, arbeid: 0,
  };
  for (const g of groupsForBases) effectiveDirects[g.group] = effectiveGroupDirect(g);
  const effTotaalExDerden = effectiveDirects.bouwpakket + effectiveDirects.installateur + effectiveDirects.assemblagehal;
  const effInkoopDerden   = effectiveDirects.derden;
  const effGrandTotal     = effTotaalExDerden + effInkoopDerden;
  const effBpPlusAsm      = effectiveDirects.bouwpakket + effectiveDirects.assemblagehal;

  // Multi-pass markup-amount precompute — spiegel van calculation.ts pass 1+2 en
  // van de Excel-formules. Cruciaal: TED/bp+asm/grand_total bases tellen óók
  // markups in bp/inst/asm/der op (niet alleen directe kosten). Vorige versie
  // miste die optelling waardoor app-totaal afweek van calc/Excel.
  const effMkAmt = new Map<string, number>();
  type MkEntry = { gKey: CostGroup; m: MarkupCalcRow };
  const allMarkupsForBasis: MkEntry[] = [];
  for (const g of groupsForBases) {
    for (const m of g.markups) {
      if (!isMarkupEnabled(g.group, m.id)) continue;
      allMarkupsForBasis.push({ gKey: g.group, m });
    }
  }
  // Pass 1: simpele bases (group_direct / group_cumulative / inkoop_derden / fixed / per_m2).
  for (const { gKey, m } of allMarkupsForBasis) {
    const pct = m.value / 100;
    if (m.type !== "percentage") {
      effMkAmt.set(m.id, m.amount); // fixed/per_m2 — gebruik calc waarde
      continue;
    }
    if (m.basis === "group_direct") {
      effMkAmt.set(m.id, (effectiveDirects[gKey] ?? 0) * pct);
    } else if (m.basis === "group_cumulative") {
      const prev = allMarkupsForBasis
        .filter((x) => x.gKey === gKey && x.m.id !== m.id
          && !["totaal_ex_derden", "grand_total", "bouwpakket_plus_assemblage"].includes(x.m.basis))
        .reduce((s, x) => s + (effMkAmt.get(x.m.id) ?? 0), 0);
      effMkAmt.set(m.id, ((effectiveDirects[gKey] ?? 0) + prev) * pct);
    } else if (m.basis === "inkoop_derden") {
      effMkAmt.set(m.id, (effectiveDirects.derden ?? 0) * pct);
    } else {
      effMkAmt.set(m.id, 0); // deferred
    }
  }
  // Pass 2A: TED-markups IN bp/inst/asm (basis = directs + non-TED markups in die 3).
  for (const { gKey, m } of allMarkupsForBasis) {
    if (m.basis !== "totaal_ex_derden") continue;
    if (gKey === "hoofdaannemer") continue;
    const nonTedSum = allMarkupsForBasis
      .filter((x) => ["bouwpakket","installateur","assemblagehal"].includes(x.gKey) && x.m.basis !== "totaal_ex_derden")
      .reduce((s, x) => s + (effMkAmt.get(x.m.id) ?? 0), 0);
    effMkAmt.set(m.id, (effectiveDirects.bouwpakket + effectiveDirects.installateur + effectiveDirects.assemblagehal + nonTedSum) * (m.value / 100));
  }
  // Pass 2B: TED in hoofdaannemer (basis = directs + ALLE bp/inst/asm markups, incl TED).
  for (const { gKey, m } of allMarkupsForBasis) {
    if (m.basis !== "totaal_ex_derden") continue;
    if (gKey !== "hoofdaannemer") continue;
    const allSum = allMarkupsForBasis
      .filter((x) => ["bouwpakket","installateur","assemblagehal"].includes(x.gKey))
      .reduce((s, x) => s + (effMkAmt.get(x.m.id) ?? 0), 0);
    effMkAmt.set(m.id, (effectiveDirects.bouwpakket + effectiveDirects.installateur + effectiveDirects.assemblagehal + allSum) * (m.value / 100));
  }
  // Pass 3: bp+asm en grand_total.
  for (const { gKey, m } of allMarkupsForBasis) {
    const pct = m.value / 100;
    if (m.basis === "bouwpakket_plus_assemblage") {
      const sum = allMarkupsForBasis
        .filter((x) => x.gKey === "bouwpakket" || x.gKey === "assemblagehal")
        .reduce((s, x) => s + (effMkAmt.get(x.m.id) ?? 0), 0);
      effMkAmt.set(m.id, (effectiveDirects.bouwpakket + effectiveDirects.assemblagehal + sum) * pct);
    } else if (m.basis === "grand_total") {
      const sum = allMarkupsForBasis
        .filter((x) => ["bouwpakket","installateur","assemblagehal","derden"].includes(x.gKey))
        .reduce((s, x) => s + (effMkAmt.get(x.m.id) ?? 0), 0);
      effMkAmt.set(m.id, (effectiveDirects.bouwpakket + effectiveDirects.installateur + effectiveDirects.assemblagehal + effectiveDirects.derden + sum) * pct);
    }
  }

  /** Effectieve basis-bedrag voor een markup; gebruikt door tooltips/cellen. */
  function effectiveBasisAmount(m: MarkupCalcRow): number {
    if (m.type !== "percentage") return m.basisAmount;
    const amt = effMkAmt.get(m.id);
    if (amt == null || m.value === 0) return m.basisAmount;
    return amt / (m.value / 100);
  }

  /** Markup-bedrag herberekend met dezelfde 2-pass logica als calc.ts. */
  function effectiveMarkupAmount(m: MarkupCalcRow): number {
    return effMkAmt.get(m.id) ?? m.amount;
  }

  // Effectief subtotaal per groep op basis van disabled-set (zelfde logica als renderGroup).
  function effectiveGroupSubtotal(g: GroupTotals): number {
    if (isDisabled(`grp:${g.group}`)) return 0;
    let total = effectiveGroupDirect(g);
    for (const m of g.markups) if (isMarkupEnabled(g.group, m.id)) total += effectiveMarkupAmount(m);
    return total;
  }

  const scopedTotalExVat = (isAll
    ? groupsToShow.reduce((s, g) => s + effectiveGroupSubtotal(g), 0) + (calcResult.projectMarkups.filter((m) => !isDisabled(`mk:${m.id}`)).reduce((s, m) => s + effectiveMarkupAmount(m), 0))
    : brForScope ? groupsToShow.reduce((s, g) => s + effectiveGroupSubtotal(g), 0) : 0)
    + engineeringScoped;

  // Boom voor de sunburst. Hoofdcategorieën: Bouwpakket / Assemblagehal / Installateur /
  // Inkoop derden / Engineering. De hoofdaannemer-opslagen (Coörd/ABK/CAR/Onvoorzien)
  // worden proportioneel verdeeld over de groepen in hun basis (zodat die niet als
  // losse slice verschijnt). Respecteert disabled-keys.
  function buildSunburstData(): SunburstNode {
    const groupsForPie = isAll ? calcResult!.groups : (brForScope ? singleBuildingGroups(brForScope) : []);
    // Subtotaal per groep (excl. hoofdaannemer-markups).
    const bySub = new Map<string, number>();
    for (const g of groupsForPie) {
      if (isDisabled(`grp:${g.group}`)) { bySub.set(g.group, 0); continue; }
      bySub.set(g.group, effectiveGroupSubtotal(g));
    }
    const bp = bySub.get("bouwpakket") ?? 0;
    const inst = bySub.get("installateur") ?? 0;
    const asm = bySub.get("assemblagehal") ?? 0;
    const der = bySub.get("derden") ?? 0;
    const totExDer = bp + inst + asm;
    const totInclDer = totExDer + der;
    const bpPlusAsm = bp + asm;

    // Hoofdaannemer-markups verdelen over groepen proportioneel. De m.amount
    // wordt herberekend via effectiveMarkupAmount(m) zodat het sunburst-totaal
    // gelijk loopt met scopedTotalExVat als groepen zijn uitgevinkt.
    const hoofdGroup = groupsForPie.find((g) => g.group === "hoofdaannemer");
    const shares: Record<string, number> = { bouwpakket: 0, installateur: 0, assemblagehal: 0, derden: 0 };
    if (hoofdGroup && !isDisabled(`grp:hoofdaannemer`)) {
      for (const m of hoofdGroup.markups) {
        if (!isMarkupEnabled("hoofdaannemer", m.id)) continue;
        const amt = effectiveMarkupAmount(m);
        if (m.basis === "totaal_ex_derden" && totExDer > 0) {
          shares.bouwpakket   += amt * (bp / totExDer);
          shares.installateur += amt * (inst / totExDer);
          shares.assemblagehal+= amt * (asm / totExDer);
        } else if (m.basis === "grand_total" && totInclDer > 0) {
          shares.bouwpakket   += amt * (bp / totInclDer);
          shares.installateur += amt * (inst / totInclDer);
          shares.assemblagehal+= amt * (asm / totInclDer);
          shares.derden       += amt * (der / totInclDer);
        } else if (m.basis === "bouwpakket_plus_assemblage" && bpPlusAsm > 0) {
          shares.bouwpakket    += amt * (bp / bpPlusAsm);
          shares.assemblagehal += amt * (asm / bpPlusAsm);
        } else if (m.basis === "inkoop_derden") {
          shares.derden += amt;
        }
      }
    }

    // Kleine helper voor een sub-tree per groep.
    // Ring-opbouw: groep → categorie (afgifte/electra/…) → individuele materialen.
    // Arbeid/transport/markups/hoofd-share hangen als *siblings* van de categorieën
    // op ring 1, zodat ze direct zichtbaar zijn en geen extra wrapper-laag krijgen.
    function groupTree(id: "bouwpakket"|"installateur"|"assemblagehal"|"derden"): SunburstNode | null {
      const g = groupsForPie.find((x) => x.group === id);
      if (!g || isDisabled(`grp:${id}`)) return null;
      const label = COST_GROUP_LABELS[id];
      const byCat = new Map<string, MaterialCalcRow[]>();
      for (const r of g.rows) {
        if (isDisabled(`mat:${r.material.id}`)) continue;
        if (!isRowEnabled(id, r.material.category)) continue;
        const list = byCat.get(r.material.category) ?? [];
        list.push(r); byCat.set(r.material.category, list);
      }
      // Materiaal-categorieën als directe children (afgifte, electra, LVL, I-Joist, …).
      const children: SunburstNode[] = Array.from(byCat.entries()).map(([cat, rows]) => ({
        id: `${id}:cat:${cat}`,
        label: cat,
        value: rows.reduce((s, r) => s + r.materialCost, 0),
        children: rows.map((r) => ({
          id: `${id}:mat:${r.material.id}`,
          label: r.material.name,
          value: r.materialCost,
        })),
      })).filter((n) => n.value > 0);
      // Arbeid / bewerking — als categorie-sibling, input-labels als blad.
      if (!isDisabled(`labgroup:${id}`)) {
        const lab = labourEntriesForGroup(id).filter((e) => !isDisabled(`lab:${id}:${e.inputLabel}`));
        const labTotal = lab.reduce((s, e) => s + e.cost, 0);
        if (labTotal > 0) {
          children.push({
            id: `${id}:labour`,
            label: id === "bouwpakket" ? "Bouwpakket-bewerking" : "Arbeid",
            value: labTotal,
            children: lab.map((e) => ({ id: `${id}:lab:${e.inputLabel}`, label: e.inputLabel, value: e.cost })),
          });
        }
      }
      if (g.transportCost > 0 && !isDisabled(`tr:${id}`)) {
        children.push({ id: `${id}:transport`, label: "Transport", value: g.transportCost });
      }
      // Directe group-markups (AK+W&R voor derden, Marge bp/inst, etc.) — gebruikt
      // effectiveMarkupAmount zodat ook hier disabled-state wordt gerespecteerd.
      const enabledMarkups = g.markups.filter((m) => isMarkupEnabled(id, m.id) && effectiveMarkupAmount(m) > 0);
      if (enabledMarkups.length > 0) {
        children.push({
          id: `${id}:mk`,
          label: "Opslagen",
          value: enabledMarkups.reduce((s, m) => s + effectiveMarkupAmount(m), 0),
          children: enabledMarkups.map((m) => ({ id: `mk:${m.id}`, label: m.name, value: effectiveMarkupAmount(m) })),
        });
      }
      // Verdeelde hoofdaannemer-share
      const share = shares[id] ?? 0;
      if (share > 0) {
        children.push({ id: `${id}:hoofdshare`, label: "Opslag hoofdaannemer", value: share });
      }
      const totalValue = children.reduce((s, c) => s + c.value, 0);
      if (totalValue <= 0) return null;
      return { id, label, value: totalValue, children };
    }

    const roots: SunburstNode[] = [];
    for (const id of ["bouwpakket", "installateur", "assemblagehal", "derden"] as const) {
      const t = groupTree(id); if (t) roots.push(t);
    }
    if (engineeringScoped > 0) {
      // Eng-sub: fee + constructie
      const engRows: SunburstNode[] = [];
      for (const br of (isAll ? calcResult!.buildings : brForScope ? [brForScope] : [])) {
        const mult = isAll ? br.building.count : 1;
        const e = engForBuilding(br);
        if (e.engineeringTotal > 0) engRows.push({ id: `eng:fee:${br.building.id}`, label: `Sustainer fee (${br.building.name})`, value: e.engineeringTotal * mult });
        if (e.constructieTotal > 0) engRows.push({ id: `eng:con:${br.building.id}`, label: `Constructie (${br.building.name})`, value: e.constructieTotal * mult });
      }
      roots.push({
        id: "engineering",
        label: "Engineering",
        value: engineeringScoped,
        children: engRows.length > 0 ? engRows : undefined,
      });
    }
    return {
      id: "root",
      label: "Totaal",
      value: roots.reduce((s, r) => s + r.value, 0),
      children: roots,
    };
  }

  // Scoped gfa (m² BVO) voor prijs-per-m² weergave in de floating-totals.
  // Altijd BVO — niet de module-oppervlak — zodat de /m²-prijs consistent is met
  // de rest van de calculatie (engineering fee, per_m² markups, enz.).
  const scopedGfa = isAll
    ? calcResult.buildings.reduce((s, br) => s + computeBvoFor(br) * br.building.count, 0)
    : (brForScope ? computeBvoFor(brForScope) : 0);
  // Publiceer naar de layout-context zodat FloatingTotals het overneemt.
  React.useEffect(() => {
    setScopedTotals({ total: scopedTotalExVat, gfa: scopedGfa });
    return () => setScopedTotals(null);
  }, [scopedTotalExVat, scopedGfa, setScopedTotals]);

  function toggleGroup(k: string) {
    setExpandedGroups((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  function toggleCat(k: string) {
    setExpandedCats((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  function toggleLabour(k: string) {
    setExpandedLabour((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  const rowPadY = density === "dense" ? "py-1" : "py-1.5";

  // Markup CRUD
  async function addMarkup(costGroup: CostGroup | null) {
    if (!data.project) return;
    await fetch(`/api/projects/${data.project.id}/markups`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        costGroup, name: "Nieuwe opslag", type: "percentage", value: 0,
        basis: costGroup ? "group_direct" : "grand_total",
      }),
    });
    data.refetch();
  }
  async function patchMarkup(id: string, updates: Partial<MarkupRow>) {
    await fetch(`/api/projects/${data.project!.id}/markups`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    data.refetch();
  }
  async function deleteMarkup(id: string) {
    await fetch(`/api/projects/${data.project!.id}/markups?id=${id}`, { method: "DELETE" });
    data.refetch();
  }

  // Find the underlying MarkupRow by id so we can render editable controls.
  const markupById = new Map<string, MarkupRow>(data.markupRows.map((m) => [m.id, m]));

  function renderMarkupsEditor(groupKey: CostGroup | null, markups: MarkupCalcRow[], allowedBases: string[]) {
    return (
      <div className="border-t bg-gray-50/60">
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col />                         {/* Naam */}
            <col className="w-[5.5rem]" />  {/* Type */}
            <col className="w-[5rem]" />    {/* Waarde */}
            <col className="w-[13rem]" />   {/* Basis */}
            <col className="w-[7rem]" />    {/* Basisbedrag */}
            <col className="w-[7rem]" />    {/* Bedrag */}
            <col className="w-[2rem]" />    {/* Delete */}
          </colgroup>
          <tbody>
            {markups.map((m) => {
              const src = markupById.get(m.id);
              if (!src) return null;
              const typeLabel = src.type === "percentage" ? "%" : src.type === "per_m2" ? "€/m²" : "vast";
              return (
                <tr key={m.id} className="border-t first:border-0 align-middle">
                  <td className="px-3 py-1">
                    {isAll ? (
                      <Input className="h-7 text-xs" defaultValue={src.name}
                        onBlur={(e) => patchMarkup(src.id, { name: e.target.value })} />
                    ) : <span>{src.name}</span>}
                  </td>
                  <td className="px-1 py-1">
                    {isAll ? (
                      <Select value={src.type} onValueChange={(v) => patchMarkup(src.id, { type: v as any })}>
                        <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="percentage">%</SelectItem>
                          <SelectItem value="per_m2">€/m²</SelectItem>
                          <SelectItem value="fixed">vast</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : <span className="text-muted-foreground">{typeLabel}</span>}
                  </td>
                  <td className="px-1 py-1">
                    {isAll ? (
                      <Input className="h-7 w-full text-right text-xs tabular-nums" inputMode="decimal"
                        defaultValue={src.value}
                        onBlur={(e) => {
                          const raw = e.target.value.replace(",", ".").trim();
                          if (raw === "") return;
                          const v = parseFloat(raw);
                          if (!isNaN(v) && v !== src.value) patchMarkup(src.id, { value: v });
                        }} />
                    ) : <span className="tabular-nums">{src.value}</span>}
                  </td>
                  <td className="px-1 py-1">
                    {src.type === "percentage" ? (
                      isAll ? (
                        <Select value={src.basis} onValueChange={(v) => patchMarkup(src.id, { basis: v as any })}>
                          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {allowedBases.map((b) => (
                              <SelectItem key={b} value={b}><span className="text-xs">{BASIS_LABELS[b]}</span></SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : <span className="truncate text-[10px] text-muted-foreground">{BASIS_LABELS[src.basis]}</span>
                    ) : <span />}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-muted-foreground">
                    {src.type === "percentage" ? formatEUR(effectiveBasisAmount(m)) : ""}
                  </td>
                  <td className="px-1 py-1 text-right font-medium tabular-nums">{formatEUR(effectiveMarkupAmount(m))}</td>
                  <td className="px-1 py-1">
                    {isAll && (
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive"
                        onClick={() => deleteMarkup(src.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {isAll && (
          <div className="border-t px-3 py-1.5">
            <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground"
              onClick={() => addMarkup(groupKey)}>
              <Plus className="mr-1 h-3 w-3" /> Regel toevoegen
            </Button>
          </div>
        )}
      </div>
    );
  }

  function renderGroup(g: GroupTotals) {
    const key = `${scope.mode}-${g.group}`;
    const isExpanded = expandedGroups.has(g.group);
    const label = COST_GROUP_LABELS[g.group];
    // Groep-kleur = sunburst-slicekleur. Wordt gecascadeerd naar ALLE nested
    // checkboxes in deze groep (categorieën, materialen, arbeid, transport,
    // markups), zodat één visuele identiteit per groep ontstaat.
    // Fallback naar een neutrale grijstint zodat ook groepen zonder expliciete
    // sunburst-kleur (arbeid, hoofdaannemer) een gedefinieerde accent krijgen,
    // ipv terugvallen op de browser-default (blauw). React 18 verwerkt een
    // inline-style-object prima, maar omdat Sol rapporteerde dat sommige
    // kinderen default-blauw waren, zetten we de kleur expliciet bij élke
    // checkbox-render — desnoods als string — zodat er geen twijfel is.
    const accent = THEME_COLORS[g.group] ?? "#6b7280";
    const accentStyle: React.CSSProperties = { accentColor: accent };
    const byCat = new Map<string, MaterialCalcRow[]>();
    for (const r of g.rows) {
      const list = byCat.get(r.material.category) ?? [];
      list.push(r); byCat.set(r.material.category, list);
    }

    // Vier kolommen, consistent tussen materiaal- en arbeid-tabellen.
    const colGroup = (
      <colgroup>
        <col />                        {/* Omschrijving */}
        <col className="w-[7rem]" />   {/* Hoeveelheid */}
        <col className="w-[5rem]" />   {/* Prijs/eh */}
        <col className="w-[7rem]" />   {/* € */}
      </colgroup>
    );

    // Labour entries voor deze groep + efficiëntie-chip voor per-gebouw-view.
    const labEntries = labourEntriesForGroup(g.group);
    const labTotal = labEntries.reduce((s, e) => s + e.cost, 0);
    const isLabourGroup = g.group === "installateur" || g.group === "assemblagehal";
    const learningFactor = !isAll && brForScope ? brForScope.learningFactor : 1;
    const showEffChip = isLabourGroup && !isAll && learningFactor < 0.999;
    const groupKey = `grp:${g.group}`;
    const groupOff = isDisabled(groupKey);
    // Effectief subtotaal na toepassing van uit/aan-vinkjes.
    const effSubtotal = groupOff ? 0 : (() => {
      let total = 0;
      for (const [cat, rows] of byCat) {
        if (!isRowEnabled(g.group, cat)) continue;
        for (const r of rows) {
          if (isDisabled(`mat:${r.material.id}`)) continue;
          total += r.materialCost + r.laborCost;
        }
      }
      if (!isDisabled(`labgroup:${g.group}`)) {
        for (const e of labEntries) if (!isDisabled(`lab:${g.group}:${e.inputLabel}`)) total += e.cost;
      }
      total += g.transportCost;
      for (const x of (data.extraLines ?? [])) {
        if (x.costGroup !== g.group) continue;
        if (isDisabled(`xl:${x.id}`)) continue;
        total += (x.quantity ?? 0) * (x.pricePerUnit ?? 0);
      }
      for (const m of g.markups) if (isMarkupEnabled(g.group, m.id)) total += effectiveMarkupAmount(m);
      return total;
    })();

    return (
      // Flat section binnen de content-container — geen eigen outer border. De
      // divide-y op de wrapper voegt exact één lijn tussen elke section toe;
      // nooit dubbele borders of inconsistente gaps.
      <div key={key} className={`bg-white ${groupOff ? "opacity-50" : ""}`}>
        {/* Groep-header: vinkje + chevron + label + totaal. De accent-color van
             de checkbox matcht de sunburst-slicekleur → data-mapping zit in de
             checkbox zelf, geen losse kleuren-dot meer naast de tekst. */}
        <div className="flex w-full items-center gap-2 px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={!groupOff}
            onChange={(e) => setKeyDisabled(groupKey, !e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            className="cursor-pointer"
            style={accentStyle}
            title={groupOff ? "Groep weer meerekenen" : "Hele groep uitschakelen"}
          />
          <button onClick={() => toggleGroup(g.group)} className="flex flex-1 items-center gap-2 text-left hover:opacity-80">
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="font-semibold">{label}</span>
            <span className="ml-auto font-semibold tabular-nums">{formatEUR(effSubtotal)}</span>
          </button>
        </div>

        {isExpanded && (
          <div className="border-t">
            {/* Materiaal-categorieën — zebra-striping ipv horizontale borders. */}
            {Array.from(byCat.entries()).map(([cat, rows], catIdx) => {
              const catKey = `${key}-${cat}`;
              const expanded = expandedCats.has(catKey);
              const catDisableKey = `cat:${g.group}:${cat}`;
              const catOff = isDisabled(catDisableKey);
              const catTotal = rows.reduce((s, r) => s + (isDisabled(`mat:${r.material.id}`) ? 0 : r.materialCost + r.laborCost), 0);
              return (
                <div key={catKey} className={`${catIdx % 2 === 1 ? "bg-gray-50/40" : ""} ${catOff ? "opacity-50" : ""}`}>
                  <div className={`flex w-full items-center gap-2 px-3 ${rowPadY} text-xs`}>
                    <input
                      type="checkbox"
                      checked={!catOff}
                      onChange={(e) => setKeyDisabled(catDisableKey, !e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                      className="cursor-pointer"
                      style={accentStyle}
                      title={catOff ? "Categorie weer meerekenen" : "Categorie uitschakelen"}
                    />
                    <button onClick={() => toggleCat(catKey)} className="flex flex-1 items-center gap-2 text-left hover:opacity-80">
                      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <span className="text-muted-foreground">{formatCategory(cat)}</span>
                      <span className="ml-auto tabular-nums">{catOff ? <s>{formatEUR(catTotal)}</s> : formatEUR(catTotal)}</span>
                    </button>
                  </div>
                  {expanded && (
                    <table className="w-full table-fixed text-xs">
                      {colGroup}
                      <tbody>
                        {rows.map((r) => {
                          const matKey = `mat:${r.material.id}`;
                          const catOrGroupOff = catOff || groupOff;
                          const matOff = catOrGroupOff || isDisabled(matKey);
                          // Aggregeer contributies per inputLabel (project-brede view kan
                          // dezelfde label uit meerdere gebouwen hebben).
                          const contribs = r.contributions ?? [];
                          const aggMap = new Map<string, { inputQty: number; netto: number; ratios: Set<number> }>();
                          for (const c of contribs) {
                            const ex = aggMap.get(c.inputLabel);
                            if (ex) {
                              ex.inputQty += c.inputQty;
                              ex.netto += c.netto;
                              ex.ratios.add(c.ratio);
                            } else {
                              aggMap.set(c.inputLabel, { inputQty: c.inputQty, netto: c.netto, ratios: new Set([c.ratio]) });
                            }
                          }
                          const matExpanded = expandedMats.has(matKey);
                          const hasContribs = aggMap.size > 0;
                          return (
                            <React.Fragment key={r.material.id}>
                              <tr className={`border-t ${matOff ? "opacity-50" : ""}`}>
                                <td className={`px-3 ${rowPadY}`}>
                                  <div className="flex items-center gap-1.5 truncate">
                                    <input
                                      type="checkbox"
                                      checked={!isDisabled(matKey) && !catOrGroupOff}
                                      disabled={catOrGroupOff}
                                      onChange={(e) => setKeyDisabled(matKey, !e.target.checked)}
                                      className="cursor-pointer"
                                      style={accentStyle}
                                      title={matOff ? "Weer meerekenen" : "Uitschakelen"}
                                    />
                                    {hasContribs ? (
                                      <button
                                        onClick={() => toggleMat(matKey)}
                                        className="flex flex-1 items-center gap-1.5 truncate text-left hover:opacity-80"
                                        title={matExpanded ? "Inklappen" : "Toon herkomst (per invoercategorie)"}
                                      >
                                        {matExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                        <span className="truncate">{r.material.name}</span>
                                        {r.material.description && (
                                          <span className="truncate text-muted-foreground">— {r.material.description}</span>
                                        )}
                                      </button>
                                    ) : (
                                      <>
                                        <span className="w-3 shrink-0" />
                                        <span className="truncate">{r.material.name}</span>
                                        {r.material.description && (
                                          <span className="truncate text-muted-foreground">— {r.material.description}</span>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </td>
                                <td className={`px-3 ${rowPadY} text-right tabular-nums`}>{formatQty(r.bruto)} {r.material.unit}</td>
                                <td className={`px-3 ${rowPadY} text-right tabular-nums text-muted-foreground`}>{formatEURsmart(r.price)}</td>
                                <td className={`px-3 ${rowPadY} text-right tabular-nums ${matOff ? "line-through opacity-60" : ""}`}>{formatEUR(r.materialCost)}</td>
                              </tr>
                              {matExpanded && hasContribs && (
                                <tr className="bg-gray-50/60">
                                  <td colSpan={4} className="px-3 py-1.5">
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                      Herkomst per invoercategorie
                                    </div>
                                    <div className="mt-1 grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-0.5 text-[11px]">
                                      {Array.from(aggMap.entries()).sort((a, b) => b[1].netto - a[1].netto).map(([label, c]) => {
                                        const ratioStr = c.ratios.size === 1
                                          ? `× ${formatNumber(Array.from(c.ratios)[0], 4)}`
                                          : `× ${Array.from(c.ratios).map((x) => formatNumber(x, 4)).join("/")}`;
                                        const lossPart = r.loss > 0 ? ` × ${formatNumber(1 + r.loss, 2)} verlies` : "";
                                        const cost = c.netto * (1 + r.loss) * r.price;
                                        return (
                                          <React.Fragment key={label}>
                                            <span className="truncate text-muted-foreground">↳ {label}</span>
                                            <span className="text-right tabular-nums text-muted-foreground">
                                              {formatQty(c.inputQty)}{lossPart ? "" : ""} {ratioStr}
                                            </span>
                                            <span className="text-right tabular-nums">{formatQty(c.netto * (1 + r.loss))} {r.material.unit}</span>
                                            <span className="text-right tabular-nums">{formatEUR(cost)}</span>
                                          </React.Fragment>
                                        );
                                      })}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}

            {/* Arbeid / bewerking — inklapbaar + vinkje op header en per regel. */}
            {labEntries.length > 0 && (() => {
              const isBouwpakket = g.group === "bouwpakket";
              const title = isBouwpakket ? "Bouwpakket-bewerking" : "Arbeid";
              const unit = isBouwpakket ? "m³" : "u";
              const labKey = `${key}-__arbeid__`;
              const labExpanded = expandedLabour.has(labKey);
              const labDisableKey = `labgroup:${g.group}`;
              const labOff = isDisabled(labDisableKey);
              const enabledLabCost = labEntries.reduce((s, e) => {
                if (labOff) return s;
                if (isDisabled(`lab:${g.group}:${e.inputLabel}`)) return s;
                return s + e.cost;
              }, 0);
              return (
                <div className={labOff ? "opacity-50" : ""}>
                  <div className={`flex w-full items-center gap-2 px-3 ${rowPadY} text-xs`}>
                    <input
                      type="checkbox"
                      checked={!labOff}
                      onChange={(e) => setKeyDisabled(labDisableKey, !e.target.checked)}
                      className="cursor-pointer"
                      style={accentStyle}
                      title={labOff ? "Weer meerekenen" : `${title} uitschakelen`}
                    />
                    <button onClick={() => toggleLabour(labKey)} className="flex flex-1 items-center gap-2 text-left hover:opacity-80">
                      {labExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <span className="text-muted-foreground">{title}</span>
                      {showEffChip && (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                          title={`Leercurve toegepast op arbeidsuren: × ${formatNumber(learningFactor, 3)}`}>
                          × {formatNumber(learningFactor, 2)} leercurve
                        </span>
                      )}
                      <span className="ml-auto tabular-nums">{labOff ? <s>{formatEUR(labTotal)}</s> : formatEUR(enabledLabCost)}</span>
                    </button>
                  </div>
                  {labExpanded && (
                    <table className="w-full table-fixed text-xs">
                      {colGroup}
                      <tbody>
                        {labEntries.map((e) => {
                          const effRate = e.totalHours > 0 ? e.cost / e.totalHours : 0;
                          const rowHasLearning = showEffChip && (e.costGroup === "assemblagehal" || e.costGroup === "installateur");
                          const hint = rowHasLearning ? `Leercurve toegepast: ${formatQty(e.totalHours / learningFactor)} u × ${formatNumber(learningFactor, 3)} = ${formatQty(e.totalHours)} u` : undefined;
                          const entryKey = `lab:${g.group}:${e.inputLabel}`;
                          const entryOff = labOff || isDisabled(entryKey);
                          return (
                            <tr key={e.inputLabel} className={`border-t ${entryOff ? "opacity-50" : ""}`}>
                              <td className={`px-3 ${rowPadY}`}>
                                <div className="flex items-center gap-1.5 truncate">
                                  <input
                                    type="checkbox"
                                    checked={!isDisabled(entryKey) && !labOff}
                                    disabled={labOff}
                                    onChange={(ev) => setKeyDisabled(entryKey, !ev.target.checked)}
                                    className="cursor-pointer"
                                    style={accentStyle}
                                    title={entryOff ? "Weer meerekenen" : "Uitschakelen"}
                                  />
                                  <span className="truncate">{e.inputLabel}</span>
                                  {rowHasLearning && (
                                    <span className="rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-medium text-emerald-700" title={hint}>
                                      × {formatNumber(learningFactor, 2)}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className={`px-3 ${rowPadY} text-right tabular-nums`} title={hint}>{formatQty(e.totalHours)} {unit}</td>
                              <td className={`px-3 ${rowPadY} text-right tabular-nums text-muted-foreground`}>{formatEURsmart(effRate)}</td>
                              <td className={`px-3 ${rowPadY} text-right tabular-nums ${entryOff ? "line-through opacity-60" : ""}`}>{formatEUR(e.cost)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })()}

            {/* Materiaaltransport NL ⇄ Polen — bouwpakket-groep, enkel project-view. */}
            {isAll && g.group === "bouwpakket" && calcResult!.autoTransport && (calcResult!.autoTransport.inboundCost + calcResult!.autoTransport.outboundCost) > 0 && (
              <div className="border-b bg-gray-50/30 px-3 py-2 text-xs">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Materiaaltransport</div>
                <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-0.5">
                  <span className="text-muted-foreground">Naar VMG Polen</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {formatQty(calcResult!.autoTransport.inboundM3)} m³ · {calcResult!.autoTransport.inboundTrucks} trucks
                  </span>
                  <span className="w-24 text-right tabular-nums">{formatEUR(calcResult!.autoTransport.inboundCost)}</span>
                  <span className="text-muted-foreground">Van VMG Polen → Raamsdonksveer</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {formatQty(calcResult!.autoTransport.outboundM3)} m³ · {calcResult!.autoTransport.outboundTrucks} trucks
                  </span>
                  <span className="w-24 text-right tabular-nums">{formatEUR(calcResult!.autoTransport.outboundCost)}</span>
                </div>
              </div>
            )}

            {/* Arbeid buiten + projectmanagement (alleen project-view, assemblagehal).
                Toont basis-uren + uren-per-module transparant. */}
            {isAll && g.group === "assemblagehal" && (calcResult!.arbeidBuitenCost + calcResult!.projectmgmtCost) > 0 && (() => {
              const rates = data.labourRates ?? null;
              const totalMods = calcResult!.totalModules;
              const ab = rates ? {
                base: rates.arbeidBuitenHoursBase, perMod: rates.arbeidBuitenHoursPerModule, rate: rates.arbeidBuitenHourlyRate,
              } : null;
              const pm = rates ? {
                base: rates.projectmgmtHoursBase, perMod: rates.projectmgmtHoursPerModule, rate: rates.projectmgmtHourlyRate,
              } : null;
              return (
                <div className="border-b bg-gray-50/30 px-3 py-2 text-xs">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Arbeid buiten + projectmanagement</div>
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-0.5">
                    {calcResult!.arbeidBuitenCost > 0 && (<>
                      <span className="text-muted-foreground">Arbeid buiten</span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {ab ? `${formatQty(ab.base)} + ${formatQty(ab.perMod)}×${totalMods} u` : ""}
                      </span>
                      <span className="w-24 text-right tabular-nums">{formatEUR(calcResult!.arbeidBuitenCost)}</span>
                    </>)}
                    {calcResult!.projectmgmtCost > 0 && (<>
                      <span className="text-muted-foreground">Projectmanagement</span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {pm ? `${formatQty(pm.base)} + ${formatQty(pm.perMod)}×${totalMods} u` : ""}
                      </span>
                      <span className="w-24 text-right tabular-nums">{formatEUR(calcResult!.projectmgmtCost)}</span>
                    </>)}
                  </div>
                </div>
              );
            })()}

            {/* Handmatige posten — per-project, optellen bij groep.materialCost.
                 Bewerkbaar (description / qty / unit / price) + add/delete. */}
            {isAll && renderExtraLinesForGroup(g.group)}

            {/* Footer: gecombineerd breakdown + inline-bewerkbare markups + subtotaal. */}
            {renderGroupFooter(g, label)}
          </div>
        )}
      </div>
    );
  }

  /**
   * Inline-bewerkbare markup-rij binnen de group-footer. Zelfde grid als de rest van
   * het breakdown — zo is alles binnen één groep netjes uitgelijnd.
   */
  function inlineMarkupRow(m: MarkupCalcRow, accentStyle?: React.CSSProperties): React.ReactNode {
    const src = markupById.get(m.id);
    if (!src) return null;
    const suffix = src.type === "percentage" ? "%" : src.type === "per_m2" ? "€/m²" : "€";
    // Tooltip: leg uit waarover het percentage berekend is. Bedragen volgen de
    // effective basis (na uit/aan-vinkjes), niet de oorspronkelijke calc-waarde.
    const basisLabel = BASIS_LABELS[m.basis] ?? m.basis;
    const effAmount = effectiveMarkupAmount(m);
    const effBasis = effectiveBasisAmount(m);
    const basisHint =
      src.type === "percentage"
        ? `${src.value}% × ${formatEUR(effBasis)} (${basisLabel}) = ${formatEUR(effAmount)}`
        : src.type === "per_m2"
          ? `€${src.value}/m² × ${formatQty(effBasis)} m² = ${formatEUR(effAmount)}`
          : `vast bedrag: ${formatEUR(effAmount)}`;
    const mkKey = `mk:${m.id}`;
    const mkOff = isDisabled(mkKey);
    return (
      <React.Fragment key={m.id}>
        <input
          type="checkbox"
          checked={!mkOff}
          onChange={(e) => setKeyDisabled(mkKey, !e.target.checked)}
          className="cursor-pointer"
          style={accentStyle}
          title={mkOff ? "Weer meerekenen" : "Uitschakelen"}
        />
        <span className={`flex items-center gap-1.5 text-muted-foreground ${mkOff ? "opacity-50" : ""}`} title={basisHint}>
          <span className="cursor-help underline decoration-dotted underline-offset-2">{src.name}</span>
          {isAll && (
            <button
              type="button"
              className="text-destructive/60 hover:text-destructive"
              title="Verwijder"
              onClick={() => deleteMarkup(src.id)}>
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
        <span className="inline-flex items-center gap-1 justify-self-end">
          <Input
            key={`mk-${src.id}-${src.value}`}
            className="h-6 w-14 text-right text-[11px] tabular-nums"
            inputMode="decimal"
            defaultValue={src.value}
            onBlur={(e) => {
              const raw = e.target.value.replace(",", ".").trim();
              if (raw === "") return;
              const v = parseFloat(raw);
              if (!isNaN(v) && v !== src.value) patchMarkup(src.id, { value: v });
            }}
          />
          <span className="w-8 text-[10px] text-muted-foreground">{suffix}</span>
        </span>
        <span className={`w-24 text-right tabular-nums ${mkOff ? "line-through opacity-60" : ""}`}>{formatEUR(effAmount)}</span>
      </React.Fragment>
    );
  }

  // ── Handmatige posten (per-project) ─────────────────────────────
  async function addExtraLine(group: CostGroup) {
    if (!data.project) return;
    await fetch(`/api/projects/${data.project.id}/extra-lines`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ costGroup: group, description: "Nieuwe post", quantity: 1, unit: "stuks", pricePerUnit: 0 }),
    });
    data.refetch();
  }
  async function patchExtraLine(id: string, updates: Record<string, any>) {
    if (!data.project) return;
    await fetch(`/api/projects/${data.project.id}/extra-lines`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    data.refetch();
  }
  async function deleteExtraLine(id: string) {
    if (!data.project) return;
    await fetch(`/api/projects/${data.project.id}/extra-lines?id=${id}`, { method: "DELETE" });
    data.refetch();
  }

  function renderExtraLinesForGroup(group: CostGroup) {
    const lines = (data.extraLines ?? []).filter((x) => x.costGroup === group);
    if (lines.length === 0 && group !== "assemblagehal") {
      // Toon de "+ Handmatige post"-knop alleen voor de groepen waarvoor het zin
      // heeft (assemblagehal is de hoofd-use-case van Sol).
      return null;
    }
    const accent = THEME_COLORS[group];
    const accentStyle: React.CSSProperties | undefined = accent ? { accentColor: accent } : undefined;
    return (
      <div className="border-t bg-amber-50/30 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Handmatige posten</span>
          <Button variant="ghost" size="sm" className="h-6 text-[11px] text-muted-foreground"
            onClick={() => addExtraLine(group)}>
            <Plus className="mr-1 h-3 w-3" /> Nieuwe post
          </Button>
        </div>
        {lines.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-1 py-1 text-left font-medium">Omschrijving</th>
                <th className="px-1 py-1 text-right font-medium">Aantal</th>
                <th className="px-1 py-1 text-left font-medium">Eh.</th>
                <th className="px-1 py-1 text-right font-medium">Prijs</th>
                <th className="px-1 py-1 text-right font-medium">Bedrag</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((x) => {
                const xKey = `xl:${x.id}`;
                const off = isDisabled(xKey);
                const bedrag = (x.quantity ?? 0) * (x.pricePerUnit ?? 0);
                return (
                  <tr key={x.id} className={off ? "opacity-50" : ""}>
                    <td className="px-1 py-0.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={!off}
                          onChange={(e) => setKeyDisabled(xKey, !e.target.checked)}
                          className="cursor-pointer"
                          style={accentStyle}
                          title={off ? "Weer meerekenen" : "Uitschakelen"}
                        />
                        <Input
                          key={`xl-d-${x.id}-${x.description}`}
                          className="h-7 w-full text-xs"
                          defaultValue={x.description}
                          onBlur={(e) => { if (e.target.value !== x.description) patchExtraLine(x.id, { description: e.target.value }); }}
                        />
                      </div>
                    </td>
                    <td className="px-1 py-0.5">
                      <Input
                        key={`xl-q-${x.id}-${x.quantity}`}
                        className="h-7 w-20 text-right text-xs tabular-nums"
                        inputMode="decimal"
                        defaultValue={x.quantity}
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value.replace(",", ".").trim());
                          if (Number.isFinite(v) && v !== x.quantity) patchExtraLine(x.id, { quantity: v });
                        }}
                      />
                    </td>
                    <td className="px-1 py-0.5">
                      <Input
                        key={`xl-u-${x.id}-${x.unit}`}
                        className="h-7 w-16 text-xs"
                        defaultValue={x.unit}
                        onBlur={(e) => { if (e.target.value !== x.unit) patchExtraLine(x.id, { unit: e.target.value }); }}
                      />
                    </td>
                    <td className="px-1 py-0.5">
                      <Input
                        key={`xl-p-${x.id}-${x.pricePerUnit}`}
                        className="h-7 w-24 text-right text-xs tabular-nums"
                        inputMode="decimal"
                        defaultValue={x.pricePerUnit}
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value.replace(",", ".").trim());
                          if (Number.isFinite(v) && v !== x.pricePerUnit) patchExtraLine(x.id, { pricePerUnit: v });
                        }}
                      />
                    </td>
                    <td className={`px-1 py-0.5 text-right tabular-nums font-medium ${off ? "line-through opacity-60" : ""}`}>
                      {formatEUR(bedrag)}
                    </td>
                    <td className="px-1 py-0.5">
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive"
                        onClick={() => deleteExtraLine(x.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  function renderGroupFooter(g: GroupTotals, label: string) {
    // De Materiaal-/Arbeid-breakdown is weggehaald: die totalen staan al in de
    // categorie-rijen boven. Alleen transport + markups tonen we hier als
    // aparte regels, elk met eigen on/off-vakje. Accent-kleur = sunburst-slice.
    const hasTransport = g.transportCost > 0;
    const transportKey = `tr:${g.group}`;
    const transportEnabled = !isDisabled(transportKey) && !isDisabled(`grp:${g.group}`);
    const accent = THEME_COLORS[g.group];
    const accentStyle: React.CSSProperties | undefined = accent ? { accentColor: accent } : undefined;
    return (
      <div className="border-t bg-gray-50/40 px-3 py-2 text-xs">
        <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1">
          {hasTransport && (<>
            <input
              type="checkbox"
              checked={transportEnabled}
              disabled={isDisabled(`grp:${g.group}`)}
              onChange={(e) => setKeyDisabled(transportKey, !e.target.checked)}
              style={accentStyle}
            />
            <span className={transportEnabled ? "text-muted-foreground" : "text-muted-foreground opacity-50 line-through"}>
              {g.group === "bouwpakket" ? "Materiaaltransport" : "Transport"}
            </span>
            <span />
            <span className={`w-24 text-right tabular-nums ${transportEnabled ? "" : "opacity-50 line-through"}`}>
              {formatEUR(g.transportCost)}
            </span>
          </>)}

          {g.markups.map((m) => inlineMarkupRow(m, accentStyle))}

          {isAll && g.group !== "derden" && (
            <span className="col-span-4">
              <Button variant="ghost" size="sm" className="h-6 text-[11px] text-muted-foreground"
                onClick={() => addMarkup(g.group)}>
                <Plus className="mr-1 h-3 w-3" /> Opslag toevoegen
              </Button>
            </span>
          )}
        </div>
      </div>
    );
  }

  async function patchKengetalSet(id: string, updates: Record<string, number>) {
    await fetch(`/api/kengetal-sets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    data.refetch();
  }

  function renderEfficiencyTab() {
    if (!brForScope) return <div className="text-sm text-muted-foreground">Kies een gebouw om de leercurve te bekijken.</div>;
    const setId = brForScope.building.kengetalSetId ?? data.project?.defaultKengetalSetId ?? "";
    const set = data.allKengetalSets.find((s) => s.id === setId);
    const effParams = {
      vatHuidig: set?.effVatHuidig ?? DEFAULT_EFFICIENCY.vatHuidig,
      vatMax:    set?.effVatMax    ?? DEFAULT_EFFICIENCY.vatMax,
      lr:        set?.effLr        ?? DEFAULT_EFFICIENCY.lr,
      nRef:      set?.effNRef      ?? DEFAULT_EFFICIENCY.nRef,
    };
    const mods = data.modules.get(brForScope.building.id) ?? [];
    const learning = computeLearningFactor(mods, effParams);

    // Arbeidsuren en -kosten van dit gebouw, voor de "t.o.v. basis"-context.
    // Leerfactor is al toegepast op assemblage + installatie labourEntries;
    // bouwpakket-bewerking niet (die is materiaal-gedreven).
    const scopedLabour = brForScope.labourEntries.filter(
      (e) => e.costGroup === "assemblagehal" || e.costGroup === "installateur",
    );
    const actualLabourHours = scopedLabour.reduce((s, e) => s + e.totalHours, 0);
    const actualLabourCost  = scopedLabour.reduce((s, e) => s + e.cost, 0);
    const totalModsInBuilding = mods.reduce((s, m) => s + m.count, 0);
    const avgHoursPerModule = totalModsInBuilding > 0 ? actualLabourHours / totalModsInBuilding : 0;
    const deltaPct = (learning.factor - 1) * 100;  // negatief = besparing, positief = duurder

    // Curve-data.
    const b = Math.log(effParams.lr) / Math.log(2);
    const tInfRatio = effParams.vatHuidig / effParams.vatMax;
    const t1Ratio = (1 - tInfRatio) / Math.pow(effParams.nRef, b) + tInfRatio;
    const maxN = Math.max(1, ...learning.perSize.map((p) => p.count));
    // X-as: laat de project-maxN op ~90 % van de x-as liggen zodat de curve herkenbaar
    // blijft. Minimum bereik: 20 modules.
    const chartN = Math.max(20, Math.ceil(maxN / 0.9));
    const tRatio = (n: number) => tInfRatio + (t1Ratio - tInfRatio) * Math.pow(n, b);
    const warnIgnored = effParams.lr >= 1 || effParams.vatHuidig >= effParams.vatMax;

    // SVG dimensies — padR iets ruimer zodat "Basis · 10 modules"-label past.
    const W = 640, H = 260, padL = 44, padR = 110, padT = 16, padB = 28;
    const xForN = (n: number) => padL + ((n - 1) / Math.max(1, chartN - 1)) * (W - padL - padR);
    // Y-as loopt altijd van 0 tot net boven T₁ — nulpunt zichtbaar voor schaalgevoel.
    const yMax = Math.max(1.05, t1Ratio * 1.05);
    const yMin = 0;
    const yForR = (r: number) => padT + (1 - (r - yMin) / (yMax - yMin)) * (H - padT - padB);
    const palette = ["#493ee5", "#0ea5e9", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];

    // Solid segment 1..maxN (dit project) en dashed segment maxN..chartN (hypothetische voortzetting).
    const solidPoints = Array.from({ length: maxN }, (_, i) => i + 1)
      .map((n) => `${xForN(n)},${yForR(tRatio(n))}`).join(" ");
    const dashPoints = Array.from({ length: Math.max(0, chartN - maxN + 1) }, (_, i) => maxN + i)
      .map((n) => `${xForN(n)},${yForR(tRatio(n))}`).join(" ");

    // Kleur voor de delta (rood bij duurder, groen bij goedkoper dan basis).
    const deltaColor = deltaPct < -0.5 ? "text-emerald-700" : deltaPct > 0.5 ? "text-rose-700" : "text-muted-foreground";
    const deltaSign = deltaPct >= 0 ? "+" : "−";
    const deltaLabel = `${deltaSign}${formatNumber(Math.abs(deltaPct), 1)}%`;

    // Per-instance dots: elke module krijgt eigen dot op de curve, gekleurd per modulemaat.
    type Dot = { n: number; r: number; color: string; label: string };
    const dots: Dot[] = [];
    learning.perSize.forEach((p, sizeIdx) => {
      const color = palette[sizeIdx % palette.length];
      for (let i = 1; i <= p.count; i++) {
        dots.push({ n: i, r: tRatio(i), color, label: `${p.key} — module ${i}` });
      }
    });

    const onSvgMove = (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return setEffHover(null);
      const loc = pt.matrixTransform(ctm.inverse());
      const R = 12;
      let best: { d: Dot; dist: number } | null = null;
      for (const d of dots) {
        const dx = xForN(d.n) - loc.x;
        const dy = yForR(d.r) - loc.y;
        const dist = dx * dx + dy * dy;
        if (dist > R * R) continue;
        if (!best || dist < best.dist) best = { d, dist };
      }
      if (best) setEffHover({ cx: xForN(best.d.n), cy: yForR(best.d.r), label: best.d.label, color: best.d.color });
      else setEffHover(null);
    };

    return (
      <div className="space-y-3">
        {/* Chart */}
        <div className="rounded-md border bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold">Leercurve — uren-verhouding T(n) / basis</div>
            <button
              onClick={() => setEffSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-transparent px-2 py-1 text-[11px] text-muted-foreground hover:border-gray-200 hover:text-foreground"
              title="Leercurve-parameters bewerken"
            >
              <Settings className="h-3.5 w-3.5" />
              Instellingen
            </button>
          </div>
          {warnIgnored && (
            <div className="mb-2 rounded bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
              ⚠ Huidige parameters geven geen leercurve-effect (LR ≥ 1 of VAT_huidig ≥ VAT_max). Correctiefactor = 1,00.
            </div>
          )}
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full"
               onMouseMove={onSvgMove} onMouseLeave={() => setEffHover(null)}>
            {/* Axes */}
            <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#d1d5db" />
            <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#d1d5db" />

            {/* Basis-lijn op y = 1 (= T_ref, uren bij n_ref modules) — prominent getoond. */}
            <line x1={padL} y1={yForR(1)} x2={W - padR} y2={yForR(1)} stroke="#9ca3af" strokeDasharray="4 3" strokeWidth="1.25" />
            <text x={W - padR + 4} y={yForR(1) + 3} fontSize="10" fill="#374151">
              Basis · {formatNumber(effParams.nRef, 0)} modules
            </text>
            <text x={padL - 4} y={yForR(1) + 3} textAnchor="end" fontSize="9" fill="#6b7280">1,00</text>

            {/* Project-gemiddelde lijn (gewogen leerfactor) — laat zien hoe het project zich
                verhoudt tot de basis. Rood als duurder dan basis, groen als goedkoper. */}
            {learning.factor > 0 && (() => {
              const stroke = deltaPct < -0.5 ? "#047857" : deltaPct > 0.5 ? "#be123c" : "#6b7280";
              const totMods = mods.reduce((s, m) => s + m.count, 0);
              return (
                <g>
                  <line x1={padL} y1={yForR(learning.factor)} x2={W - padR} y2={yForR(learning.factor)}
                        stroke={stroke} strokeDasharray="4 3" strokeWidth="1.25" opacity="0.85" />
                  <text x={W - padR + 4} y={yForR(learning.factor) + 3} fontSize="10" fill={stroke}>
                    Project · {totMods} modules
                  </text>
                  <text x={padL - 4} y={yForR(learning.factor) + 3} textAnchor="end" fontSize="9" fill={stroke}>
                    {formatNumber(learning.factor, 2)}
                  </text>
                </g>
              );
            })()}

            {/* Y-as nul-label */}
            <text x={padL - 4} y={yForR(0) + 3} textAnchor="end" fontSize="9" fill="#6b7280">0</text>

            {/* Referentielijn bij n = 1000 (verzadigingspunt van leercurve). Alleen zichtbaar
                als het bereik tot n=1000 reikt. */}
            {chartN >= 1000 && (
              <g>
                <line x1={xForN(1000)} y1={padT} x2={xForN(1000)} y2={H - padB}
                      stroke="#d1d5db" strokeDasharray="2 3" />
                <text x={xForN(1000)} y={padT + 9} textAnchor="middle" fontSize="9" fill="#9ca3af">
                  n = 1000
                </text>
              </g>
            )}

            {/* X-ticks + n_ref-markering */}
            {(() => {
              const ticks = Array.from(new Set([1, Math.round(effParams.nRef), maxN, chartN].filter((n) => n >= 1 && n <= chartN)));
              ticks.sort((a, b) => a - b);
              return ticks.map((n, i) => (
                <g key={i}>
                  <line x1={xForN(n)} y1={H - padB} x2={xForN(n)} y2={H - padB + 3} stroke="#9ca3af" />
                  <text x={xForN(n)} y={H - padB + 14} textAnchor="middle" fontSize="9" fill="#6b7280">{n}</text>
                </g>
              ));
            })()}
            <text x={(W + padL - padR) / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#6b7280">Modulenummer n</text>

            {/* Solid segment 1..maxN (dit project). */}
            <polyline fill="none" stroke="#493ee5" strokeWidth="2" points={solidPoints} />
            {/* Dashed voortzetting maxN..chartN (hypothetisch). */}
            <polyline fill="none" stroke="#493ee5" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.55" points={dashPoints} />

            {/* Per-module dots, gekleurd per modulemaat. */}
            {dots.map((d, i) => (
              <circle key={i} cx={xForN(d.n)} cy={yForR(d.r)} r="2.25" fill={d.color} opacity="0.85" />
            ))}

            {/* Hover-highlight + label (verschijnt alleen in de buurt van een dot). */}
            {effHover && (
              <g>
                <circle cx={effHover.cx} cy={effHover.cy} r="5" fill="none" stroke={effHover.color} strokeWidth="1.5" />
                {(() => {
                  const labelX = effHover.cx + 8;
                  const labelY = effHover.cy - 8;
                  const anchor = labelX > W - padR - 40 ? "end" : "start";
                  const tx = anchor === "end" ? effHover.cx - 8 : labelX;
                  return (
                    <>
                      <rect x={(anchor === "end" ? tx - 4 - 7 * effHover.label.length : tx - 4)} y={labelY - 10}
                            width={7 * effHover.label.length + 8} height={14} rx={3} fill="#111827" opacity="0.9" />
                      <text x={tx} y={labelY} textAnchor={anchor} fontSize="10" fill="#fff">{effHover.label}</text>
                    </>
                  );
                })()}
              </g>
            )}
          </svg>
        </div>

        {/* Totale delta — horizontale lijn, prominent */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border bg-white px-4 py-2.5 text-xs">
          <span className="text-muted-foreground">Totaal</span>
          <span className={`text-sm font-semibold tabular-nums ${deltaColor}`}>{deltaLabel}</span>
          <span className="text-muted-foreground">t.o.v. basis van {formatNumber(effParams.nRef, 0)} modules</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-semibold tabular-nums">{formatQty(avgHoursPerModule)} uur/module</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-semibold tabular-nums">{formatEUR(actualLabourCost)}</span>
          <span className="text-muted-foreground">arbeidskosten in begroting</span>
        </div>

        {/* Parameters-dialog */}
        <Dialog open={effSettingsOpen} onOpenChange={setEffSettingsOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Leercurve-parameters</DialogTitle>
              <DialogDescription>Bouwsysteem: {set?.name ?? "—"}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 text-xs">
              {[
                { key: "effVatHuidig", label: "VAT huidig",    value: effParams.vatHuidig, hint: "Huidige waarde-toegevoegde factor (0–1)" },
                { key: "effVatMax",    label: "VAT max",       value: effParams.vatMax,    hint: "Maximum-bereikbare VAT — asymptoot" },
                { key: "effLr",        label: "Learning rate", value: effParams.lr,        hint: "LR (0,88 = 12 % minder per verdubbeling)" },
                { key: "effNRef",      label: "n_ref",         value: effParams.nRef,      hint: "Modulenummer waarop basis-uren T_ref zijn gemeten" },
              ].map((f) => (
                <div key={f.key} className="grid grid-cols-[1fr_auto] items-center gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{f.label}</div>
                    <div className="text-muted-foreground">{f.hint}</div>
                  </div>
                  <Input
                    key={`${f.key}-${f.value}`}
                    className="h-8 w-24 text-right text-xs tabular-nums"
                    inputMode="decimal"
                    defaultValue={f.value}
                    disabled={!set}
                    onBlur={(e) => {
                      if (!set) return;
                      const raw = e.target.value.replace(",", ".").trim();
                      if (raw === "") return;
                      const v = parseFloat(raw);
                      if (!isNaN(v) && v !== f.value) patchKengetalSet(set.id, { [f.key]: v });
                    }}
                  />
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* Metrics per modulemaat */}
        <div className="rounded-md border bg-white">
          <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
            <span className="font-semibold">Per modulemaat</span>
            <span className="text-muted-foreground">{learning.perSize.length} unieke maten · {mods.reduce((s, m) => s + m.count, 0)} modules</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Maat (L×B×H m)</th>
                <th className="px-3 py-1.5 text-right font-medium">Aantal</th>
                <th className="px-3 py-1.5 text-right font-medium">T₁/basis</th>
                <th className="px-3 py-1.5 text-right font-medium">T(N)/basis</th>
                <th className="px-3 py-1.5 text-right font-medium">Gemiddeld C</th>
                <th className="px-3 py-1.5 text-right font-medium">t.o.v. basis</th>
              </tr>
            </thead>
            <tbody>
              {learning.perSize.map((p, i) => {
                const deltaPct = (p.c - 1) * 100;
                const color = deltaPct < -0.5 ? "text-emerald-700" : deltaPct > 0.5 ? "text-rose-700" : "text-muted-foreground";
                return (
                <tr key={p.key} className="odd:bg-white even:bg-gray-50/40">
                  <td className="px-3 py-1.5">
                    <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: palette[i % palette.length] }} />
                    <span className="ml-2 tabular-nums">{p.key}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{p.count}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(p.t1Ratio, 3)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(p.tNRatio, 3)}</td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatNumber(p.c, 3)}</td>
                  <td className={`px-3 py-1.5 text-right font-medium tabular-nums ${color}`}>
                    {deltaPct >= 0 ? "+" : "−"}{formatNumber(Math.abs(deltaPct), 1)}%
                  </td>
                </tr>
                );
              })}
              {learning.perSize.length === 0 && (
                <tr><td className="px-3 py-4 text-center text-muted-foreground" colSpan={6}>Geen modules in dit gebouw.</td></tr>
              )}
              <tr className="bg-gray-50 text-xs">
                <td className="px-3 py-1.5 font-semibold" colSpan={4}>Gewogen over alle modules</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatNumber(learning.factor, 3)}</td>
                <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${deltaColor}`}>
                  {deltaLabel}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          De correctiefactor wordt toegepast op arbeidsuren in Assemblagehal en Installateur (incl. module-gedreven arbeid buiten en projectmanagement). Materiaalkosten en bouwpakket-bewerking (gezaagd/CNC) blijven ongewijzigd.
        </p>
      </div>
    );
  }

  function renderEngineeringSection() {
    // Per-scope samenvatting van engineering-fee (zonder volledige tab-detail).
    const rows: { eng: ReturnType<typeof computeEngineering>; mult: number }[] = [];
    if (isAll) {
      for (const br of calcResult!.buildings) rows.push({ eng: engForBuilding(br), mult: br.building.count });
    } else if (brForScope) {
      rows.push({ eng: engForBuilding(brForScope), mult: 1 });
    }
    const engSum = rows.reduce((s, r) => s + r.eng.engineeringTotal * r.mult, 0);
    const conSum = rows.reduce((s, r) => s + r.eng.constructieTotal * r.mult, 0);
    if (engSum + conSum <= 0) return null;
    return (
      <div className="bg-white">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-semibold">Engineering</span>
          <span className="text-sm font-semibold tabular-nums">{formatEUR(engSum + conSum)}</span>
        </div>
        <div className="border-t border-gray-100">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
            <span className="text-muted-foreground" title="Complexiteit-afhankelijke Sustainer engineering fee per m² BVO (€50 – €100).">
              <span className="cursor-help underline decoration-dotted underline-offset-2">Sustainer engineering fee</span>
            </span>
            <span />
            <span className="w-24 text-right tabular-nums">{formatEUR(engSum)}</span>
            <span className="text-muted-foreground" title="Complexiteit-afhankelijke constructieberekening per m² BVO (€12,50 – €25) + €2/m² per extra verdieping.">
              <span className="cursor-help underline decoration-dotted underline-offset-2">Constructieberekening</span>
            </span>
            <span />
            <span className="w-24 text-right tabular-nums">{formatEUR(conSum)}</span>
          </div>
        </div>
      </div>
    );
  }

  function renderEngineeringTab() {
    if (!brForScope) return <div className="text-sm text-muted-foreground">Kies een gebouw om de engineering-fee te bekijken.</div>;
    const mods = data.modules.get(brForScope.building.id) ?? [];
    const bvo = computeBvoFor(brForScope);
    const area = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
    const bgg = brForScope.effectiveInputs["_opp_begane_grond"] ?? 0;
    const floorsRaw = area > 0 && bgg > 0 ? area / bgg : 1;
    const floors = Math.abs(floorsRaw - Math.round(floorsRaw)) < 0.1 ? Math.round(floorsRaw) : floorsRaw;
    const eng = computeEngineering(mods, bvo, floors);

    const noModules = eng.totalModules === 0;
    const noBvo = bvo <= 0;

    // Horizontale schaal voor engineering fee (50 → 100). Positie volgt complexiteit.
    const scaleMin = 50, scaleMax = 100;
    const markerPct = Math.max(0, Math.min(1, eng.complexity)) * 100;

    return (
      <div className="space-y-3">
        {(noModules || noBvo) && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {noModules ? "⚠ Geen modules in dit gebouw — engineering-fee is 0." : "⚠ BVO is 0 — vul gevel/WSW-inputs in om de fee te kunnen berekenen."}
          </div>
        )}

        {/* Sectie 1: Projectkenmerken */}
        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Projectkenmerken</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-3 py-2 text-xs md:grid-cols-3">
            <Stat label="Totaal modules"          value={eng.totalModules}      unit="stuks" />
            <Stat label="Unieke modulematen"      value={eng.uniqueSizes}       unit="" />
            <Stat label="Herhalingsfactor"        value={formatNumber(eng.repetition, 1)} unit="per maat" />
            <Stat label="Verdiepingen"            value={formatNumber(floors, 1)} unit="" />
            <Stat label="BVO"                     value={formatNumber(bvo, 1)}  unit="m²" />
            <Stat label="Complexiteit"            value={`${Math.round(eng.complexity * 100)}%`} unit="" />
          </div>
        </div>

        {/* Sectie 2: Engineering fee */}
        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Engineering fee</div>
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
            <span>Fee per m² BVO</span>
            <span className="text-right tabular-nums">{formatEURsmart(eng.engineeringPerM2)}/m²</span>
            <span />
            <span className="text-muted-foreground">Totaal engineering</span>
            <span />
            <span className="w-24 text-right font-semibold tabular-nums">{formatEUR(eng.engineeringTotal)}</span>
          </div>
          {/* Visualisatie: horizontale schaal €50 → €100 */}
          <div className="border-t px-3 py-2.5 text-[11px]">
            <div className="relative h-2 rounded-full bg-gradient-to-r from-emerald-200 via-amber-200 to-rose-300">
              <div
                className="absolute top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-foreground shadow-sm"
                style={{ left: `${markerPct}%` }}
                title={`Complexiteit: ${Math.round(eng.complexity * 100)}%`}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
              <span>€50 · 100 modules, 1 maat</span>
              <span>€75 · 50 modules, 10 maten</span>
              <span>€100 · 1 module</span>
            </div>
          </div>
        </div>

        {/* Sectie 3: Constructieberekening */}
        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Constructieberekening fee</div>
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
            <span>Basisfee per m² BVO</span>
            <span className="text-right tabular-nums">{formatEURsmart(eng.constructieBasePerM2)}/m²</span>
            <span />
            <span>Opslag verdiepingen</span>
            <span className="text-right tabular-nums">{formatEURsmart(eng.constructieFloorsPerM2)}/m²</span>
            <span className="text-[10px] text-muted-foreground">{floors > 1 ? `(${formatNumber(floors, 0)}−1) × €2` : "—"}</span>
            <span className="font-medium">Totaal per m²</span>
            <span className="text-right font-medium tabular-nums">{formatEURsmart(eng.constructiePerM2)}/m²</span>
            <span />
            <span className="text-muted-foreground">Totaal constructiefee</span>
            <span />
            <span className="w-24 text-right font-semibold tabular-nums">{formatEUR(eng.constructieTotal)}</span>
          </div>
          <div className="border-t bg-gray-50/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            {floors > 1
              ? `Verdiepingen: ${formatNumber(floors, 1)} × +€2/m² boven de eerste`
              : "Eén verdieping — geen verdieping-opslag."}
          </div>
        </div>

        {/* Sectie 4: Totaal */}
        <div className="rounded-md border bg-white">
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Engineering fee</span>
            <span className="w-24 text-right tabular-nums">{formatEUR(eng.engineeringTotal)}</span>
            <span className="text-muted-foreground">Constructiefee</span>
            <span className="w-24 text-right tabular-nums">{formatEUR(eng.constructieTotal)}</span>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2 text-sm font-semibold">
            <span>Totaal Engineering</span>
            <span className="tabular-nums">{formatEUR(eng.grandTotal)}</span>
          </div>
        </div>
      </div>
    );
  }

  function renderPlanningTab() {
    const totalModules = calcResult!.totalModules;
    const distinctTypes = calcResult!.distinctModuleTypes;
    const baseHours = calcResult!.projectmgmtBaseHours;
    const penaltyHours = calcResult!.projectmgmtTypePenaltyHours;
    const totalHours = calcResult!.projectmgmtHours;
    const exponent = calcResult!.projectmgmtExponent;
    const hourlyRate = data.labourRates?.projectmgmtHourlyRate ?? 85;
    const totalCost = calcResult!.projectmgmtCost;

    // Chart-dimensies — zelfde stijl als Efficiëntie-tab.
    const W = 640, H = 240, padL = 50, padR = 80, padT = 16, padB = 28;
    const xMin = 1, xMax = Math.max(1000, totalModules * 1.2);
    const yMax = 200 * Math.pow(xMax, exponent) * 1.1;
    // Log-x mapping
    const logX = (n: number) => Math.log10(Math.max(1, n));
    const xForN = (n: number) => padL + (logX(n) - logX(xMin)) / (logX(xMax) - logX(xMin)) * (W - padL - padR);
    const yForH = (h: number) => padT + (1 - h / yMax) * (H - padT - padB);
    // Curve: 200 punten log-spaced
    const curvePts = Array.from({ length: 200 }, (_, i) => {
      const t = i / 199;
      const n = Math.pow(10, logX(xMin) + t * (logX(xMax) - logX(xMin)));
      return `${xForN(n).toFixed(2)},${yForH(200 * Math.pow(n, exponent)).toFixed(2)}`;
    }).join(" ");

    const xTicks = [1, 10, 100, 1000].filter((n) => n <= xMax);
    const yTicks = [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), Math.round(yMax)];

    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Projectmanagement</div>
          <div className="space-y-1.5 px-3 py-2.5 text-xs">
            <p className="text-muted-foreground">
              Eén vaste formule, gebaseerd op aantal modules en aantal unieke moduletypes:
            </p>
            <div className="rounded bg-gray-50 px-2 py-1.5 font-mono text-[11px] text-gray-800">
              uren = 200 × n<sup>0,434</sup> + 50 × max(0, types − 1)
            </div>
            <p className="text-[11px] text-muted-foreground">
              Anchor-punten basis-deel: 1 → 200u · 10 → ~543u · 100 → ~1.480u · 1000 → 4.000u.
              Elke extra moduletype na de eerste voegt 50u toe voor herhaal-engineering en setup.
            </p>
          </div>
        </div>

        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Invoer</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-3 py-2 text-xs md:grid-cols-3">
            <Stat label="Totaal modules"      value={formatNumber(totalModules, 0)} unit="stuks" />
            <Stat label="Unieke moduletypes"  value={distinctTypes}                  unit="types" />
            <Stat label="Uurtarief"           value={formatEUR(hourlyRate)}          unit="/uur" />
          </div>
        </div>

        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Berekening</div>
          <table className="w-full text-xs">
            <tbody className="[&>tr>td]:px-3 [&>tr>td]:py-1.5 [&>tr]:border-b last:[&>tr]:border-0">
              <tr>
                <td className="text-muted-foreground">Basis (200 × n<sup>0,434</sup>)</td>
                <td className="text-right tabular-nums">{formatNumber(baseHours, 0)}</td>
                <td className="w-12 text-muted-foreground">u</td>
              </tr>
              <tr>
                <td className="text-muted-foreground">Penalty moduletypes (50u × {Math.max(0, distinctTypes - 1)})</td>
                <td className="text-right tabular-nums">{formatNumber(penaltyHours, 0)}</td>
                <td className="text-muted-foreground">u</td>
              </tr>
              <tr className="bg-gray-50/70 font-medium">
                <td>Totaal uren</td>
                <td className="text-right tabular-nums">{formatNumber(totalHours, 0)}</td>
                <td className="text-muted-foreground">u</td>
              </tr>
              <tr>
                <td className="text-muted-foreground">× uurtarief</td>
                <td className="text-right tabular-nums">{formatEUR(hourlyRate)}</td>
                <td className="text-muted-foreground">/uur</td>
              </tr>
              <tr className="font-semibold">
                <td>Kosten projectmanagement</td>
                <td className="text-right text-base tabular-nums">{formatEUR(totalCost)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <div className="rounded-md border bg-white p-3">
          <div className="mb-2 text-xs font-semibold">PM-curve · uren vs. aantal modules (log-schaal)</div>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
            {/* Axes */}
            <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#d1d5db" />
            <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#d1d5db" />

            {/* Y-grid + labels */}
            {yTicks.map((h) => (
              <g key={`y-${h}`}>
                <line x1={padL} y1={yForH(h)} x2={W - padR} y2={yForH(h)} stroke="#f3f4f6" />
                <text x={padL - 4} y={yForH(h) + 3} textAnchor="end" fontSize="9" fill="#6b7280">
                  {formatNumber(h, 0)}
                </text>
              </g>
            ))}

            {/* X-ticks (log) */}
            {xTicks.map((n) => (
              <g key={`x-${n}`}>
                <line x1={xForN(n)} y1={H - padB} x2={xForN(n)} y2={H - padB + 3} stroke="#9ca3af" />
                <text x={xForN(n)} y={H - padB + 14} textAnchor="middle" fontSize="9" fill="#6b7280">
                  {n}
                </text>
              </g>
            ))}
            <text x={W - padR + 4} y={H - padB + 4} fontSize="9" fill="#6b7280">modules →</text>
            <text x={padL - 30} y={padT + 4} fontSize="9" fill="#6b7280">uren</text>

            {/* Curve */}
            <polyline points={curvePts} fill="none" stroke="#493ee5" strokeWidth="1.5" />

            {/* Marker op huidig project */}
            {totalModules > 0 && (() => {
              const x = xForN(totalModules);
              const y = yForH(baseHours);
              return (
                <g>
                  <line x1={x} y1={padT} x2={x} y2={H - padB} stroke="#9ca3af" strokeDasharray="3 3" strokeWidth="1" />
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#9ca3af" strokeDasharray="3 3" strokeWidth="1" />
                  <circle cx={x} cy={y} r="4" fill="#493ee5" stroke="#fff" strokeWidth="1.5" />
                  <text x={x + 8} y={y - 6} fontSize="10" fill="#374151">
                    {totalModules} modules · {formatNumber(baseHours, 0)} u
                  </text>
                </g>
              );
            })()}
          </svg>
        </div>

        <p className="text-[11px] text-muted-foreground">
          De pm-kosten worden automatisch in <strong>Assemblagehal &gt; Arbeid</strong> meegenomen
          als regel "Projectmanagement". Pas het uurtarief aan via{" "}
          <a className="underline" href={`/library/labour?project=${data.project?.id ?? ""}`}>Arbeid &amp; tarieven</a>.
        </p>
      </div>
    );
  }

  function renderKolomCorrectieTab() {
    if (!brForScope) return <div className="text-sm text-muted-foreground">Kies een gebouw om de kolomcorrectie te bekijken.</div>;
    const mods = data.modules.get(brForScope.building.id) ?? [];
    const totalModules = mods.reduce((s, m) => s + m.count, 0);
    const area = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
    const bgg = brForScope.effectiveInputs["_opp_begane_grond"] ?? 0;
    const floorsRaw = area > 0 && bgg > 0 ? area / bgg : 1;
    const floors = Math.max(1, Math.round(floorsRaw));
    // "Aantal gevelkolommen per laag" — user-bewerkbaar, default = totale hoek-kolommen (geen binnenkolommen).
    const modulesPerLaag = Math.ceil(totalModules / floors);
    const defaultGevel = modulesPerLaag * 4;
    const gevelInput = brForScope.effectiveInputs["Aantal gevelkolommen per laag"];
    const gevelkolommenPerLaag = gevelInput != null && gevelInput > 0 ? gevelInput : defaultGevel;

    const kc = computeKolomCorrectie(totalModules, floors, gevelkolommenPerLaag);
    const lvlqPrice = data.materials.find((m) => m.code === "LVLQ")?.pricePerUnit ?? 0;
    const baubPrice = data.materials.find((m) => m.code === "BAUB")?.pricePerUnit ?? 0;

    async function saveGevelkolommen(v: number) {
      const bid = brForScope!.building.id;
      const existing = (data.buildingInputs.get(bid) ?? []).find((i) => i.inputLabel === "Aantal gevelkolommen per laag");
      if (existing) {
        await fetch(`/api/buildings/${bid}/inputs`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: [{ id: existing.id, quantity: v }] }),
        });
      } else {
        await fetch(`/api/buildings/${bid}/inputs`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputLabel: "Aantal gevelkolommen per laag", quantity: v }),
        });
      }
      data.refetch();
    }

    return (
      <div className="space-y-3">
        {/* Invoer + kerngetallen */}
        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Invoer</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-3 py-2 text-xs md:grid-cols-3">
            <Stat label="Totaal modules" value={totalModules} unit="stuks" />
            <Stat label="Verdiepingen" value={floors} unit="" />
            <Stat label="Modules per laag" value={kc.modulesPerLaag} unit="stuks" />
            <Stat label="Kolommen per laag (totaal)" value={kc.totaalKolommenPerLaag} unit="stuks" />
            <Stat label="Binnenkolommen per laag" value={kc.binnenkolommenPerLaag} unit="stuks" />
            <div className="flex items-center gap-2">
              <span className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Gevelkolommen per laag</span>
                <span className="text-[10px] text-muted-foreground">default = 4 × modules p/laag</span>
              </span>
              <Input
                key={`gk-${gevelkolommenPerLaag}`}
                type="number"
                className="h-7 w-20 text-right text-xs tabular-nums"
                defaultValue={gevelkolommenPerLaag}
                onBlur={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v !== gevelkolommenPerLaag) saveGevelkolommen(Math.max(0, v));
                }}
              />
            </div>
          </div>
        </div>

        {/* Laag-voor-laag tabel */}
        <div className="rounded-md border bg-white">
          <div className="border-b px-3 py-2 text-xs font-semibold">Per laag</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Laag</th>
                <th className="px-3 py-1.5 text-right font-medium">Lagen boven</th>
                <th className="px-3 py-1.5 text-right font-medium">Doorsnede</th>
                <th className="px-3 py-1.5 font-medium">Gevel</th>
                <th className="px-3 py-1.5 font-medium">Binnen</th>
                <th className="px-3 py-1.5 text-right font-medium">LVL kolommen</th>
                <th className="px-3 py-1.5 text-right font-medium">BAUB kolommen</th>
                <th className="px-3 py-1.5 text-right font-medium">m³/kolom</th>
              </tr>
            </thead>
            <tbody>
              {kc.lagen.map((l) => (
                <tr key={l.index} className="odd:bg-white even:bg-gray-50/40">
                  <td className="px-3 py-1.5">{l.index === 1 ? "BG" : `${l.index - 1}e`}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.lagenBoven}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.doorsnedeMm} mm</td>
                  <td className="px-3 py-1.5"><MatChip mat={l.gevelMateriaal} /></td>
                  <td className="px-3 py-1.5"><MatChip mat={l.binnenMateriaal} /></td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.lvlCount}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.baubCount}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(l.volumePerKolomM3, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Afwijking t.o.v. baseline — wat er echt in de begroting landt. */}
        {(() => {
          const baselineLvlM3 = totalModules * 4 * 0.145 * 0.145 * 3.155;
          const deltaLvl = kc.lvlVolumeM3 - baselineLvlM3;
          const deltaBaub = kc.baubucheVolumeM3;
          const lvlqLoss = data.materials.find((m) => m.code === "LVLQ")?.lossPct ?? 0;
          const baubLoss = data.materials.find((m) => m.code === "BAUB")?.lossPct ?? 0;
          const deltaLvlCost = deltaLvl * (1 + lvlqLoss) * lvlqPrice;
          const deltaBaubCost = deltaBaub * (1 + baubLoss) * baubPrice;
          const totalDeltaCost = deltaLvlCost + deltaBaubCost;
          return (
            <div className="rounded-md border bg-white">
              <div className="border-b px-3 py-2 text-xs font-semibold">Afwijking t.o.v. baseline (LVL 145 × modules)</div>
              <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                <span className="text-muted-foreground">Baseline LVL (al in kengetal-LVLQ)</span>
                <span className="text-right tabular-nums">{formatNumber(baselineLvlM3, 3)} m³</span>
                <span className="w-24 text-right tabular-nums text-muted-foreground">referentie</span>
                <span className={deltaLvl < 0 ? "text-emerald-700" : ""}>Δ LVL (LVLQ)</span>
                <span className={`text-right tabular-nums ${deltaLvl < 0 ? "text-emerald-700" : ""}`}>
                  {deltaLvl >= 0 ? "+" : ""}{formatNumber(deltaLvl, 3)} m³
                </span>
                <span className={`w-24 text-right tabular-nums ${deltaLvl < 0 ? "text-emerald-700" : ""}`}>
                  {deltaLvlCost >= 0 ? "" : ""}{formatEUR(deltaLvlCost)}
                </span>
                <span className={deltaBaub > 0 ? "text-rose-700" : ""}>Δ Baubuche (BAUB)</span>
                <span className={`text-right tabular-nums ${deltaBaub > 0 ? "text-rose-700" : ""}`}>
                  +{formatNumber(deltaBaub, 3)} m³
                </span>
                <span className={`w-24 text-right tabular-nums ${deltaBaub > 0 ? "text-rose-700" : ""}`}>
                  {formatEUR(deltaBaubCost)}
                </span>
              </div>
              <div className="flex items-center justify-between border-t px-3 py-2 text-sm font-semibold">
                <span>Totaal kolomcorrectie</span>
                <span className={`tabular-nums ${totalDeltaCost > 0 ? "text-rose-700" : totalDeltaCost < 0 ? "text-emerald-700" : ""}`}>
                  {totalDeltaCost === 0 ? formatEUR(0) : (totalDeltaCost > 0 ? `+${formatEUR(totalDeltaCost)}` : formatEUR(totalDeltaCost))}
                </span>
              </div>
              <div className="border-t bg-gray-50/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                Dit bedrag verschijnt als aparte "Kolomcorrectie"-regel onder Bouwpakket in de begroting. Verlies-% van LVLQ en BAUB is al inbegrepen.
              </div>
            </div>
          );
        })()}

        <p className="text-xs text-muted-foreground">
          Deze hoeveelheden passen zich aan in de LVLQ en BAUB materiaalregels in de begroting (onder Bouwpakket). De standaard 145 × 145 mm kolom + 3,155 m hoogte + 4 kolommen per module zijn vaste aannames; Baubuche wordt ingezet vanaf 4 verdiepingen voor gevelkolommen en 5+ voor binnenkolommen. Vanaf 6 verdiepingen wordt de kolom ook dikker naar onderen. De baseline (4 × modules × 145² × 3,155 m) zit al in de kengetal-LVLQ, dus bij V &lt; 4 met default-dikte verandert er niets.
        </p>
      </div>
    );
  }

  function renderCsvOverrideTab() {
    if (!brForScope) return <div className="text-sm text-muted-foreground">Kies een gebouw.</div>;
    const bid = brForScope.building.id;
    const aggregates = data.csvAggregatesByBuilding.get(bid) ?? [];
    const overrides = data.csvOverridesByBuilding.get(bid) ?? [];
    const hasCsv = aggregates.length > 0;

    // Kengetal-netto per materiaal (pure som uit kengetal_rows × effective inputs) —
    // dus vóór CSV-override. Dit is de "computed" kant van de vergelijking.
    const setId = brForScope.building.kengetalSetId ?? data.project?.defaultKengetalSetId ?? "";
    const kgRows = data.kengetalRowsBySet.get(setId) ?? [];
    const eff = brForScope.effectiveInputs;
    const kgNettoByMat = new Map<string, number>();
    for (const r of kgRows) {
      const qty = eff[r.inputLabel] ?? 0;
      if (qty <= 0) continue;
      kgNettoByMat.set(r.materialId, (kgNettoByMat.get(r.materialId) ?? 0) + qty * r.ratio);
    }

    // Mapping CSV → app per materiaal. Materialen die in de overrides voorkomen
    // zijn al gemapt; andere kunnen gemapt worden via de dropdown (nu simpel: read-only).
    const ovrByMat = new Map(overrides.map((o) => [o.materialId, o]));
    const matsInUse = new Set<string>();
    for (const [mid] of kgNettoByMat) matsInUse.add(mid);
    for (const o of overrides) matsInUse.add(o.materialId);

    type Row = { mat: typeof data.materials[number]; kgNetto: number; csvNetto: number; useCsv: boolean; csvCode: string; csvUnit: string; deviation: number | null };
    const rows: Row[] = [];
    for (const matId of matsInUse) {
      const mat = data.materialsMap.get(matId);
      if (!mat) continue;
      const kgNetto = kgNettoByMat.get(matId) ?? 0;
      const ovr = ovrByMat.get(matId);
      const agg = ovr ? aggregates.find((a) => a.csvCode === ovr.csvCode && a.unit === ovr.csvUnit) : undefined;
      const csvNetto = agg ? csvQtyForMaterial(agg, mat.unit) : 0;
      const deviation = kgNetto > 0 && csvNetto > 0 ? ((csvNetto - kgNetto) / kgNetto) * 100 : null;
      rows.push({
        mat, kgNetto, csvNetto,
        useCsv: !!ovr?.useCsv,
        csvCode: ovr?.csvCode ?? "",
        csvUnit: ovr?.csvUnit ?? "",
        deviation,
      });
    }
    rows.sort((a, b) => {
      // Prioriteit: CSV-gematched + met groot verschil, dan CSV-gematched, dan rest.
      const aHas = a.csvCode !== ""; const bHas = b.csvCode !== "";
      if (aHas !== bHas) return aHas ? -1 : 1;
      return (b.kgNetto + b.csvNetto) - (a.kgNetto + a.csvNetto);
    });

    async function upload(file: File) {
      const text = await file.text();
      const res = await fetch(`/api/buildings/${bid}/csv`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, fileName: file.name }),
      });
      if (!res.ok) { alert((await res.json()).error ?? "Upload mislukt"); return; }
      data.refetch();
    }
    async function clearAll() {
      if (!confirm("Alle CSV-data en overrides voor dit gebouw verwijderen?")) return;
      await fetch(`/api/buildings/${bid}/csv`, { method: "DELETE" });
      data.refetch();
    }
    async function patchOverrides(updates: { materialId: string; useCsv?: boolean; csvCode?: string; csvUnit?: string }[]) {
      await fetch(`/api/buildings/${bid}/csv`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: updates }),
      });
      data.refetch();
    }
    const toggleMat = (r: Row, useCsv: boolean) => patchOverrides([{ materialId: r.mat.id, useCsv, csvCode: r.csvCode, csvUnit: r.csvUnit }]);
    const acceptSmallDeviations = () => {
      const updates = rows
        .filter((r) => r.csvCode !== "" && r.deviation !== null && Math.abs(r.deviation) < 10)
        .map((r) => ({ materialId: r.mat.id, useCsv: true, csvCode: r.csvCode, csvUnit: r.csvUnit }));
      patchOverrides(updates);
    };
    const resetAll = () => {
      const updates = rows.filter((r) => r.csvCode !== "").map((r) => ({ materialId: r.mat.id, useCsv: false, csvCode: r.csvCode, csvUnit: r.csvUnit }));
      patchOverrides(updates);
    };
    const enableAll = () => {
      const updates = rows.filter((r) => r.csvCode !== "").map((r) => ({ materialId: r.mat.id, useCsv: true, csvCode: r.csvCode, csvUnit: r.csvUnit }));
      patchOverrides(updates);
    };

    return (
      <div className="space-y-3">
        {/* Upload / header */}
        <div className="rounded-md border bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs">
              <div className="font-semibold">CSV-stuklijst</div>
              <div className="text-muted-foreground">
                {hasCsv ? `${aggregates.length} materiaal-codes geladen. Netto-hoeveelheden; verlies-% komt uit de materialenbibliotheek.` : "Upload een semicolon-CSV met materialId / countUnit / count / length / width / volume."}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border bg-white px-2.5 py-1 text-xs hover:bg-gray-50">
                <Upload className="h-3 w-3" />
                {hasCsv ? "Andere CSV" : "Upload CSV"}
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} />
              </label>
              {hasCsv && (
                <button onClick={clearAll} className="rounded border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/5">Wis CSV</button>
              )}
            </div>
          </div>
        </div>

        {hasCsv && (
          <div className="flex flex-wrap gap-2">
            <button onClick={acceptSmallDeviations} className="rounded border bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100">
              Zet CSV aan waar afwijking &lt; 10 %
            </button>
            <button onClick={enableAll} className="rounded border bg-gray-50 px-3 py-1.5 text-xs text-foreground hover:bg-gray-100">
              Alles CSV
            </button>
            <button onClick={resetAll} className="rounded border bg-gray-50 px-3 py-1.5 text-xs text-foreground hover:bg-gray-100">
              Reset (alles kengetal)
            </button>
          </div>
        )}

        {hasCsv && (
          <div className="rounded-md border bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">Materiaal</th>
                  <th className="px-3 py-1.5 font-medium">CSV code</th>
                  <th className="px-3 py-1.5 text-right font-medium">Kengetal netto</th>
                  <th className="px-3 py-1.5 text-right font-medium">CSV netto</th>
                  <th className="px-3 py-1.5 text-right font-medium">Afwijking</th>
                  <th className="px-3 py-1.5 text-center font-medium">Gebruik CSV</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const devCls = r.deviation == null ? "text-muted-foreground"
                    : Math.abs(r.deviation) < 10 ? "text-emerald-700"
                    : Math.abs(r.deviation) < 30 ? "text-amber-700"
                    : "text-rose-700";
                  const suggest = r.deviation != null && Math.abs(r.deviation) < 10;
                  return (
                    <tr key={r.mat.id} className="odd:bg-white even:bg-gray-50/40">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{r.mat.code}</span>
                        <span className="ml-1.5 text-muted-foreground">— {r.mat.name}</span>
                        {r.mat.unit && <span className="ml-1 text-[10px] text-muted-foreground">({r.mat.unit})</span>}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.csvCode || <span className="italic">geen mapping</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(r.kgNetto, 2)} {r.mat.unit}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.csvCode ? `${formatNumber(r.csvNetto, 2)} ${r.mat.unit}` : "—"}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${devCls}`}>
                        {r.deviation == null ? "—" : `${r.deviation >= 0 ? "+" : ""}${formatNumber(r.deviation, 1)}%`}
                        {suggest && !r.useCsv && <span className="ml-1.5 text-[9px] text-emerald-700">✓ suggest</span>}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {r.csvCode ? (
                          <input type="checkbox" checked={r.useCsv} onChange={(e) => toggleMat(r, e.target.checked)} className="cursor-pointer" />
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Geen data — upload een CSV om te beginnen.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {hasCsv && (() => {
          const unmatched = aggregates.filter((a) => !overrides.some((o) => o.csvCode === a.csvCode && o.csvUnit === a.unit));
          if (unmatched.length === 0) return null;
          return (
            <div className="rounded-md border bg-amber-50 p-3 text-xs text-amber-900">
              <div className="mb-1 font-medium">CSV-codes zonder app-mapping ({unmatched.length})</div>
              <div className="text-[11px]">Niet automatisch gekoppeld: {unmatched.map((a) => `${a.csvCode} (${a.unit})`).join(", ")}. Deze tellen niet mee tenzij je handmatig een mapping toevoegt.</div>
            </div>
          );
        })()}

        <p className="text-xs text-muted-foreground">
          CSV-data is netto. Het verlies-% uit de materialenbibliotheek wordt er nog bij gerekend om het bruto-bedrag te krijgen. Zet een checkbox aan → de begroting gebruikt de CSV-waarde i.p.v. de kengetal-berekening voor dat specifieke materiaal.
        </p>
      </div>
    );
  }

  function renderTransportTab() {
    if (!data.project) return null;
    const auto = calcResult!.autoTransport;
    const materiaalOpen = expandedGroups.has("__materiaaltransport");
    const modulairOpen = expandedGroups.has("__modulair") || expandedGroups.size === 0;
    const toggleInfo = (k: string) =>
      setExpandedGroups((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

    return (
      <div className="space-y-3">
        {/* Materiaaltransport — automatische berekening NL ⇄ Polen, niet bewerkbaar. */}
        <div className="rounded-md border bg-white">
          <button onClick={() => toggleInfo("__materiaaltransport")}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50">
            {materiaalOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="font-semibold">Materiaaltransport</span>
            <span className="text-xs text-muted-foreground">NL ⇄ VMG Polen</span>
            <span className="ml-auto font-semibold tabular-nums">{formatEUR(auto.inboundCost + auto.outboundCost)}</span>
          </button>
          {materiaalOpen && (
            <div className="border-t">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-gray-50/70 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Traject</th>
                    <th className="px-3 py-1.5 text-right font-medium">Volume</th>
                    <th className="px-3 py-1.5 text-right font-medium">Trucks</th>
                    <th className="px-3 py-1.5 text-right font-medium">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="px-3 py-1.5">
                      Naar VMG Polen <span className="text-muted-foreground">— I-joists, LVL, Spano · €700 / vrachtwagen</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatQty(auto.inboundM3)} m³</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{auto.inboundTrucks}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatEUR(auto.inboundCost)}</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5">
                      Van VMG Polen naar Raamsdonksveer <span className="text-muted-foreground">— bouwpakket · €1.600 / vrachtwagen</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatQty(auto.outboundM3)} m³</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{auto.outboundTrucks}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatEUR(auto.outboundCost)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="border-t bg-gray-50/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                Telt mee in bouwpakket-transport. Automatisch berekend; niet bewerkbaar.
              </div>
            </div>
          )}
        </div>

        {/* Transport 3D modulair — bin-packing calculator (naar locatie). */}
        <div className="rounded-md border bg-white">
          <button onClick={() => toggleInfo("__modulair")}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50">
            {modulairOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="font-semibold">Transport 3D modulair</span>
            <span className="text-xs text-muted-foreground">naar locatie</span>
            <span className="ml-auto font-semibold tabular-nums">
              {transportTotal != null ? formatEUR(transportTotal) : <span className="text-xs font-normal text-muted-foreground">—</span>}
            </span>
          </button>
          {modulairOpen && (
            <div className="border-t p-3">
              <TransportCalculator
                project={data.project}
                scope={scope}
                onProjectChange={data.refetch}
                onScopeTotal={(total) => setTransportTotal(total)}
                onProjectTotal={(total) => {
                  // Schrijf project-brede waarde door naar de layout-context →
                  // assemblagehal.transportCost. Wordt ALTIJD geëmit, ook in
                  // single-building scope (TransportCalculator vuurt dan een
                  // extra project-brede POST). Server persist sync in DB.
                  if (total != null) {
                    setAutoAssemblageTransport(total);
                    // Refetch zodat data.project.autoAssemblageTransportCost
                    // ook in sync komt — anders zou hydrate later kunnen
                    // terugvallen op een oude DB-waarde.
                    data.refetch();
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderManualTransport() {
    return (
      <div className="rounded-md border bg-white">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-medium">Omschrijving</th>
              <th className="px-3 py-2 font-medium">Groep</th>
              <th className="px-3 py-2 text-right font-medium">Afstand</th>
              <th className="px-3 py-2 font-medium">Voertuig</th>
              <th className="px-3 py-2 text-right font-medium">Ritten</th>
              <th className="px-3 py-2 text-right font-medium">€/rit</th>
              <th className="px-3 py-2 text-right font-medium">Totaal</th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {data.transport.map((t) => {
              const perTrip = t.costPerTripOverride ?? (t.vehicleType?.costPerKm ?? 0) * t.distanceKm;
              const total = t.tripCount * perTrip;
              return (
                <tr key={t.id} className="odd:bg-white even:bg-gray-50/40">
                  <td className="px-3 py-1">
                    <Input className="h-7 text-xs" defaultValue={t.description}
                      onBlur={(e) => updateTransport(t.id, { description: e.target.value })} />
                  </td>
                  <td className="px-3 py-1">
                    <Select value={t.costGroup} onValueChange={(v) => updateTransport(t.id, { costGroup: v })}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bouwpakket">Bouwpakket</SelectItem>
                        <SelectItem value="assemblagehal">Assemblagehal</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Input className="h-7 w-20 text-right text-xs tabular-nums" type="number"
                      defaultValue={t.distanceKm}
                      onBlur={(e) => updateTransport(t.id, { distanceKm: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td className="px-3 py-1">
                    <Select value={t.vehicleTypeId} onValueChange={(v) => updateTransport(t.id, { vehicleTypeId: v })}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {data.vehicleTypes.map((vt) => <SelectItem key={vt.id} value={vt.id}>{vt.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Input className="h-7 w-16 text-right text-xs tabular-nums" type="number"
                      defaultValue={t.tripCount}
                      onBlur={(e) => updateTransport(t.id, { tripCount: parseInt(e.target.value) || 1 })} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Input className="h-7 w-24 text-right text-xs tabular-nums" type="number"
                      defaultValue={t.costPerTripOverride ?? ""}
                      placeholder={String(((t.vehicleType?.costPerKm ?? 0) * t.distanceKm).toFixed(0))}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        updateTransport(t.id, { costPerTripOverride: v === "" ? null : parseFloat(v) });
                      }} />
                  </td>
                  <td className="px-3 py-1 text-right font-medium tabular-nums">{formatEUR(total)}</td>
                  <td className="px-1 py-1">
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteTransport(t.id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t bg-gray-50 text-xs">
              <td className="px-3 py-1.5 font-medium" colSpan={6}>
                Totaal transport (bouwpakket {formatEUR(calcResult!.bouwpakket.transportCost)} · assemblagehal {formatEUR(calcResult!.assemblagehal.transportCost)})
              </td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatEUR(calcResult!.totalTransport)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={addTransport}>
            <Plus className="mr-1 h-3 w-3" /> Nieuwe transportregel
          </Button>
        </div>
      </div>
    );
  }

  async function addTransport() {
    if (!data.project || data.vehicleTypes.length === 0) return;
    await fetch(`/api/projects/${data.project.id}/transport`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Nieuwe rit", costGroup: "bouwpakket", vehicleTypeId: data.vehicleTypes[0].id }),
    });
    data.refetch();
  }
  async function updateTransport(id: string, updates: Record<string, any>) {
    await fetch(`/api/projects/${data.project!.id}/transport`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    data.refetch();
  }
  async function deleteTransport(id: string) {
    await fetch(`/api/projects/${data.project!.id}/transport?rowId=${id}`, { method: "DELETE" });
    data.refetch();
  }

  return (
    <div>
      {/* Folder-tab layout:
            • tab-bar heeft een border-b die als bovenrand van het content-paneel fungeert
            • ACTIEVE tab: bg-white + border-t/l/r + border-b-white + -mb-[1px] + z-10
              → overlapt de bovenrand van de container met 1px zodat de scheidings-
              lijn verdwijnt onder deze tab; tab en content vormen één blok.
            • INACTIEVE tab: bg-gray-100, geen zij-randen, zit visueel achter. */}
      <div className="flex items-end gap-1 border-b border-gray-200 pl-1">
        <TabPill active={tab === "begroting"}   onClick={() => setTab("begroting")}   icon={<Receipt className="h-3 w-3" />}     label="Begroting" />
        <TabPill active={tab === "transport"}   onClick={() => setTab("transport")}   icon={<Truck className="h-3 w-3" />}       label="Transport" />
        <TabPill active={tab === "planning"}    onClick={() => setTab("planning")}    icon={<ClipboardList className="h-3 w-3" />} label="PM" />
        {!isAll && (
          <TabPill active={tab === "efficientie"} onClick={() => setTab("efficientie")} icon={<TrendingDown className="h-3 w-3" />} label="Efficiëntie" />
        )}
        {!isAll && (
          <TabPill active={tab === "engineering"} onClick={() => setTab("engineering")} icon={<Wrench className="h-3 w-3" />} label="Engineering" />
        )}
        {!isAll && (
          <TabPill active={tab === "kolomcorrectie"} onClick={() => setTab("kolomcorrectie")} icon={<Columns className="h-3 w-3" />} label="Kolomcorrectie" />
        )}
        {!isAll && (
          <TabPill active={tab === "csv"} onClick={() => setTab("csv")} icon={<FileSpreadsheet className="h-3 w-3" />} label="CSV override" />
        )}
        {tab === "begroting" && data.project && (() => {
          // Stuur disabled-keys mee als query-param zodat de Excel-export dezelfde
          // aan/uit-state respecteert als wat hier op het scherm staat.
          const disabledParam = disabledKeys.size > 0
            ? `?disabled=${encodeURIComponent(Array.from(disabledKeys).join(","))}`
            : "";
          return (
            <a
              href={`/api/projects/${data.project.id}/export${disabledParam}`}
              className="mb-1 ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              title="Download de begroting als Excel — respecteert je aan/uit-vinkjes"
            >
              <Download className="h-3 w-3" /> Excel
            </a>
          );
        })()}
      </div>

      {/* Content-paneel — rondom de active tab: zelfde bg-white, geen top-border
           (de tab-bar levert die lijn). De tab zit met -mb-[1px] over de rand heen. */}
      <div className="rounded-b-md border border-t-0 border-gray-200 bg-white p-0">
      {tab === "begroting" && (
        <div>
          {/* Vlakke accordion-stack: elk blok wordt gescheiden door één enkele
               divide-y lijn, geen dubbele borders of inconsistente gaps tussen
               cards. Grand total + sunburst staan apart met eigen spacing. */}
          <div className="divide-y divide-gray-200">
            {groupsToShow.map((g) => renderGroup(g))}

            {/* Engineering — Sustainer-fee + constructieberekening, complexiteit-afhankelijk.
                Per-gebouw in building-scope; in project-view gesommeerd over alle gebouwen. */}
            {renderEngineeringSection()}

            {/* Bijkomend (hoofdaannemer) — project-brede opslagen, naamgeving uit het Excel-origineel. */}
            {isAll && (
              <div className="bg-white">
                <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
                  <span className="text-sm font-semibold">Bijkomend (hoofdaannemer)</span>
                  <span className="text-xs text-muted-foreground">opslagen over het hele project</span>
                </div>
                {calcResult.projectMarkups.length > 0 && renderMarkupsEditor(null, calcResult.projectMarkups,
                  ["grand_total", "totaal_ex_derden", "inkoop_derden"])}
                {calcResult.projectMarkups.length === 0 && isAll && (
                  <div className="px-3 py-2 text-xs">
                    <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => addMarkup(null)}>
                      <Plus className="mr-1 h-3 w-3" /> Regel toevoegen
                    </Button>
                  </div>
                )}
                {calcResult.totalProjectMarkups > 0 && (
                  <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-xs">
                    <span className="font-semibold">Totaal bijkomend</span>
                    <span className="font-semibold tabular-nums">{formatEUR(calcResult.totalProjectMarkups)}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Grand total + sunburst staan net buiten de flat-stack met subtiel
               witruim erboven zodat ze als "samenvatting" leesbaar zijn. */}
          <div className="space-y-3 p-3">
          <div className="rounded-md border-2 bg-white px-4 py-2.5" style={{ borderColor: "var(--system-tint)" }}>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="font-semibold">
                  {isAll ? "Totaal project excl. BTW" : "Subtotaal dit gebouw (1×)"}
                </span>
                {scopedGfa > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    · {formatNumber(scopedGfa, 0)} m² · {formatEUR(scopedGfa > 0 ? scopedTotalExVat / scopedGfa : 0)} /m²
                  </span>
                )}
              </div>
              <div className="text-lg font-bold tabular-nums">{formatEUR(scopedTotalExVat)}</div>
            </div>
          </div>

          {/* Sunburst-diagram — tekstloos, gecentreerd, klikbaar om dieper te zoomen.
              Hoofdaannemer-opslagen zijn proportioneel verdeeld over de hoofdcategorieën. */}
          <BegrotingSunburst root={buildSunburstData()} />
          </div>
        </div>
      )}

      {tab === "transport" && (<div className="p-3">{renderTransportTab()}</div>)}
      {tab === "planning" && (<div className="p-3">{renderPlanningTab()}</div>)}
      {tab === "efficientie" && (<div className="p-3">{renderEfficiencyTab()}</div>)}
      {tab === "engineering" && (<div className="p-3">{renderEngineeringTab()}</div>)}
      {tab === "kolomcorrectie" && (<div className="p-3">{renderKolomCorrectieTab()}</div>)}
      {tab === "csv" && (<div className="p-3">{renderCsvOverrideTab()}</div>)}
      </div>
    </div>
  );
}

/** Normaliseer categorielabels — ALL-CAPS ziet er onrustig uit in de begroting. */
function formatCategory(cat: string): string {
  if (!cat) return cat;
  // Korte afkortingen blijven hoofdletter (LVL, WKO, WTW, etc.); langere woorden → sentence case.
  if (cat.length <= 3 && /^[A-Z]+$/.test(cat)) return cat;
  if (cat === cat.toUpperCase()) return cat.charAt(0) + cat.slice(1).toLowerCase();
  return cat;
}

function TabPill({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  // Folder-tab look met negative-margin overlap.
  //  • ACTIEF: bg-white, borders op top/l/r, -mb-[1px] z-10 relative → de 1px
  //    bottom overlapt de top-border van de content-container, met border-b-white
  //    die de onderliggende lijn wegwist. Tab en content worden één stuk papier.
  //  • INACTIEF: muted bg-gray-100, geen zij-randen, `border-b` zit op dezelfde
  //    lijn als de tab-bar-onderrand — ze liggen visueel achter de actieve tab.
  // Vaste hoogte (30px) = exact dezelfde Y als de LeftTab op het linker paneel.
  if (active) {
    return (
      <button
        onClick={onClick}
        className="relative z-10 -mb-[1px] flex h-[30px] items-center gap-1.5 rounded-t-md border border-b-white border-gray-200 bg-white px-3 text-xs font-semibold text-gray-900"
      >
        {icon} {label}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="flex h-[30px] items-center gap-1.5 rounded-t-md border-b border-gray-200 bg-gray-100 px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
    >
      {icon} {label}
    </button>
  );
}

function MatChip({ mat }: { mat: "LVL" | "BAUB" }) {
  const cls = mat === "BAUB"
    ? "bg-amber-100 text-amber-800"
    : "bg-emerald-50 text-emerald-700";
  const label = mat === "BAUB" ? "Baubuche" : "LVL";
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>
  );
}

function Stat({ label, value, unit }: { label: string; value: React.ReactNode; unit?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xs tabular-nums">
        <span className="font-medium">{value}</span>
        {unit && <span className="ml-1 text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
}
