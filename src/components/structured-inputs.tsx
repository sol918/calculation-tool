"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber, formatQty, computeBvo } from "@/lib/calculation";
import { AlertTriangle } from "lucide-react";
import type { BuildingInput, Module } from "@/types";

/**
 * Structured input sections — Oppervlakten KPI's, Gevels, Vloeren & daken, Appartementen —
 * that compose multiple raw values into the kengetal labels driving the calculation.
 *
 * Raw composite values are stored in buildingInputs with "_"-prefixed labels so they
 * survive across reloads without affecting the calculation directly. Derived labels
 * (Dichte gevel, Open gevel, Plat dak, etc.) feed the kengetallen.
 */

interface Props {
  buildingId: string;
  inputs: BuildingInput[];
  modules: Module[];
  onChanged: () => void;
  knownLabels: string[];
  /** Naam van de actieve kengetal-set (".home", ".optop", ".belgium", …). Bepaalt welke system-specifieke rijen actief zijn. */
  kengetalSetName: string | null;
}

const COMPOSITE_LABELS = new Set([
  "_gevel_m1", "_pct_glas", "_aantal_kozijnen", "_gevel_afwerking",
  "_opp_begane_grond",
  "_wsw_korte_m1", "_wsw_lange_m1",
  // Legacy pct labels kept so stale rows don't show up as "Overig":
  "_pct_wsw_korte", "_pct_wsw_lange",
  "_bk_klein", "_bk_midden", "_bk_groot",
  "_balkon_aantal", "_balkon_opp_per_stuk",
  "_los_toilet", "_voordeur_in_kozijn", "_s2p",
  // Legacy label kept so we don't re-expose it as "Overig":
  "_wsw_m1",
]);
const DRIVEN_LABELS = new Set([
  "Dichte gevel", "Open gevel", "Aantal kozijnen",
  "Dakoppervlak", "Dakomtrek",
  "Module Opp Vloer BG", "Module Opp Vloer Overig", "Module Opp Plafond", "Module Opp Dak",
  "Aantal appartementen", "Aantal voordeuren", "Aantal binnendeuren", "Binnenwand",
  "Binnenwand massief", "WSW", "Verzwaarde WSW", "Extra verzwaarde WSW", "Extra kolom",
  "WSW korte zijde", "WSW lange zijde",
  "Badkamers klein", "Badkamers midden", "Badkamers groot",
  "Los toilet", "Balkons stuks", "Balkons opp",
  "Modules begane grond", "Modules dak", "Modules tussenverdieping",
  "Module breedte totaal", "Module lengte totaal", "Module hoogte totaal",
  "Gemiddelde verdiepingshoogte",
]);

const DEFAULT_VERDIEPINGSHOOGTE = 3.155;
const DEFAULT_BALKON_OPP = 4.0;
const KOZIJN_OPP_PER_STUK = 1.8;
// Module binnenwerk: muurdikte 3 cm per zijde, aftrek op L en B.
const MODULE_WALL_OFFSET_M = 0.03;
// Dakrand-opstand: 0,5 m hoge strook langs de dakomtrek telt mee als geveloppervlak.
const DAKRAND_HOOGTE_M = 0.5;
// GO-aftrek voor WSW langs de lange zijde (m² per m1). Alleen relevant voor .optop;
// de BVO-formule zelf staat als single-source-of-truth in `computeBvo()` (calculation.ts).
const GO_WSW_LANGE_FACTOR = 0.075;

const AFWERKING_LABEL: Record<number, string> = { 1: "Budget", 2: "Middel", 3: "Duur" };

export function StructuredInputs({ buildingId, inputs, modules, onChanged, knownLabels, kengetalSetName }: Props) {
  const isHome = kengetalSetName === ".home";
  const isOptop = kengetalSetName === ".optop";
  const getQty = (label: string): number =>
    inputs.find((i) => i.inputLabel === label)?.quantity ?? 0;

  async function upsertInputs(updates: Record<string, number>) {
    const toUpdate: { id: string; quantity: number }[] = [];
    const toCreate: { inputLabel: string; quantity: number }[] = [];
    for (const [label, qty] of Object.entries(updates)) {
      const found = inputs.find((i) => i.inputLabel === label);
      if (found) toUpdate.push({ id: found.id, quantity: qty });
      else toCreate.push({ inputLabel: label, quantity: qty });
    }
    const promises: Promise<any>[] = [];
    if (toUpdate.length > 0) {
      promises.push(fetch(`/api/buildings/${buildingId}/inputs`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: toUpdate }),
      }));
    }
    for (const item of toCreate) {
      promises.push(fetch(`/api/buildings/${buildingId}/inputs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      }));
    }
    await Promise.all(promises);
    onChanged();
  }

  // ── Module-derivaties ────────────────────────────────────────────
  const moduleTotals = useMemo(() => {
    let oppTotaal = 0;
    let oppGoAdj = 0;
    let korteZijdeTotaal = 0;
    let langeZijdeTotaal = 0;
    let countTotaal = 0;
    let hoogteWSum = 0;
    for (const m of modules) {
      oppTotaal     += m.lengthM * m.widthM * m.count;
      oppGoAdj      += Math.max(0, (m.lengthM - MODULE_WALL_OFFSET_M)) * Math.max(0, (m.widthM - MODULE_WALL_OFFSET_M)) * m.count;
      korteZijdeTotaal += m.widthM * m.count;
      langeZijdeTotaal += m.lengthM * m.count;
      countTotaal   += m.count;
      hoogteWSum    += m.heightM * m.count;
    }
    const avgHoogte = countTotaal > 0 ? hoogteWSum / countTotaal : DEFAULT_VERDIEPINGSHOOGTE;
    return { oppTotaal, oppGoAdj, korteZijdeTotaal, langeZijdeTotaal, countTotaal, avgHoogte };
  }, [modules]);

  // ── Section state ────────────────────────────────────────────────
  const gevelM1 = getQty("_gevel_m1");
  const pctGlas = getQty("_pct_glas");
  const aantalKozijnen = getQty("_aantal_kozijnen");
  const gevelAfwerking = getQty("_gevel_afwerking") || 2; // default midden

  const oppBGG = getQty("_opp_begane_grond");
  const dakomtrek = getQty("Dakomtrek");

  const aantalWoningen = getQty("Aantal appartementen");
  const binnenwandTotaal = getQty("Binnenwand");
  const binnenwandPerWoning = aantalWoningen > 0 ? binnenwandTotaal / aantalWoningen : 0;
  const binnendeurenTotaal = getQty("Aantal binnendeuren");
  const binnendeurenPerWoning = aantalWoningen > 0 ? binnendeurenTotaal / aantalWoningen : 0;

  const wswKorteM1 = getQty("_wsw_korte_m1");
  const wswLangeM1 = getQty("_wsw_lange_m1");
  const wswTotaal = wswKorteM1 + wswLangeM1;

  const binnenwandMassief = getQty("Binnenwand massief");
  const wswHome = getQty("WSW");
  const verzwaardeWsw = getQty("Verzwaarde WSW");
  const extraVerzwaardeWsw = getQty("Extra verzwaarde WSW");
  const extraKolom = getQty("Extra kolom");

  const bkKlein = getQty("_bk_klein");
  const bkMidden = getQty("_bk_midden");
  const bkGroot = getQty("_bk_groot");
  const badkamersTotaal = bkKlein + bkMidden + bkGroot;

  const balkonAantalRaw = getQty("_balkon_aantal");
  const balkonAantal = balkonAantalRaw || aantalWoningen;
  const balkonOppRaw = getQty("_balkon_opp_per_stuk");
  const balkonOppPerStuk = balkonOppRaw || DEFAULT_BALKON_OPP;
  const losToilet = getQty("_los_toilet") > 0;
  const s2pActive = getQty("_s2p") > 0;

  const aantalVoordeuren = aantalWoningen;
  const voordeurRaw = inputs.find((i) => i.inputLabel === "_voordeur_in_kozijn");
  const voordeurInKozijn = voordeurRaw ? voordeurRaw.quantity > 0 : true;
  const voordeurExtraOpp = voordeurInKozijn ? 0 : aantalVoordeuren * KOZIJN_OPP_PER_STUK;

  // ── Gevel-opp breakdown ──────────────────────────────────────────
  // Geveloppervlak = (gevellengte × avg hoogte) + dakrand-opstand (0,5m × dakomtrek).
  // Open gevel = % glas × gevelopp (incl. kozijnen — de kozijnen tellen dus NIET dubbel).
  // Voordeuren alleen erbij als ze NIET in het reguliere kozijnopp zitten.
  const gevelOpp = gevelM1 * moduleTotals.avgHoogte + dakomtrek * DAKRAND_HOOGTE_M;
  const glasOpp = gevelOpp * (pctGlas / 100);
  const openGevel = glasOpp + voordeurExtraOpp;
  const dichteGevel = Math.max(0, gevelOpp - openGevel);

  // ── BVO / GO / verdiepingen ──────────────────────────────────────
  // BVO via gedeelde helper — bouwsysteem-afhankelijk. Voor .home zijn dat
  // andere factoren (0,145 voor gevel; 0,032 voor álle WSW-types) dan voor .optop.
  const bvo = computeBvo(
    {
      "Module oppervlak": moduleTotals.oppTotaal,
      "_gevel_m1": gevelM1,
      "_wsw_korte_m1": wswKorteM1,
      "_wsw_lange_m1": wswLangeM1,
      "WSW": wswHome,
      "Verzwaarde WSW": verzwaardeWsw,
      "Extra verzwaarde WSW": extraVerzwaardeWsw,
    },
    kengetalSetName,
  );
  const go = Math.max(0, moduleTotals.oppGoAdj - wswLangeM1 * GO_WSW_LANGE_FACTOR);
  const goBvoRatio = bvo > 0 ? go / bvo : 0;
  const verdiepingen = oppBGG > 0 ? moduleTotals.oppTotaal / oppBGG : 0;

  // ── Handlers ─────────────────────────────────────────────────────
  function computeGevelUpdates(raw: { g?: number; gl?: number; ak?: number; vdrExtra?: number; dk?: number }): Record<string, number> {
    const g = raw.g ?? gevelM1;
    const gl = raw.gl ?? pctGlas;
    const ak = raw.ak ?? aantalKozijnen;
    const vdrE = raw.vdrExtra ?? voordeurExtraOpp;
    const dk = raw.dk ?? dakomtrek;
    const opp = g * moduleTotals.avgHoogte + dk * DAKRAND_HOOGTE_M;
    const open = opp * (gl / 100) + vdrE;
    const dicht = Math.max(0, opp - open);
    return {
      _gevel_m1: g, _pct_glas: gl, _aantal_kozijnen: ak,
      "Open gevel": open, "Dichte gevel": dicht, "Aantal kozijnen": ak,
    };
  }
  const onGevelSave = (raw: { g?: number; gl?: number; ak?: number }) =>
    upsertInputs(computeGevelUpdates(raw));

  async function onVoordeurInKozijn(checked: boolean) {
    const newFlag = checked ? 1 : 0;
    const newExtra = checked ? 0 : aantalVoordeuren * KOZIJN_OPP_PER_STUK;
    await upsertInputs({ _voordeur_in_kozijn: newFlag, ...computeGevelUpdates({ vdrExtra: newExtra }) });
  }

  async function onAantalWoningen(v: number) {
    const updates: Record<string, number> = {
      "Aantal appartementen": v,
      "Aantal voordeuren": v,
    };
    if (binnenwandPerWoning > 0) updates["Binnenwand"] = binnenwandPerWoning * v;
    if (binnendeurenPerWoning > 0) updates["Aantal binnendeuren"] = Math.round(binnendeurenPerWoning * v);
    if (!voordeurInKozijn) {
      Object.assign(updates, computeGevelUpdates({ vdrExtra: v * KOZIJN_OPP_PER_STUK }));
    }
    await upsertInputs(updates);
  }

  async function onBGG(v: number) {
    await upsertInputs({ _opp_begane_grond: v });
  }

  async function onBinnenwandTotaal(v: number) {
    await upsertInputs({ "Binnenwand": v });
  }
  async function onBinnenwandPerWoning(v: number) {
    await upsertInputs({ "Binnenwand": v * (aantalWoningen || 1) });
  }
  async function onBinnendeurenTotaal(v: number) {
    await upsertInputs({ "Aantal binnendeuren": v });
  }
  async function onBinnendeurenPerWoning(v: number) {
    await upsertInputs({ "Aantal binnendeuren": Math.round(v * (aantalWoningen || 1)) });
  }

  async function onBadkamerSplit(part: "klein" | "midden" | "groot", v: number) {
    const labelMap = { klein: "Badkamers klein", midden: "Badkamers midden", groot: "Badkamers groot" } as const;
    await upsertInputs({
      [`_bk_${part}`]: v,
      [labelMap[part]]: v,
    });
  }

  const overigeLabels = knownLabels.filter(
    (l) => !DRIVEN_LABELS.has(l) && !COMPOSITE_LABELS.has(l) && !l.startsWith("_"),
  );

  // ── Validaties (WARNING-niveau, niet blokkerend) ────────────────
  // Alleen regels op velden die user-invoer krijgen. Module-maten worden in
  // page.tsx gevalideerd (dat is de plek waar ze bewerkt worden).
  const warnings: Record<string, string> = {};
  const totalWsw = wswHome + verzwaardeWsw + extraVerzwaardeWsw + wswKorteM1 + wswLangeM1;
  const goPerApp = aantalWoningen > 0 ? go / aantalWoningen : 0;
  const binnenwandPerAppRatio = aantalWoningen > 0 && goPerApp > 0 ? binnenwandPerWoning / goPerApp : 0;
  const wswPerApp = aantalWoningen > 0 ? totalWsw / aantalWoningen : 0;
  const gevelBvoRatio = bvo > 0 ? gevelM1 / bvo : 0;
  const kozijnenPerGevelOpp = gevelOpp > 0 ? aantalKozijnen / gevelOpp : 0;
  const balkonOppPerBalkon = balkonAantalRaw > 0 ? balkonOppPerStuk : 0;

  // Verdiepingen
  if (verdiepingen > 0 && verdiepingen < 1) warnings.bgg = "Gemiddeld verdiepingsaantal < 1 — controleer module-oppervlak en BGG.";
  else if (verdiepingen > 8) warnings.bgg = "Meer dan 8 verdiepingen — constructief complex, check kolomcorrectie.";

  // Appartementen — GO per appartement
  if (aantalWoningen > 0 && goPerApp > 0) {
    if (goPerApp < 25) warnings.aantalApp = `GO per appartement (${formatNumber(goPerApp, 0)} m²) is erg klein — controleer.`;
    else if (goPerApp > 100) warnings.aantalApp = `GO per appartement (${formatNumber(goPerApp, 0)} m²) is groot — controleer.`;
  }

  // Badkamers totaal vs aantal apps (strikte gelijkheid)
  if (aantalWoningen > 0 && badkamersTotaal !== aantalWoningen) {
    const msg = `Totaal badkamers (${badkamersTotaal}) komt niet overeen met aantal appartementen (${aantalWoningen}).`;
    warnings.bkKlein = msg; warnings.bkMidden = msg; warnings.bkGroot = msg;
  }

  // Binnendeuren per appartement
  if (aantalWoningen > 0) {
    if (binnendeurenPerWoning < 1) warnings.binnendeuren = "Minder dan 1 binnendeur per appartement — controleer.";
    else if (binnendeurenPerWoning > 6) warnings.binnendeuren = "Meer dan 6 binnendeuren per appartement — controleer.";
  }

  // Binnenwand per appartement per m² GO
  if (aantalWoningen > 0 && binnenwandPerAppRatio > 0) {
    if (binnenwandPerAppRatio < 0.08) warnings.binnenwand = "Weinig binnenwand (studio-achtig) — controleer.";
    else if (binnenwandPerAppRatio > 0.45) warnings.binnenwand = "Veel binnenwand per m² GO — controleer.";
  }

  // WSW per appartement
  if (aantalWoningen > 0 && totalWsw > 0) {
    if (wswPerApp < 3) warnings.wsw = `WSW per appartement (${formatNumber(wswPerApp, 1)} m¹) is laag — controleer.`;
    else if (wswPerApp > 18) warnings.wsw = `WSW per appartement (${formatNumber(wswPerApp, 1)} m¹) is hoog — controleer.`;
  }

  // Gevel / BVO
  if (bvo > 0 && gevelM1 > 0) {
    if (gevelBvoRatio < 0.25) warnings.gevelM1 = "Geveltotaal / BVO < 0,25 — controleer geveltotaal.";
    else if (gevelBvoRatio > 1.5) warnings.gevelM1 = "Geveltotaal / BVO > 1,5 — controleer geveltotaal.";
  }

  // % glas
  if (pctGlas > 0) {
    if (pctGlas < 10) warnings.pctGlas = "Laag glaspercentage — check daglichttoets.";
    else if (pctGlas > 45) warnings.pctGlas = "Hoog glaspercentage — check oververhitting en energie.";
  }

  // Kozijnen per m² gevel
  if (gevelOpp > 0 && aantalKozijnen > 0) {
    if (kozijnenPerGevelOpp < 0.04) warnings.aantalKozijnen = "Weinig kozijnen per m² gevel — controleer.";
    else if (kozijnenPerGevelOpp > 0.15) warnings.aantalKozijnen = "Veel kozijnen per m² gevel — controleer.";
  }

  // Balkons — Bouwbesluit/BBL
  if (aantalWoningen > 0 && goPerApp > 50 && balkonAantal < aantalWoningen) {
    warnings.balkonAantal = "GO per woning > 50 m²: een (niet-gemeenschappelijke) buitenruimte is verplicht vanuit het Bouwbesluit/BBL.";
  }
  if (balkonOppPerBalkon > 0) {
    if (balkonOppPerBalkon < 4) warnings.balkonOpp = "Bouwbesluit-minimum voor een niet-gemeenschappelijke buitenruimte is 4 m².";
    else if (balkonOppPerBalkon > 20) warnings.balkonOpp = "Balkon groter dan 20 m² — controleer.";
  }
  if (aantalWoningen > 0 && balkonAantal > aantalWoningen * 1.5) {
    warnings.balkonAantal = "Meer dan 1,5 balkons per appartement — controleer.";
  }

  // GO / BVO ratio (alleen op de KPI — geen input).
  const goBvoPct = goBvoRatio * 100;
  let goBvoWarning: string | null = null;
  if (bvo > 0) {
    if (goBvoPct < 78) goBvoWarning = "GO / BVO < 78% — relatief weinig gebruiksoppervlak.";
    else if (goBvoPct > 92) goBvoWarning = "GO / BVO > 92% — controleer gevel/WSW-inputs.";
  }

  return (
    <div className="space-y-0">
      {/* ── Oppervlakten (KPI's) ──────────────────────────── */}
      <Section title="Oppervlakten">
        <DerivedGrid items={[
          ["Module oppervlak totaal", moduleTotals.oppTotaal, "m²"],
          ["BVO", bvo, "m²"],
          ["GO", go, "m²"],
          ["GO / BVO", goBvoRatio * 100, "%"],
          ["Ø aantal verdiepingen", verdiepingen, ""],
        ]} decimals={{ "GO / BVO": 1, "Ø aantal verdiepingen": 1 }} />
        {goBvoWarning && (
          <div id="w-goBvo" data-has-warning="1" className="mt-1 flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
            <span>{goBvoWarning}</span>
          </div>
        )}
      </Section>

      {/* ── Gevels ────────────────────────────────────────── */}
      <Section title="Gevels">
        <FieldRow label="Geveltotaal" unit="m¹" warning={warnings.gevelM1} id="w-gevelM1">
          <NumInput value={gevelM1} onBlur={(v) => onGevelSave({ g: v })} warning={warnings.gevelM1} />
        </FieldRow>
        <FieldRow label="% glas" unit="%" warning={warnings.pctGlas} id="w-pctGlas">
          <NumInput value={pctGlas} onBlur={(v) => onGevelSave({ gl: v })} step="0.1" warning={warnings.pctGlas} />
        </FieldRow>
        <FieldRow label="Aantal kozijnen" unit="stuks" warning={warnings.aantalKozijnen} id="w-aantalKozijnen">
          <NumInput value={aantalKozijnen} onBlur={(v) => onGevelSave({ ak: v })} integer warning={warnings.aantalKozijnen} />
        </FieldRow>
        <FieldRow label="Gevelafwerking">
          <Select
            value={String(gevelAfwerking)}
            onValueChange={(v) => upsertInputs({ _gevel_afwerking: parseInt(v) })}
          >
            <SelectTrigger className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Budget</SelectItem>
              <SelectItem value="2">Middel</SelectItem>
              <SelectItem value="3">Duur</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <DerivedGrid items={[
          ["Geveloppervlak", gevelOpp, "m²"],
          ["Open gevel", openGevel, "m²"],
          ["Dichte gevel", dichteGevel, "m²"],
        ]} />
      </Section>

      {/* ── Vloeren en daken ───────────────────────────────── */}
      <Section title="Vloeren en daken">
        <FieldRow label="Opp begane grond" unit="m²" warning={warnings.bgg} id="w-bgg">
          <NumInput value={oppBGG} onBlur={onBGG} warning={warnings.bgg} />
        </FieldRow>
        <DerivedGrid items={[
          ["Dakoppervlak (gelijk)", oppBGG, "m²"],
        ]} />
        <FieldRow label="Dakomtrek" unit="m¹">
          <NumInput value={dakomtrek} onBlur={(v) => upsertInputs({ "Dakomtrek": v, ...computeGevelUpdates({ dk: v }) })} />
        </FieldRow>
      </Section>

      {/* ── Appartementen ──────────────────────────────────── */}
      <Section title="Appartementen">
        <FieldRow label="Aantal appartementen" unit="stuks" warning={warnings.aantalApp} id="w-aantalApp">
          <NumInput value={aantalWoningen} onBlur={onAantalWoningen} integer warning={warnings.aantalApp} />
        </FieldRow>
        <div className="grid grid-cols-[1fr_6rem_3rem] items-center gap-2 text-xs text-on-surface-var">
          <span>→ Aantal voordeuren</span>
          <span className="pr-3 text-right tabular-nums">{aantalVoordeuren}</span>
          <span>stuks</span>
        </div>
        <label className="flex items-start gap-2 text-xs leading-tight">
          <input
            type="checkbox"
            checked={voordeurInKozijn}
            onChange={(e) => onVoordeurInKozijn(e.target.checked)}
            className="mt-0.5"
          />
          Voordeur onderdeel van gerekende kozijnoppervlak
        </label>

        <FieldRow label="Binnenwand per app." unit="m¹" warning={warnings.binnenwand} id="w-binnenwand">
          <NumInput value={binnenwandPerWoning} onBlur={onBinnenwandPerWoning} warning={warnings.binnenwand} />
        </FieldRow>
        <FieldRow label="Totaal binnenwand" unit="m¹" warning={warnings.binnenwand}>
          <NumInput value={binnenwandTotaal} onBlur={onBinnenwandTotaal} warning={warnings.binnenwand} />
        </FieldRow>

        <FieldRow label="Binnendeuren per app." unit="stuks" warning={warnings.binnendeuren} id="w-binnendeuren">
          <NumInput value={binnendeurenPerWoning} onBlur={onBinnendeurenPerWoning} integer warning={warnings.binnendeuren} />
        </FieldRow>
        <FieldRow label="Totaal binnendeuren" unit="stuks" warning={warnings.binnendeuren}>
          <NumInput value={binnendeurenTotaal} onBlur={onBinnendeurenTotaal} integer warning={warnings.binnendeuren} />
        </FieldRow>

        <FieldRow label="Binnenwand massief" unit="m¹" disabled={!isHome}>
          <NumInput value={binnenwandMassief} onBlur={(v) => upsertInputs({ "Binnenwand massief": v })} disabled={!isHome} />
        </FieldRow>
        <FieldRow label="WSW" unit="m¹" disabled={!isHome} warning={isHome ? warnings.wsw : undefined} id="w-wsw">
          <NumInput value={wswHome} onBlur={(v) => upsertInputs({ "WSW": v })} disabled={!isHome} warning={isHome ? warnings.wsw : undefined} />
        </FieldRow>
        <FieldRow label="Verzwaarde WSW" unit="m¹" disabled={!isHome} warning={isHome ? warnings.wsw : undefined}>
          <NumInput value={verzwaardeWsw} onBlur={(v) => upsertInputs({ "Verzwaarde WSW": v })} disabled={!isHome} warning={isHome ? warnings.wsw : undefined} />
        </FieldRow>
        <FieldRow label="Extra verzwaarde WSW" unit="m¹" disabled={!isHome} warning={isHome ? warnings.wsw : undefined}>
          <NumInput value={extraVerzwaardeWsw} onBlur={(v) => upsertInputs({ "Extra verzwaarde WSW": v })} disabled={!isHome} warning={isHome ? warnings.wsw : undefined} />
        </FieldRow>
        <FieldRow label="Extra kolom" unit="stuks" disabled={!isHome}>
          <NumInput value={extraKolom} onBlur={(v) => upsertInputs({ "Extra kolom": v })} disabled={!isHome} integer />
        </FieldRow>

        <FieldRow label="WSW korte zijde" unit="m¹" disabled={!isOptop} warning={isOptop ? warnings.wsw : undefined}>
          <NumInput value={wswKorteM1} onBlur={(v) => upsertInputs({ _wsw_korte_m1: v, "WSW korte zijde": v })} disabled={!isOptop} warning={isOptop ? warnings.wsw : undefined} />
        </FieldRow>
        <FieldRow label="WSW lange zijde" unit="m¹" disabled={!isOptop} warning={isOptop ? warnings.wsw : undefined}>
          <NumInput value={wswLangeM1} onBlur={(v) => upsertInputs({ _wsw_lange_m1: v, "WSW lange zijde": v })} disabled={!isOptop} warning={isOptop ? warnings.wsw : undefined} />
        </FieldRow>
        {isOptop && (
          <DerivedGrid items={[
            ["WSW totaal", wswTotaal, "m¹"],
          ]} />
        )}

        <FieldRow label="Badkamers klein" unit="stuks" warning={warnings.bkKlein} id="w-badkamers">
          <NumInput value={bkKlein} onBlur={(v) => onBadkamerSplit("klein", v)} integer warning={warnings.bkKlein} />
        </FieldRow>
        <FieldRow label="Badkamers midden" unit="stuks" warning={warnings.bkMidden}>
          <NumInput value={bkMidden} onBlur={(v) => onBadkamerSplit("midden", v)} integer warning={warnings.bkMidden} />
        </FieldRow>
        <FieldRow label="Badkamers groot" unit="stuks" warning={warnings.bkGroot}>
          <NumInput value={bkGroot} onBlur={(v) => onBadkamerSplit("groot", v)} integer warning={warnings.bkGroot} />
        </FieldRow>
        <DerivedGrid items={[
          ["Badkamers totaal", badkamersTotaal, "stuks"],
        ]} decimals={{ "Badkamers totaal": 0 }} />

        <label className="mt-1 flex items-start gap-2 text-[11px] leading-tight">
          <input
            type="checkbox"
            checked={losToilet}
            onChange={(e) => upsertInputs({ _los_toilet: e.target.checked ? 1 : 0, "Los toilet": e.target.checked ? aantalWoningen : 0 })}
            className="mt-0.5"
          />
          Los toilet per appartement
        </label>

        <label className="mt-1 flex items-start gap-2 text-[11px] leading-tight">
          <input
            type="checkbox"
            checked={s2pActive}
            onChange={(e) => upsertInputs({ _s2p: e.target.checked ? 1 : 0 })}
            className="mt-0.5"
          />
          <span>
            Prefab badkamer (S2P)
            {s2pActive && (
              <span className="ml-1 rounded bg-emerald-100 px-1 py-px text-[10px] font-medium text-emerald-800">S2P actief</span>
            )}
          </span>
        </label>
        {s2pActive && (
          <div className="rounded bg-emerald-50 px-2 py-1 text-[11px] leading-tight text-emerald-900">
            S2P geselecteerd — sanitair per woning, waterleiding per woning, en alle kengetallen + arbeid
            voor badkamers (klein/midden/groot) en los toilet vervallen. In plaats daarvan worden er
            stelposten toegevoegd: toilet €2.000, badkamer klein €7.000, midden €9.000, groot €11.000 per stuk.
          </div>
        )}

        <FieldRow label="Balkons / galerijen" unit="stuks" warning={warnings.balkonAantal} id="w-balkonAantal">
          <NumInput value={balkonAantal} onBlur={(v) => upsertInputs({ _balkon_aantal: v, "Balkons stuks": v, "Balkons opp": v * balkonOppPerStuk })} integer
            placeholder={String(aantalWoningen || 0)} warning={warnings.balkonAantal} />
        </FieldRow>
        <FieldRow label="Opp per balkon" unit="m²" warning={warnings.balkonOpp} id="w-balkonOpp">
          <NumInput value={balkonOppPerStuk}
            onBlur={(v) => upsertInputs({ _balkon_opp_per_stuk: v, "Balkons opp": balkonAantal * v })}
            step="0.1" placeholder={String(DEFAULT_BALKON_OPP)} warning={warnings.balkonOpp} />
        </FieldRow>
        <DerivedGrid items={[
          ["Balkon-opp totaal", balkonAantal * balkonOppPerStuk, "m²"],
        ]} />
      </Section>

      {overigeLabels.length > 0 && (
        <Section title="Overig">
          {overigeLabels.map((label) => {
            const existing = inputs.find((i) => i.inputLabel === label);
            return (
              <FieldRow key={label} label={label}>
                <NumInput value={existing?.quantity ?? 0} onBlur={(v) => upsertInputs({ [label]: v })} />
              </FieldRow>
            );
          })}
        </Section>
      )}
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t-ghost py-2.5 first:border-t-0">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-on-surface-var">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function FieldRow({ label, unit, children, disabled = false, warning, id }: {
  label?: string;
  unit?: string;
  children: React.ReactNode;
  disabled?: boolean;
  /** Non-blocking warning; shows orange icon + tooltip bij het veld. */
  warning?: string | null;
  /** Optional id voor scroll-to-first-warning uit de samenvatting. */
  id?: string;
}) {
  if (!label) return <div>{children}</div>;
  return (
    <div
      id={id}
      data-has-warning={warning ? "1" : undefined}
      className={`grid grid-cols-[1fr_6rem_3rem] items-center gap-2 ${disabled ? "opacity-50" : ""} ${warning ? "rounded bg-amber-50/60 -mx-1 px-1" : ""}`}
    >
      <span className="truncate text-xs">{label}</span>
      <div className="justify-self-end w-24 [&>*]:w-full">{children}</div>
      <span className="inline-flex items-center gap-1 text-xs text-on-surface-var">
        {warning && (
          <span title={warning} className="cursor-help text-amber-600" aria-label="Waarschuwing">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
        )}
        {unit ?? ""}
      </span>
    </div>
  );
}

function NumInput({
  value, onBlur, step = "1", integer = false, placeholder, disabled = false, warning,
}: {
  value: number;
  onBlur: (v: number) => void;
  step?: string;
  integer?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Als non-null: oranje randje op het veld zelf. */
  warning?: string | null;
}) {
  const [text, setText] = useState(() =>
    value ? (integer ? Math.round(value).toString() : formatFloat(value)) : "",
  );
  const focusing = useRef(false);

  useEffect(() => {
    if (focusing.current) return;
    setText(value ? (integer ? Math.round(value).toString() : formatFloat(value)) : "");
  }, [value, integer]);

  return (
    <Input
      className={`h-7 w-full text-right text-xs tabular-nums ${warning ? "border-amber-400 focus-visible:ring-amber-300" : ""}`}
      type="number"
      step={integer ? "1" : step}
      value={text}
      placeholder={placeholder ?? "0"}
      disabled={disabled}
      title={warning ?? undefined}
      onFocus={() => { focusing.current = true; }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        focusing.current = false;
        if (disabled) return;
        const parsed = integer ? parseInt(e.target.value) : parseFloat(e.target.value);
        const safe = Number.isFinite(parsed) ? parsed : 0;
        if (safe !== value) onBlur(safe);
      }}
    />
  );
}

function formatFloat(n: number): string {
  if (Math.abs(n) >= 100) return n.toFixed(1);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

function DerivedGrid({ items, decimals = {} }: {
  items: [string, number, string][];
  decimals?: Record<string, number>;
}) {
  return (
    <div className="grid grid-cols-[1fr_6rem_3rem] items-center gap-x-2 gap-y-1 rounded bg-surface-low py-1.5 text-xs">
      {items.map(([label, value, unit]) => (
        <DerivedRow key={label} label={label} value={value} unit={unit} decimals={decimals[label]} />
      ))}
    </div>
  );
}

function DerivedRow({ label, value, unit, decimals }: { label: string; value: number; unit: string; decimals?: number }) {
  const formatted = decimals != null ? formatNumber(value, decimals) : formatQty(value);
  return (
    <>
      <span className="text-on-surface-var">→ {label}</span>
      <span className="pr-3 text-right tabular-nums">{formatted}</span>
      <span className="text-on-surface-var">{unit}</span>
    </>
  );
}
