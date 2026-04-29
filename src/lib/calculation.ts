/**
 * PURE calculation — shared between client (live) and server (exports).
 *
 * Flow:
 *   1. Each building has its own kengetal set (bouwsysteem), modules, and manual inputs.
 *   2. Module-derived labels (Module oppervlak, Aantal modules, …) override manual inputs
 *      when modules exist.
 *   3. Material costs roll up per cost group (bouwpakket / installateur / assemblagehal / derden).
 *   4. Project transport splits between bouwpakket and assemblagehal groups.
 *   5. Markup rows per group apply on top of each group's direct cost.
 *   6. Project-level markup rows (hoofdaannemer staart) apply after everything.
 */

import type {
  Material, KengetalRow, KengetalLabour, Building, BuildingInput, Override,
  ProjectTransport, VehicleType, Project, Module, MarkupRow, LabourRates,
  MaterialCalcRow, MaterialContribution, BuildingCalcResult, CategoryLabourEntry, MarkupCalcRow, ProjectCalcResult,
  CostGroup, GroupTotals, KengetalSet,
} from "@/types";
import { MODULE_DERIVED_LABELS } from "@/types";

/** DeJong-leercurve-parameters per bouwsysteem. */
export interface EfficiencyParams {
  vatHuidig: number;
  vatMax: number;
  lr: number;
  nRef: number;
}

export const DEFAULT_EFFICIENCY: EfficiencyParams = {
  vatHuidig: 0.45, vatMax: 0.75, lr: 0.88, nRef: 10,
};

/**
 * Bereken de gewogen correctiefactor voor arbeidsuren volgens het DeJong-model:
 *   T(n) = T∞ + (T₁ − T∞) × n^b
 *   b    = log(LR) / log(2)
 *   T∞   = T_ref × (VAT_huidig / VAT_max)
 *   T₁   = (T_ref − T∞) / n_ref^b + T∞
 *
 * Elke unieke modulemaat krijgt zijn eigen curve, beginnend bij n = 1.
 * Per modulemaat m met count N_m:
 *   C_m = (1 / (N_m × T_ref)) × Σ[n=1..N_m] T(n)
 *       = (1/N_m) × Σ[n=1..N_m] T(n)/T_ref
 * Omdat dit gedeeld is door T_ref is de factor onafhankelijk van T_ref zelf;
 * we wegen modulematen gelijk op basis van hun aantal modules.
 */
export function computeLearningFactor(
  modules: { lengthM: number; widthM: number; heightM: number; count: number }[],
  p: EfficiencyParams,
): { factor: number; perSize: { key: string; count: number; c: number; t1Ratio: number; tInfRatio: number; tNRatio: number }[] } {
  if (p.lr >= 1) return { factor: 1, perSize: [] };
  if (p.vatHuidig >= p.vatMax) return { factor: 1, perSize: [] };
  const b = Math.log(p.lr) / Math.log(2);
  const tInfRatio = p.vatHuidig / p.vatMax;         // T∞ / T_ref
  const t1Ratio = (1 - tInfRatio) / Math.pow(p.nRef, b) + tInfRatio;  // T₁ / T_ref
  const tRatio = (n: number) => tInfRatio + (t1Ratio - tInfRatio) * Math.pow(n, b);

  const bySize = new Map<string, number>();
  for (const m of modules) {
    if (m.count <= 0) continue;
    const key = `${m.lengthM.toFixed(3)}×${m.widthM.toFixed(3)}×${m.heightM.toFixed(3)}`;
    bySize.set(key, (bySize.get(key) ?? 0) + m.count);
  }
  if (bySize.size === 0) return { factor: 1, perSize: [] };

  let numerator = 0;
  let denominator = 0;
  const perSize: { key: string; count: number; c: number; t1Ratio: number; tInfRatio: number; tNRatio: number }[] = [];
  for (const [key, N] of bySize) {
    let sum = 0;
    for (let n = 1; n <= N; n++) sum += tRatio(n);
    const cM = sum / N;
    perSize.push({ key, count: N, c: cM, t1Ratio, tInfRatio, tNRatio: tRatio(N) });
    numerator += cM * N;
    denominator += N;
  }
  return { factor: denominator > 0 ? numerator / denominator : 1, perSize };
}

/**
 * Sustainer engineering-fee per m² BVO. Loopt op met complexiteit:
 *   herhaling = N_totaal / N_unieke_maten (gemiddeld aantal modules per maat)
 *   complexiteit = 1 − clamp(log(herhaling) / log(100), 0, 1)  ∈ [0, 1]
 *   engineering fee = €50 + €50 × complexiteit   (€50 … €100)
 *   constructie fee = €12,50 + €12,50 × complexiteit + (verdiepingen − 1) × €2
 *
 * Ankers (hoe dicht komt de formule op de door Sol gekozen waarden uit):
 *   100 modules, 1 maat  → rep=100 → complexiteit=0   → eng €50    · con €12,50 · ✓
 *    50 modules, 10 maten → rep=5  → complexiteit=0,65 → eng ≈ €83 · con ≈ €20,6 · (ankers: €75 / €18,75)
 *     1 module             → rep=1  → complexiteit=1   → eng €100   · con €25    · ✓
 */
export interface EngineeringResult {
  totalModules: number;
  uniqueSizes: number;
  repetition: number;
  complexity: number;
  floors: number;
  bvo: number;
  engineeringPerM2: number;
  constructieBasePerM2: number;
  constructieFloorsPerM2: number;
  constructiePerM2: number;
  engineeringTotal: number;
  constructieTotal: number;
  grandTotal: number;
}

export function computeEngineering(
  modules: { lengthM: number; widthM: number; heightM: number; count: number }[],
  bvo: number,
  floors: number,
): EngineeringResult {
  const totalModules = modules.reduce((s, m) => s + (m.count > 0 ? m.count : 0), 0);
  const sizeSet = new Set<string>();
  for (const m of modules) {
    if (m.count <= 0) continue;
    sizeSet.add(`${m.lengthM.toFixed(3)}×${m.widthM.toFixed(3)}×${m.heightM.toFixed(3)}`);
  }
  const uniqueSizes = sizeSet.size;
  const empty: EngineeringResult = {
    totalModules, uniqueSizes, repetition: 0, complexity: 0, floors, bvo,
    engineeringPerM2: 0, constructieBasePerM2: 0, constructieFloorsPerM2: 0, constructiePerM2: 0,
    engineeringTotal: 0, constructieTotal: 0, grandTotal: 0,
  };
  if (totalModules === 0 || uniqueSizes === 0 || bvo <= 0) return empty;

  const repetition = totalModules / uniqueSizes;
  const logNorm = Math.log(Math.max(repetition, 1)) / Math.log(100);
  const complexity = Math.max(0, Math.min(1, 1 - logNorm));

  const engineeringPerM2 = 50 + 50 * complexity;
  const constructieBasePerM2 = 12.5 + 12.5 * complexity;
  const constructieFloorsPerM2 = Math.max(0, floors - 1) * 2;
  const constructiePerM2 = constructieBasePerM2 + constructieFloorsPerM2;

  const engineeringTotal = engineeringPerM2 * bvo;
  const constructieTotal = constructiePerM2 * bvo;
  return {
    totalModules, uniqueSizes, repetition, complexity, floors, bvo,
    engineeringPerM2, constructieBasePerM2, constructieFloorsPerM2, constructiePerM2,
    engineeringTotal, constructieTotal, grandTotal: engineeringTotal + constructieTotal,
  };
}

/**
 * Kolomcorrectie — welke kolommen in LVL, welke in Baubuche, bij welke dikte.
 *
 * Aannames (fixed in code):
 * - Basis: 145×145 mm, hoogte 3,155 m, LVL.
 * - Baubuche ≈ 2× druksterkte van LVL (wissel bij hoge gebouwen).
 * - Doorsnede-stappen: 145 → 160 → 200 → 240 → 280 mm.
 * - 4 kolommen per module (hoekkolommen gedeeld, maar benadering: totaal = 4 × modules_per_laag).
 * - Gevelkolommen: gegeven; binnen = totaal − gevel.
 *
 * Materiaal per verdieping V:
 *   1–3: alles LVL 145
 *   4: onderste V−2 lagen gevel Baubuche, rest LVL; binnen LVL
 *   5: onderste V−2 lagen gevel Baubuche, rest LVL; binnen Baubuche
 *   6+: gevel + binnen alles Baubuche, dikte varieert per laag
 *
 * Verdikkingsregel (alleen V ≥ 6) op basis van het aantal lagen erboven L_boven:
 *   L_boven ≤ 1 → 145  ·  2–3 → 160  ·  4–5 → 200  ·  6–7 → 240  ·  ≥ 8 → 280
 */
export interface KolomCorrectieLaag {
  index: number;         // 1 = BG
  lagenBoven: number;    // V − index
  doorsnedeMm: number;   // 145, 160, 200, 240 of 280
  gevelMateriaal: "LVL" | "BAUB";
  binnenMateriaal: "LVL" | "BAUB";
  gevelCount: number;
  binnenCount: number;
  lvlCount: number;
  baubCount: number;
  volumePerKolomM3: number;
  lengtePerKolomM1: number;
}

export interface KolomCorrectieResult {
  verdiepingen: number;
  modulesPerLaag: number;
  totaalKolommenPerLaag: number;
  gevelkolommenPerLaag: number;
  binnenkolommenPerLaag: number;
  lagen: KolomCorrectieLaag[];
  lvlVolumeM3: number;
  baubucheVolumeM3: number;
  lvlMeterM1: number;
  baubucheMeterM1: number;
}

const KOLOM_HOOGTE_M = 3.155;

function kolomDoorsnede(lagenBoven: number): number {
  if (lagenBoven <= 1) return 145;
  if (lagenBoven <= 3) return 160;
  if (lagenBoven <= 5) return 200;
  if (lagenBoven <= 7) return 240;
  return 280;
}

export function computeKolomCorrectie(
  totalModules: number,
  verdiepingen: number,
  gevelkolommenPerLaag: number,
): KolomCorrectieResult {
  const V = Math.max(1, Math.round(verdiepingen));
  const modulesPerLaag = Math.ceil(Math.max(0, totalModules) / V);
  const totaalKolommenPerLaag = modulesPerLaag * 4;
  const G = Math.max(0, Math.min(gevelkolommenPerLaag, totaalKolommenPerLaag));
  const B = Math.max(0, totaalKolommenPerLaag - G);

  const lagen: KolomCorrectieLaag[] = [];
  let lvlVolumeM3 = 0, baubucheVolumeM3 = 0;
  let lvlMeterM1 = 0, baubucheMeterM1 = 0;

  for (let i = 1; i <= V; i++) {
    const lagenBoven = V - i;
    // Bovenste 2 lagen = layers met lagenBoven ≤ 1. Die zijn altijd LVL 145 mm,
    // dragen nauwelijks belasting en worden nooit Baubuche/verdikt.
    const isTopTwo = lagenBoven <= 1;
    const doorsnedeMm = isTopTwo ? 145 : (V >= 6 ? kolomDoorsnede(lagenBoven) : 145);
    // Materiaal per laag/positie — top-2 override gaat voor.
    let gevelMat: "LVL" | "BAUB" = "LVL";
    let binnenMat: "LVL" | "BAUB" = "LVL";
    if (isTopTwo) {
      gevelMat = "LVL"; binnenMat = "LVL";
    } else if (V <= 3) {
      gevelMat = "LVL"; binnenMat = "LVL";
    } else if (V === 4) {
      gevelMat = "BAUB"; binnenMat = "LVL";
    } else if (V === 5) {
      gevelMat = "BAUB"; binnenMat = "BAUB";
    } else {
      gevelMat = "BAUB"; binnenMat = "BAUB";
    }
    const volumePerKolomM3 = (doorsnedeMm / 1000) * (doorsnedeMm / 1000) * KOLOM_HOOGTE_M;
    const lengtePerKolomM1 = KOLOM_HOOGTE_M;
    const lvlCount = (gevelMat === "LVL" ? G : 0) + (binnenMat === "LVL" ? B : 0);
    const baubCount = (gevelMat === "BAUB" ? G : 0) + (binnenMat === "BAUB" ? B : 0);
    lvlVolumeM3      += volumePerKolomM3 * lvlCount;
    baubucheVolumeM3 += volumePerKolomM3 * baubCount;
    lvlMeterM1       += lengtePerKolomM1 * lvlCount;
    baubucheMeterM1  += lengtePerKolomM1 * baubCount;
    lagen.push({
      index: i, lagenBoven, doorsnedeMm, gevelMateriaal: gevelMat, binnenMateriaal: binnenMat,
      gevelCount: G, binnenCount: B, lvlCount, baubCount,
      volumePerKolomM3, lengtePerKolomM1,
    });
  }

  return {
    verdiepingen: V, modulesPerLaag, totaalKolommenPerLaag,
    gevelkolommenPerLaag: G, binnenkolommenPerLaag: B,
    lagen, lvlVolumeM3, baubucheVolumeM3, lvlMeterM1, baubucheMeterM1,
  };
}

/**
 * Parseer + aggregeer een stuklijst-CSV per (csv_code, unit).
 * Verwacht semicolon-separated met deze kolommen (header vereist):
 *   materialId, countUnit, count, length (mm), width (mm), volume (m³)
 * Onbekende of lege regels worden overgeslagen.
 */
export interface CsvAggregate {
  csvCode: string;
  unit: string;
  totalCount: number;
  totalVolumeM3: number;
  totalLengthM1: number;
  totalAreaM2: number;
}

export function parseAndAggregateCsv(text: string): CsvAggregate[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const iCode = idx("materialId");
  const iUnit = idx("countUnit");
  const iCount = idx("count");
  const iLength = idx("length");
  const iWidth = idx("width");
  const iVolume = idx("volume");
  if (iCode < 0 || iUnit < 0 || iCount < 0) return [];

  const agg = new Map<string, CsvAggregate>();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const code = (parts[iCode] ?? "").trim();
    const unit = (parts[iUnit] ?? "").trim();
    if (!code || !unit) continue;
    const count = parseFloat(parts[iCount] ?? "0") || 0;
    const lengthMm = iLength >= 0 ? parseFloat(parts[iLength] ?? "0") || 0 : 0;
    const widthMm  = iWidth  >= 0 ? parseFloat(parts[iWidth]  ?? "0") || 0 : 0;
    const volumeM3 = iVolume >= 0 ? parseFloat(parts[iVolume] ?? "0") || 0 : 0;

    const key = `${code}|${unit}`;
    const ex = agg.get(key) ?? { csvCode: code, unit, totalCount: 0, totalVolumeM3: 0, totalLengthM1: 0, totalAreaM2: 0 };
    ex.totalCount += count;
    ex.totalVolumeM3 += count * volumeM3;
    if (unit.toUpperCase() === "M1") ex.totalLengthM1 += count * (lengthMm / 1000);
    if (unit.toUpperCase() === "M2") ex.totalAreaM2 += count * (lengthMm * widthMm / 1_000_000);
    agg.set(key, ex);
  }
  return Array.from(agg.values());
}

/**
 * Lever de CSV-netto-hoeveelheid voor een materiaal, afhankelijk van de materiaal-unit.
 * m³ → totalVolumeM3, m¹ → totalLengthM1, m² → totalAreaM2, stuks → totalCount.
 */
export function csvQtyForMaterial(agg: CsvAggregate, materialUnit: string): number {
  const u = (materialUnit ?? "").toLowerCase().replace("³", "3").replace("²", "2").replace("¹", "1");
  if (u === "m3") return agg.totalVolumeM3;
  if (u === "m1") return agg.totalLengthM1 || (agg.unit.toUpperCase() === "M1" ? agg.totalCount : 0);
  if (u === "m2") return agg.totalAreaM2 || (agg.unit.toUpperCase() === "M2" ? agg.totalCount : 0);
  return agg.totalCount;
}

/** Voorgestelde code-mapping tussen CSV en app-materialen. Lege mapping = user kiest. */
export const CSV_CODE_MAP: Record<string, string> = {
  LVLQ: "LVLQ", LVLS: "LVLS", SPANO: "SPANO",
  FERM: "FERM18",          // CSV maakt geen onderscheid FERM10/18 → default 18
  CEM: "CEMVIN",           // cempanel
  GIPF: "GIPSF",           // gips F brandwerend
  STEW: "STEENW",          // steenwol
  GLAW: "GLASW",           // glaswol
  PIR: "PIR",              // PIR-platen
  AIRS: "TAPE",            // luchtdichting
  EPDM: "EPDM", EPDMS: "EPDM",
  LDPE: "PEF", HDPE: "PEF",// polyetheen folie
  DAMPF: "FACF", DMPFA2: "FACF",
  WFB: "BAUB",             // wood fibre board → Baubuche
  SPLIT: "BALLAST",        // grind/split als ballast
  PRO: "PROMAT",
};

/**
 * S2P (prefab badkamer) replacement scope:
 *   - Voor de input-labels in `S2P_REPLACED_LABELS` worden zowel kengetal-rijen
 *     als kengetal_labour-rijen volledig overgeslagen (kosten + arbeid).
 *   - Voor het label "Aantal appartementen" worden specifiek de SANT/WATL-rijen
 *     overgeslagen — andere kengetallen op dat label (b.v. fundering) blijven
 *     ongemoeid.
 *   - In ruil daarvoor komen 4 stelpost-rijen uit `S2PT/S2PBK_S/S2PBK_M/S2PBK_L`.
 */
export const S2P_REPLACED_LABELS = new Set([
  "Badkamers klein",
  "Badkamers midden",
  "Badkamers groot",
  "Los toilet",
]);
const S2P_APPS_REPLACED_CODES = new Set(["SANT", "WATL"]);

function shouldSkipForS2P(inputLabel: string, materialCode: string | undefined): boolean {
  if (S2P_REPLACED_LABELS.has(inputLabel)) return true;
  if (inputLabel === "Aantal appartementen" && materialCode && S2P_APPS_REPLACED_CODES.has(materialCode)) return true;
  return false;
}

/**
 * Planning & projectmanagement-uren. Eén formule, niet user-instelbaar — alleen het
 * uurtarief (`projectmgmtHourlyRate`) blijft aanpasbaar via de Arbeid-pagina.
 *
 *   uren = 200 × n^0,434                       (basis-fit door 1→200u en 1000→4000u)
 *        + 50 × max(0, distinctTypes − 1)      (penalty per extra moduletype na de eerste)
 *
 * Anchor-punten (basis-deel):
 *   1 module     → 200 u
 *   10 modules   → ~543 u   (Sol: ~400)
 *   100 modules  → ~1.480 u (Sol: ~800)
 *   1000 modules → 4.000 u
 * Mid-range overschat licht; Sol gaf "niet heel precies" als richtlijn en koos
 * een gladde één-term formule die de eindpunten exact raakt.
 */
export function computeProjectMgmtHours(totalModules: number, distinctModuleTypes: number): {
  baseHours: number; typePenaltyHours: number; totalHours: number; exponent: number;
} {
  const exponent = 0.434;
  if (totalModules <= 0) return { baseHours: 0, typePenaltyHours: 0, totalHours: 0, exponent };
  const baseHours = 200 * Math.pow(totalModules, exponent);
  const typePenaltyHours = Math.max(0, distinctModuleTypes - 1) * 50;
  return { baseHours, typePenaltyHours, totalHours: baseHours + typePenaltyHours, exponent };
}

/** Default tarieven als de DB-rij ontbreekt. Spiegel van seed-defaults. */
export const DEFAULT_LABOUR_RATES: Omit<LabourRates, "id" | "orgId"> = {
  gezaagdPerM3: 100,
  cncSimpelPerM3: 200,
  cncComplexPerM3: 400,
  steenachtigPerM3: 400,
  assemblageHourlyRate: 48,
  installatieHourlyRate: 65,
  arbeidBuitenHourlyRate: 66,
  arbeidBuitenHoursPerModule: 0,
  arbeidBuitenHoursBase: 0,
  projectmgmtHourlyRate: 85,
  projectmgmtHoursPerModule: 2,
  projectmgmtHoursBase: 200,
};

function sum<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((acc, item) => acc + fn(item), 0);
}

/**
 * BVO (Bruto Vloer Oppervlak) per gebouw — één enkele bron van waarheid voor
 * álle prijs-per-m² berekeningen en voor de per_m2 markups. De formule verschilt
 * per bouwsysteem:
 *
 *   .home  = module_opp + gevel_m¹ × 0,145 + Σ(alle WSW) × 0,032
 *            (géén onderscheid tussen WSW-types)
 *   .optop = module_opp + gevel_m¹ × 0,333 + WSW_korte × 0,218 + WSW_lange × 0,032
 *
 * Composite `_`-labels (b.v. `_gevel_m1`) hebben voorrang boven de
 * canonical labels — ze worden door structured-inputs.tsx gezet en bevatten de
 * oorspronkelijke gebruikersinvoer, niet de afgeleide splitsing.
 */
export function computeBvo(
  effectiveInputs: Record<string, number>,
  kengetalSetName: string | null | undefined,
): number {
  const area = effectiveInputs["Module oppervlak"] ?? 0;
  const gevelM1 = effectiveInputs["_gevel_m1"] ?? 0;
  if (kengetalSetName === ".home") {
    const wswHome = effectiveInputs["WSW"] ?? 0;
    const verzwaardeWsw = effectiveInputs["Verzwaarde WSW"] ?? 0;
    const extraVerzwaardeWsw = effectiveInputs["Extra verzwaarde WSW"] ?? 0;
    const totalWsw = wswHome + verzwaardeWsw + extraVerzwaardeWsw;
    return area + gevelM1 * 0.145 + totalWsw * 0.032;
  }
  const wswKorte = effectiveInputs["_wsw_korte_m1"] ?? effectiveInputs["WSW korte zijde"] ?? 0;
  const wswLange = effectiveInputs["_wsw_lange_m1"] ?? effectiveInputs["WSW lange zijde"] ?? 0;
  return area + gevelM1 * 0.333 + wswKorte * 0.218 + wswLange * 0.032;
}

export function deriveInputsFromModules(mods: Module[], oppBGG: number = 0): Record<string, number> {
  if (mods.length === 0) return {};
  const area = sum(mods, (m) => m.lengthM * m.widthM * m.count);
  const cnt = sum(mods, (m) => m.count);
  const wTot = sum(mods, (m) => m.widthM * m.count);
  const lTot = sum(mods, (m) => m.lengthM * m.count);
  const hTot = sum(mods, (m) => m.heightM * m.count);
  // Opp-splits op basis van BGG:
  //   Vloer BG       = oppBGG (1 verdieping footprint)
  //   Vloer Overig   = total − BG (vloeren boven BG)
  //   Plafond        = total (iedere verdieping heeft plafond)
  //   Dak            = oppBGG (dak = bovenkant van BG-footprint)
  const bgg = Math.max(0, oppBGG);
  const vloerBG = bgg;
  const vloerOverig = bgg > 0 ? Math.max(0, area - bgg) : 0;
  const dak = bgg;
  // Plafond = totale module-oppervlak MIN het dak (dak telt als buitenschil, niet plafond).
  const plafond = Math.max(0, area - dak);

  // Splits van modulesAantal over BG / dak / tussenvd op basis van het aantal
  // bouwlagen (area / bgg). Als de ratio heel dicht bij een heel getal ligt
  // (±0,1) ronden we af, zodat kleine afrondings-residuen (bijv. 1,993 vd)
  // niet als spookmodules op tussenvd verschijnen.
  const FLOOR_ROUND_TOLERANCE = 0.1;
  const rawFloors = area > 0 && bgg > 0 ? area / bgg : 1;
  const nearestFloor = Math.round(rawFloors);
  const floors = Math.abs(rawFloors - nearestFloor) < FLOOR_ROUND_TOLERANCE && nearestFloor > 0
    ? nearestFloor
    : rawFloors;
  const floorRatio = floors > 0 ? Math.min(1, 1 / floors) : 1;
  const cntBG  = cnt * floorRatio;
  const cntDak = cnt * floorRatio;
  const cntTussen = Math.max(0, cnt - cntBG - cntDak);

  return {
    [MODULE_DERIVED_LABELS.AREA]: area,
    [MODULE_DERIVED_LABELS.COUNT]: cnt,
    [MODULE_DERIVED_LABELS.COUNT_BG]: cntBG,
    [MODULE_DERIVED_LABELS.COUNT_DAK]: cntDak,
    [MODULE_DERIVED_LABELS.COUNT_TUSSEN]: cntTussen,
    [MODULE_DERIVED_LABELS.WIDTH_TOTAL]: wTot,
    [MODULE_DERIVED_LABELS.LENGTH_TOTAL]: lTot,
    [MODULE_DERIVED_LABELS.HEIGHT_TOTAL]: hTot,
    "Module Opp Vloer BG": vloerBG,
    "Module Opp Vloer Overig": vloerOverig,
    "Module Opp Plafond": plafond,
    "Module Opp Dak": dak,
    "Dakoppervlak": dak,
  };
}

export interface CsvOverrideEntry {
  materialId: string;
  csvCode: string;
  csvUnit: string;
  useCsv: boolean;
}

export function calculateBuilding(
  building: Building,
  inputs: BuildingInput[],
  mods: Module[],
  kengetallen: KengetalRow[],
  labourRows: KengetalLabour[],
  materialsMap: Map<string, Material>,
  buildingOverrides: Override[],
  rates: Omit<LabourRates, "id" | "orgId">,
  efficiency: EfficiencyParams = DEFAULT_EFFICIENCY,
  csvAggregates: CsvAggregate[] = [],
  csvOverrides: CsvOverrideEntry[] = [],
): BuildingCalcResult {
  const learning = computeLearningFactor(mods, efficiency);
  const learnFactor = learning.factor;
  // Opp begane grond zit opgeslagen als composite input `_opp_begane_grond`.
  const oppBGG = inputs.find((i) => i.inputLabel === "_opp_begane_grond")?.quantity ?? 0;
  const derivedInputs = deriveInputsFromModules(mods, oppBGG);

  // Effective inputs: derived values override manual for derived labels.
  const effectiveInputs: Record<string, number> = {};
  for (const inp of inputs) effectiveInputs[inp.inputLabel] = inp.quantity;
  for (const [label, qty] of Object.entries(derivedInputs)) effectiveInputs[label] = qty;

  // Gevel-derivatie — wanneer composite `_gevel_m1` aanwezig is, herberekenen we
  // "Dichte gevel" / "Open gevel" hier zodat ze altijd consistent zijn met
  // _gevel_m1, _pct_glas, modules en Dakomtrek (de UI doet dit live in
  // structured-inputs.tsx). Dit voorkomt stale canonical values als modules of
  // de dakomtrek wijzigen zonder dat de gevelvelden opnieuw worden bewerkt.
  // "Aantal kozijnen" wordt alleen overschreven als de composite expliciet bestaat.
  if (effectiveInputs["_gevel_m1"] != null) {
    const DAKRAND_HOOGTE_M = 0.5;
    const KOZIJN_OPP_PER_STUK = 1.8;
    const DEFAULT_VERDIEPINGSHOOGTE = 3.155;
    const gevelM1 = effectiveInputs["_gevel_m1"] ?? 0;
    const pctGlas = effectiveInputs["_pct_glas"] ?? 0;
    let totalCount = 0;
    let weightedHoogte = 0;
    for (const m of mods) {
      totalCount += m.count;
      weightedHoogte += m.heightM * m.count;
    }
    const avgHoogte = totalCount > 0 ? weightedHoogte / totalCount : DEFAULT_VERDIEPINGSHOOGTE;
    const dakomtrek = effectiveInputs["Dakomtrek"] ?? 0;
    const voordeurInKozijn = effectiveInputs["_voordeur_in_kozijn"] != null
      ? effectiveInputs["_voordeur_in_kozijn"] > 0
      : true;
    const aantalVoordeuren = effectiveInputs["Aantal appartementen"] ?? 0;
    const voordeurExtraOpp = voordeurInKozijn ? 0 : aantalVoordeuren * KOZIJN_OPP_PER_STUK;
    const gevelOpp = gevelM1 * avgHoogte + dakomtrek * DAKRAND_HOOGTE_M;
    const openGevel = gevelOpp * (pctGlas / 100) + voordeurExtraOpp;
    const dichteGevel = Math.max(0, gevelOpp - openGevel);
    effectiveInputs["Dichte gevel"] = dichteGevel;
    effectiveInputs["Open gevel"] = openGevel;
    if (effectiveInputs["_aantal_kozijnen"] != null) {
      effectiveInputs["Aantal kozijnen"] = effectiveInputs["_aantal_kozijnen"];
    }
  }

  // WSW-derivatie (.optop) — composite `_wsw_korte_m1`/`_wsw_lange_m1` zijn de
  // bron van waarheid voor de canonical labels "WSW korte zijde"/"WSW lange
  // zijde". Voorkomt stale canonical-data uit oudere UI-versies waar alleen de
  // composite werd weggeschreven (waardoor WSW-arbeid en kengetal-materialen
  // niet meer mee werden gerekend).
  if (effectiveInputs["_wsw_korte_m1"] != null) {
    effectiveInputs["WSW korte zijde"] = effectiveInputs["_wsw_korte_m1"];
  }
  if (effectiveInputs["_wsw_lange_m1"] != null) {
    effectiveInputs["WSW lange zijde"] = effectiveInputs["_wsw_lange_m1"];
  }

  // S2P (prefab badkamer) — als het vinkje op het gebouw aan staat vervangt het
  // de kengetal-bijdragen voor sanitair/waterleiding (op "Aantal appartementen")
  // en de badkamers/los toilet (kengetallen + arbeid). Stelposten worden onderaan
  // synthetisch toegevoegd.
  const s2pActive = (inputs.find((i) => i.inputLabel === "_s2p")?.quantity ?? 0) > 0;

  // Apply kengetallen → per-material netto quantities. Arbeid komt NIET meer uit de
  // material-row of de kengetal-row, maar uit aparte `kengetal_labour` rijen
  // (één getal per invoercategorie). We bewaren ook de per-invoer-bijdrage zodat
  // de begroting-UI een materiaal kan uitklappen tot zijn herkomst.
  const materialQuantities = new Map<string, { netto: number; contributions: MaterialContribution[] }>();
  for (const [label, qty] of Object.entries(effectiveInputs)) {
    const matching = kengetallen.filter((k) => k.inputLabel === label);
    for (const kg of matching) {
      if (s2pActive && shouldSkipForS2P(label, materialsMap.get(kg.materialId)?.code)) continue;
      const netto = qty * kg.ratio;
      if (netto === 0) continue;
      const existing = materialQuantities.get(kg.materialId);
      if (existing) {
        existing.netto += netto;
        existing.contributions.push({ inputLabel: label, ratio: kg.ratio, inputQty: qty, netto });
      } else {
        materialQuantities.set(kg.materialId, {
          netto,
          contributions: [{ inputLabel: label, ratio: kg.ratio, inputQty: qty, netto }],
        });
      }
    }
  }

  // Kramerijen = totaal bouwpakket-m³ uit deze categorie. Alleen items in m³ tellen
  // mee (niet m², niet m1) — I-joists en folies horen er dus niet bij. Automatisch
  // afgeleid; geen gebruikersveld meer.
  const kramMaterial = Array.from(materialsMap.values()).find((m) => m.code === "KRAM");
  if (kramMaterial) {
    const bouwpakketM3ByLabel = new Map<string, number>();
    for (const kg of kengetallen) {
      const mat = materialsMap.get(kg.materialId);
      if (!mat || mat.costGroup !== "bouwpakket") continue;
      const u = mat.unit.toLowerCase();
      if (u !== "m³" && u !== "m3") continue;
      bouwpakketM3ByLabel.set(kg.inputLabel, (bouwpakketM3ByLabel.get(kg.inputLabel) ?? 0) + kg.ratio);
    }
    for (const [label, ratio] of bouwpakketM3ByLabel) {
      const qty = effectiveInputs[label] ?? 0;
      if (qty <= 0 || ratio <= 0) continue;
      const addedM3 = qty * ratio;
      const contrib: MaterialContribution = { inputLabel: label, ratio, inputQty: qty, netto: addedM3 };
      const existing = materialQuantities.get(kramMaterial.id);
      if (existing) {
        existing.netto += addedM3;
        existing.contributions.push(contrib);
      } else {
        materialQuantities.set(kramMaterial.id, { netto: addedM3, contributions: [contrib] });
      }
    }
  }

  // Steenachtig-bewerking wordt niet als materiaal bijgehouden; de m³ loopt via
  // kengetal_labour.steenachtig_m3_per_input × labour_rates.steenachtig_per_m3.
  // De steenachtig_m3_per_input wordt auto-afgeleid in seed/scripts (FERM18 +
  // FERM10 + CEMVIN in kengetal_rows).

  // Kolomcorrectie wordt als losse synthetische rijen toegevoegd ná de gewone
  // materiaal-rij-loop (zie onder). Zo blijft LVLQ "schoon" uit de kengetallen
  // en is de correctie apart zichtbaar in de begroting.

  // CSV-override — per materiaal: vervang netto door de CSV-waarde als useCsv true is.
  // CSV levert netto m³/m¹/m²/stuks; verliespercentage van het materiaal zorgt nog voor bruto.
  if (csvOverrides.length > 0 && csvAggregates.length > 0) {
    const aggByKey = new Map<string, CsvAggregate>();
    for (const a of csvAggregates) aggByKey.set(`${a.csvCode}|${a.unit}`, a);
    for (const o of csvOverrides) {
      if (!o.useCsv) continue;
      const mat = materialsMap.get(o.materialId);
      const agg = aggByKey.get(`${o.csvCode}|${o.csvUnit}`);
      if (!mat || !agg) continue;
      const qty = csvQtyForMaterial(agg, mat.unit);
      if (qty > 0) materialQuantities.set(o.materialId, { netto: qty, contributions: [{ inputLabel: "CSV-import", ratio: 1, inputQty: qty, netto: qty }] });
    }
  }

  const rows: MaterialCalcRow[] = [];
  for (const [materialId, { netto, contributions }] of materialQuantities) {
    const material = materialsMap.get(materialId);
    if (!material) continue;

    const override = buildingOverrides.find((o) => o.materialId === materialId);
    const effectiveNetto = override?.quantity ?? netto;
    let effectiveLoss = override?.lossPct ?? material.lossPct;
    let effectivePrice = override?.pricePerUnit ?? material.pricePerUnit;
    let displayMaterial = material;

    // Gevelafwerking-variant: _gevel_afwerking (1=Budget, 2=Midden, 3=Duur) mapt op
    // GEVBUD/GEVMID/GEVDUR-materialen. We houden GEVA als generieke kengetal-rij
    // maar pakken prijs + loss van de geselecteerde variant en tonen de keuze in de
    // naam. User-overrides op GEVA zelf hebben voorrang.
    if (material.code === "GEVA") {
      const variant = Math.round(effectiveInputs["_gevel_afwerking"] ?? 2);
      const targetCode = variant === 1 ? "GEVBUD" : variant === 3 ? "GEVDUR" : "GEVMID";
      const label = variant === 1 ? "Budget" : variant === 3 ? "Duur" : "Midden";
      const targetMat = Array.from(materialsMap.values()).find((m) => m.code === targetCode);
      if (targetMat) {
        if (override?.pricePerUnit == null) effectivePrice = targetMat.pricePerUnit;
        if (override?.lossPct == null) effectiveLoss = targetMat.lossPct;
      }
      displayMaterial = {
        ...material,
        name: `${material.name} ${label}`,
        description: material.description ?? "Gevelbekleding (stelpost)",
      };
    }

    const bruto = effectiveNetto * (1 + effectiveLoss);
    const materialCost = bruto * effectivePrice;
    const laborHrs = 0; // labour zit niet meer op materiaal-rij
    const laborCost = 0;

    rows.push({
      material: displayMaterial, netto: effectiveNetto,
      nettoBron: override?.quantity != null ? override.source : "kengetal",
      loss: effectiveLoss,
      lossBron: override?.lossPct != null ? override.source : "default",
      bruto, price: effectivePrice,
      priceBron: override?.pricePerUnit != null ? override.source : "default",
      materialCost, laborHours: laborHrs,
      laborHoursBron: "default",
      laborCost,
      contributions: (contributions ?? []).map((c) => ({ ...c, buildingName: building.name })),
    });
  }

  // Kolomcorrectie als synthetische rijen in de bouwpakket-groep. Category
  // "__Kolomcorrectie" zodat de begroting-view ze als aparte regel kan tonen.
  {
    const totalModulesForKol = mods.reduce((s, m) => s + m.count, 0);
    const bggVal = effectiveInputs["_opp_begane_grond"] ?? 0;
    const areaVal = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
    const floorsRaw = areaVal > 0 && bggVal > 0 ? areaVal / bggVal : 1;
    const floorsForKol = Math.max(1, Math.round(floorsRaw));
    const modulesPerLaagForKol = Math.ceil(totalModulesForKol / floorsForKol);
    const gevelInput = effectiveInputs["Aantal gevelkolommen per laag"];
    const gevelkolommenPerLaag = gevelInput != null && gevelInput > 0 ? gevelInput : modulesPerLaagForKol * 4;

    if (totalModulesForKol > 0) {
      const kc = computeKolomCorrectie(totalModulesForKol, floorsForKol, gevelkolommenPerLaag);
      const baselineLvlM3 = totalModulesForKol * 4 * 0.145 * 0.145 * 3.155;
      const deltaLvl = kc.lvlVolumeM3 - baselineLvlM3;
      const deltaBaub = kc.baubucheVolumeM3;
      const lvlqMat = Array.from(materialsMap.values()).find((m) => m.code === "LVLQ");
      const baubMat = Array.from(materialsMap.values()).find((m) => m.code === "BAUB");

      const pushSyntheticCorrection = (mat: Material | undefined, deltaNetto: number, label: string) => {
        if (!mat || deltaNetto === 0) return;
        const bruto = deltaNetto * (1 + mat.lossPct);
        const cost = bruto * mat.pricePerUnit;
        const displayMat: Material = { ...mat, name: label, category: "Kolomcorrectie" };
        rows.push({
          material: displayMat,
          netto: deltaNetto,
          nettoBron: "kengetal",
          loss: mat.lossPct,
          lossBron: "default",
          bruto,
          price: mat.pricePerUnit,
          priceBron: "default",
          materialCost: cost,
          laborHours: 0,
          laborHoursBron: "default",
          laborCost: 0,
        });
      };
      pushSyntheticCorrection(lvlqMat, deltaLvl, `Kolomcorrectie LVL (Δ t.o.v. 4 × modules × 145² × 3,155)`);
      pushSyntheticCorrection(baubMat, deltaBaub, `Kolomcorrectie Baubuche (hoge gebouwen / Baubuche-lagen)`);
    }
  }

  // Categorie-arbeid + bouwpakket-bewerking per kengetal_labour-rij.
  //   - Assemblagearbeid (uren)   → arbeid-groep,      € = uren × assemblage€/hr
  //   - Installatiearbeid (uren)  → installateur-groep, € = uren × installatie€/hr
  //   - Gezaagd / CNC (m³)        → bouwpakket-groep,  € = m³ × €/m³-tarief
  const labourEntries: CategoryLabourEntry[] = [];
  for (const lr of labourRows) {
    if (s2pActive && S2P_REPLACED_LABELS.has(lr.inputLabel)) continue;
    const qty = effectiveInputs[lr.inputLabel] ?? 0;
    if (qty <= 0) continue;

    const hourly = lr.hoursPerInput ?? 0;
    if (hourly > 0) {
      const hours = qty * hourly * learnFactor;
      labourEntries.push({
        inputLabel: lr.inputLabel,
        costGroup: "assemblagehal",
        hoursPerInput: hourly,
        inputQty: qty,
        totalHours: hours,
        cost: hours * rates.assemblageHourlyRate,
      });
    }
    const installatieHourly = lr.installatieHoursPerInput ?? 0;
    if (installatieHourly > 0) {
      const hours = qty * installatieHourly * learnFactor;
      labourEntries.push({
        inputLabel: `${lr.inputLabel} — installatie`,
        costGroup: "installateur",
        hoursPerInput: installatieHourly,
        inputQty: qty,
        totalHours: hours,
        cost: hours * rates.installatieHourlyRate,
      });
    }
    const arbeidBuitenHourly = (lr as any).arbeidBuitenHrsPerInput ?? 0;
    if (arbeidBuitenHourly > 0) {
      const hours = qty * arbeidBuitenHourly * learnFactor;
      labourEntries.push({
        inputLabel: `${lr.inputLabel} — arbeid buiten`,
        costGroup: "assemblagehal",
        hoursPerInput: arbeidBuitenHourly,
        inputQty: qty,
        totalHours: hours,
        cost: hours * rates.arbeidBuitenHourlyRate,
      });
    }

    const bewerking: { field: "gezaagdM3PerInput" | "cncSimpelM3PerInput" | "cncComplexM3PerInput"; rate: number; label: string }[] = [
      { field: "gezaagdM3PerInput",     rate: rates.gezaagdPerM3,    label: "gezaagd" },
      { field: "cncSimpelM3PerInput",   rate: rates.cncSimpelPerM3,  label: "CNC simpel" },
      { field: "cncComplexM3PerInput",  rate: rates.cncComplexPerM3, label: "CNC complex" },
    ];
    for (const b of bewerking) {
      const m3PerUnit = (lr[b.field] as number) ?? 0;
      if (m3PerUnit <= 0 || b.rate <= 0) continue;
      // Bouwpakket-bewerking (gezaagd/CNC) zit IN bouwpakket, niet in arbeid.
      const totalM3 = qty * m3PerUnit;
      labourEntries.push({
        inputLabel: `${lr.inputLabel} — ${b.label}`,
        costGroup: "bouwpakket",
        hoursPerInput: m3PerUnit,
        inputQty: qty,
        totalHours: totalM3,
        cost: totalM3 * b.rate,
      });
    }
  }

  // Steenachtig-bewerking = auto-afgeleid (niet bewerkbaar): totaal m³ van alle
  // Fermacell (FERM18/FERM10) en Cemvin (CEMVIN) in de kengetal-rijen, per
  // invoercategorie. Prijs via labour_rates.steenachtigPerM3 (default €400/m³).
  const steenachtigByLabel = new Map<string, number>();
  for (const kg of kengetallen) {
    const mat = materialsMap.get(kg.materialId);
    if (!mat) continue;
    if (mat.code !== "FERM18" && mat.code !== "FERM10" && mat.code !== "CEMVIN") continue;
    steenachtigByLabel.set(kg.inputLabel, (steenachtigByLabel.get(kg.inputLabel) ?? 0) + kg.ratio);
  }
  for (const [label, ratioSum] of steenachtigByLabel) {
    const qty = effectiveInputs[label] ?? 0;
    if (qty <= 0 || ratioSum <= 0 || rates.steenachtigPerM3 <= 0) continue;
    const totalM3 = qty * ratioSum;
    labourEntries.push({
      inputLabel: `${label} — steenachtig`,
      costGroup: "bouwpakket",
      hoursPerInput: ratioSum,
      inputQty: qty,
      totalHours: totalM3,
      cost: totalM3 * rates.steenachtigPerM3,
    });
  }

  // S2P stelposten — telt prefab-badkamer-units mee als de S2P-vlag aan staat.
  // De materialen (S2PT/S2PBK_S/S2PBK_M/S2PBK_L) komen uit de seed; prijzen zijn
  // per-organisatie aanpasbaar via de materialenbibliotheek. Per-project
  // overrides (buildingOverrides) worden gerespecteerd voor netto/loss/prijs.
  if (s2pActive) {
    const s2pUnits: { code: string; qty: number }[] = [
      { code: "S2PT",    qty: effectiveInputs["Los toilet"]       ?? 0 },
      { code: "S2PBK_S", qty: effectiveInputs["Badkamers klein"]  ?? 0 },
      { code: "S2PBK_M", qty: effectiveInputs["Badkamers midden"] ?? 0 },
      { code: "S2PBK_L", qty: effectiveInputs["Badkamers groot"]  ?? 0 },
    ];
    const matsByCode = new Map<string, Material>();
    for (const m of materialsMap.values()) matsByCode.set(m.code, m);
    for (const { code, qty } of s2pUnits) {
      const mat = matsByCode.get(code);
      if (!mat || qty <= 0) continue;
      const override = buildingOverrides.find((o) => o.materialId === mat.id);
      const effectiveNetto = override?.quantity ?? qty;
      const effectiveLoss = override?.lossPct ?? mat.lossPct;
      const effectivePrice = override?.pricePerUnit ?? mat.pricePerUnit;
      const bruto = effectiveNetto * (1 + effectiveLoss);
      rows.push({
        material: mat,
        netto: effectiveNetto,
        nettoBron: override?.quantity != null ? override.source : "kengetal",
        loss: effectiveLoss,
        lossBron: override?.lossPct != null ? override.source : "default",
        bruto,
        price: effectivePrice,
        priceBron: override?.pricePerUnit != null ? override.source : "default",
        materialCost: bruto * effectivePrice,
        laborHours: 0,
        laborHoursBron: "default",
        laborCost: 0,
      });
    }
  }

  rows.sort((a, b) => {
    const order: Record<CostGroup, number> = { bouwpakket: 0, installateur: 1, assemblagehal: 2, arbeid: 3, derden: 4, hoofdaannemer: 5 };
    const ga = order[a.material.costGroup];
    const gb = order[b.material.costGroup];
    if (ga !== gb) return ga - gb;
    const catCmp = a.material.category.localeCompare(b.material.category);
    return catCmp !== 0 ? catCmp : a.material.code.localeCompare(b.material.code);
  });

  const subtotalMaterial = sum(rows, (r) => r.materialCost);
  const labourFromCategories = sum(labourEntries, (e) => e.cost);
  const subtotalLabor = sum(rows, (r) => r.laborCost) + labourFromCategories;
  const subtotalDirect = subtotalMaterial + subtotalLabor;

  return {
    building, rows, subtotalMaterial, subtotalLabor, subtotalDirect,
    totalWithCount: subtotalDirect * building.count,
    derivedInputs, effectiveInputs, labourEntries,
    learningFactor: learnFactor,
  };
}

function emptyGroup(group: CostGroup): GroupTotals {
  return {
    group, materialCost: 0, laborCost: 0, transportCost: 0,
    directCost: 0, markups: [], totalMarkups: 0, subtotal: 0, rows: [],
  };
}

function mergeAllRows(buildingResults: BuildingCalcResult[]): MaterialCalcRow[] {
  const merged = new Map<string, MaterialCalcRow>();
  for (const br of buildingResults) {
    for (const row of br.rows) {
      const key = row.material.id;
      const count = br.building.count;
      const existing = merged.get(key);
      const scaledContribs: MaterialContribution[] = (row.contributions ?? []).map((c) => ({
        ...c, inputQty: c.inputQty * count, netto: c.netto * count,
      }));
      if (existing) {
        merged.set(key, {
          ...existing,
          netto: existing.netto + row.netto * count,
          bruto: existing.bruto + row.bruto * count,
          materialCost: existing.materialCost + row.materialCost * count,
          laborHours: existing.laborHours + row.laborHours * count,
          laborCost: existing.laborCost + row.laborCost * count,
          contributions: [...(existing.contributions ?? []), ...scaledContribs],
        });
      } else {
        merged.set(key, {
          ...row,
          netto: row.netto * count,
          bruto: row.bruto * count,
          materialCost: row.materialCost * count,
          laborHours: row.laborHours * count,
          laborCost: row.laborCost * count,
          contributions: scaledContribs,
        });
      }
    }
  }
  return Array.from(merged.values());
}

function transportCost(t: ProjectTransport & { vehicleType?: VehicleType }): number {
  const perTrip = t.costPerTripOverride ?? (t.vehicleType?.costPerKm ?? 0) * t.distanceKm;
  return perTrip * t.tripCount;
}

/** Tarieven voor de materiaal­transport Polen (per truck, hard-coded per de briefing).
 * Inbound NL → VMG Polen: €700 per vrachtwagen.
 * Outbound Lodz → Raamsdonksveer: €1600 per vrachtwagen. */
export const POLAND_INBOUND_COST_PER_TRUCK = 700;
export const POLAND_OUTBOUND_COST_PER_TRUCK = 1600;
export const POLAND_INBOUND_M3_PER_TRUCK = 40;
export const POLAND_OUTBOUND_M3_PER_TRUCK = 30;

/** Schat het volume van een I-Joist-materiaalrij (materiaalcode "IJxxxWxHH") in m³ per m¹. */
function iJoistM3PerM1(code: string): number | null {
  const m = /^IJ(\d+)x(\d+)/i.exec(code);
  if (!m) return null;
  const wMm = parseInt(m[1], 10);
  const hMm = parseInt(m[2], 10);
  if (!Number.isFinite(wMm) || !Number.isFinite(hMm)) return null;
  return (wMm / 1000) * (hMm / 1000);
}

/**
 * Materiaaltransport Polen (auto-berekend, niet bewerkbaar):
 *   Inbound (NL → VMG Polen):  I-joists + LVL + SPANO als grondstoffen. €700/truck.
 *   Outbound (Polen → Raamsdonksveer): alle bouwpakket-m³ (het complete bouwpakket terug). €1600/truck.
 */
export function computeAutoPolandTransport(rows: MaterialCalcRow[]): {
  inboundM3: number; inboundTrucks: number; inboundCost: number;
  outboundM3: number; outboundTrucks: number; outboundCost: number;
} {
  let iJoistM3 = 0;
  let lvlM3 = 0;
  let spanoM3 = 0;
  let otherBouwpakketM3 = 0;
  for (const r of rows) {
    if (r.material.costGroup !== "bouwpakket") continue;
    const unit = r.material.unit.toLowerCase();
    const asIJ = iJoistM3PerM1(r.material.code);
    if (asIJ != null && (unit === "m¹" || unit === "m1")) {
      iJoistM3 += r.bruto * asIJ;
      continue;
    }
    if (unit === "m³" || unit === "m3") {
      const cat = (r.material.category || "").toLowerCase();
      if (cat === "lvl") { lvlM3 += r.bruto; continue; }
      if (r.material.code.toUpperCase() === "SPANO") { spanoM3 += r.bruto; continue; }
      otherBouwpakketM3 += r.bruto;
    }
  }
  // Inbound: ruwbouw-materialen die VMG Polen nodig heeft om het bouwpakket te assembleren.
  const inboundM3 = iJoistM3 + lvlM3 + spanoM3;
  // Outbound: het volledige bouwpakket terug naar Raamsdonksveer.
  const outboundM3 = iJoistM3 + lvlM3 + spanoM3 + otherBouwpakketM3;
  const inboundTrucks = inboundM3 > 0 ? Math.ceil(inboundM3 / POLAND_INBOUND_M3_PER_TRUCK) : 0;
  const outboundTrucks = outboundM3 > 0 ? Math.ceil(outboundM3 / POLAND_OUTBOUND_M3_PER_TRUCK) : 0;
  return {
    inboundM3, inboundTrucks, inboundCost: inboundTrucks * POLAND_INBOUND_COST_PER_TRUCK,
    outboundM3, outboundTrucks, outboundCost: outboundTrucks * POLAND_OUTBOUND_COST_PER_TRUCK,
  };
}

/** Compute markup amount + basis amount for a row, given available totals and running cumulative. */
function computeMarkup(
  row: MarkupRow,
  ctx: { groupDirect: number; groupCumulative: number; totaalExDerden: number; inkoopDerden: number; grandTotal: number; bouwpakketPlusAssemblage: number; gfa: number },
): MarkupCalcRow {
  const basisAmount =
    row.basis === "group_direct" ? ctx.groupDirect
    : row.basis === "group_cumulative" ? ctx.groupCumulative
    : row.basis === "totaal_ex_derden" ? ctx.totaalExDerden
    : row.basis === "inkoop_derden" ? ctx.inkoopDerden
    : row.basis === "grand_total" ? ctx.grandTotal
    : row.basis === "bouwpakket_plus_assemblage" ? ctx.bouwpakketPlusAssemblage
    : 0;

  let amount = 0;
  if (row.type === "percentage") amount = basisAmount * (row.value / 100);
  else if (row.type === "fixed") amount = row.value;
  else if (row.type === "per_m2") amount = row.value * ctx.gfa;

  return {
    id: row.id, name: row.name, type: row.type as any, value: row.value,
    basis: row.basis as any, basisAmount, amount,
  };
}

/**
 * Bereken het scoped subtotaal voor één gebouw, inclusief alle bouwpakket-/
 * installateur-/assemblagehal-/derden-markups toegepast op DIT gebouw (niet project-breed).
 * Gebruikt dezelfde twee-pass-logica als calculateProject: eerst groep-specifieke
 * markups, dan totaal_ex_derden-markups op basis van deze building's eigen totaal.
 */
export function computeBuildingScopedTotal(
  br: BuildingCalcResult,
  markupRows: MarkupRow[],
  gfaInputLabel: string = "Module oppervlak",
  /** Optioneel: BVO als expliciete waarde voor per_m² markups.
   *  Als afwezig → fallback op effectiveInputs[gfaInputLabel]. */
  gfaOverride?: number,
): number {
  const groups: CostGroup[] = ["bouwpakket", "installateur", "assemblagehal", "derden", "hoofdaannemer"];

  // Fase 1 — directe kosten per groep (materiaal + arbeid + transport-polen voor bouwpakket).
  const directByGroup = new Map<CostGroup, number>();
  for (const g of groups) {
    const rows = br.rows.filter((r) => r.material.costGroup === g);
    const materialCost = rows.reduce((s, r) => s + r.materialCost, 0);
    const labourFromCats = br.labourEntries.filter((e) => e.costGroup === g).reduce((s, e) => s + e.cost, 0);
    const laborCost = rows.reduce((s, r) => s + r.laborCost, 0) + labourFromCats;
    let transportCost = 0;
    if (g === "bouwpakket") {
      const auto = computeAutoPolandTransport(rows);
      transportCost = auto.inboundCost + auto.outboundCost;
    }
    directByGroup.set(g, materialCost + laborCost + transportCost);
  }
  const buildingGfa = gfaOverride ?? (br.effectiveInputs[gfaInputLabel] ?? 0);

  // Fase 2 — markups per groep: pass 1 (exkl. totaal_ex_derden).
  const sortedMarkups = [...markupRows].sort((a, b) => a.sortOrder - b.sortOrder);
  const amountsByGroup = new Map<CostGroup, number[]>();
  const totalExDerdenBasis: { id: string; idx: number; groupKey: CostGroup }[] = [];
  for (const g of groups) {
    const rowsForGroup = sortedMarkups.filter((m) => m.costGroup === g);
    const direct = directByGroup.get(g) ?? 0;
    let cumulative = direct;
    const amounts: number[] = [];
    for (const m of rowsForGroup) {
      if (m.basis === "totaal_ex_derden") {
        amounts.push(0); // placeholder — invullen in pass 2
        totalExDerdenBasis.push({ id: m.id, idx: amounts.length - 1, groupKey: g });
        continue;
      }
      const basisAmount =
        m.basis === "group_direct" ? direct
        : m.basis === "group_cumulative" ? cumulative
        : 0;
      let amount = 0;
      if (m.type === "percentage") amount = basisAmount * (m.value / 100);
      else if (m.type === "fixed") amount = m.value;
      else if (m.type === "per_m2") amount = m.value * buildingGfa;
      amounts.push(amount);
      cumulative += amount;
    }
    amountsByGroup.set(g, amounts);
  }

  // Provisional totaal_ex_derden = bp + inst + asm (direct + pass-1 markups exkl. TED).
  const provisional = (["bouwpakket", "installateur", "assemblagehal"] as CostGroup[])
    .reduce((sum, g) => sum + (directByGroup.get(g) ?? 0) + (amountsByGroup.get(g) ?? []).reduce((s, x) => s + x, 0), 0);

  // Fase 3 — totaal_ex_derden placeholders invullen.
  for (const entry of totalExDerdenBasis) {
    const src = sortedMarkups.find((m) => m.id === entry.id);
    if (!src) continue;
    let amount = 0;
    if (src.type === "percentage") amount = provisional * (src.value / 100);
    else if (src.type === "fixed") amount = src.value;
    else if (src.type === "per_m2") amount = src.value * buildingGfa;
    const arr = amountsByGroup.get(entry.groupKey)!;
    arr[entry.idx] = amount;
  }

  // Som van alle direct-cost + alle markups (per groep).
  let total = 0;
  for (const g of groups) {
    total += directByGroup.get(g) ?? 0;
    total += (amountsByGroup.get(g) ?? []).reduce((s, x) => s + x, 0);
  }
  return total;
}

export function calculateProject(
  project: Project,
  buildingResults: BuildingCalcResult[],
  transport: (ProjectTransport & { vehicleType?: VehicleType })[],
  markupRows: MarkupRow[],
  rates: Omit<LabourRates, "id" | "orgId"> = DEFAULT_LABOUR_RATES,
  gfaInputLabel: string = "Module oppervlak",
  projectLearningFactor: number = 1,
  /** Optioneel: BVO per building.id (1×). Wordt vermenigvuldigd met building.count
   *  en gebruikt voor per_m² markups + pricePerM2. Afwezig → fallback op
   *  effectiveInputs[gfaInputLabel]. */
  gfaByBuildingId?: Map<string, number>,
  /** Auto-berekend assemblagehal-transport (Transport 3D modulair, bron: TransportCalculator).
   *  Komt boven op assemblagehal.transportCost zodat de gebruiker niet vergeet
   *  dat deze post in de begroting hoort. */
  autoAssemblageTransport: number = 0,
  /** Aantal unieke moduletypes (L|W|H tuples) over het hele project. Drijft de
   *  type-penalty in computeProjectMgmtHours (50u per extra type na de eerste). */
  distinctModuleTypes: number = 1,
): ProjectCalcResult {
  const allRows = mergeAllRows(buildingResults);

  const bouwpakket   = emptyGroup("bouwpakket");
  const installateur = emptyGroup("installateur");
  const assemblagehal= emptyGroup("assemblagehal");
  const arbeid       = emptyGroup("arbeid");
  const derden       = emptyGroup("derden");
  const hoofdaannemer= emptyGroup("hoofdaannemer");

  for (const row of allRows) {
    const g = row.material.costGroup as CostGroup;
    const target = g === "bouwpakket" ? bouwpakket
                 : g === "installateur" ? installateur
                 : g === "derden" ? derden
                 : g === "hoofdaannemer" ? hoofdaannemer
                 : g === "arbeid" ? arbeid
                 : assemblagehal;
    target.rows.push(row);
    target.materialCost += row.materialCost;
    target.laborCost += row.laborCost;
  }

  // Categorie-arbeid routed naar de juiste groep op basis van e.costGroup.
  for (const br of buildingResults) {
    for (const e of br.labourEntries) {
      const target = e.costGroup === "bouwpakket" ? bouwpakket
                  : e.costGroup === "installateur" ? installateur
                  : e.costGroup === "derden" ? derden
                  : e.costGroup === "hoofdaannemer" ? hoofdaannemer
                  : e.costGroup === "assemblagehal" ? assemblagehal
                  : arbeid;
      target.laborCost += e.cost * br.building.count;
    }
  }

  // Module-gedreven arbeid: arbeid buiten + projectmanagement (uren per module).
  let totalModules = 0;
  for (const br of buildingResults) {
    const cntPerBuilding = br.effectiveInputs[MODULE_DERIVED_LABELS.COUNT] ?? 0;
    totalModules += cntPerBuilding * br.building.count;
  }
  // Arbeid-buiten op project-niveau is verwijderd — wordt nu volledig via per-kengetal
  // `arbeidBuitenHrsPerInput` afgehandeld. De labour_rates.arbeidBuitenHoursBase /
  // -PerModule velden blijven bestaan in DB maar worden niet meer in de calc gebruikt.
  const arbeidBuitenHours = 0;
  const arbeidBuitenCost = 0;
  // Projectmanagement = vaste formule (200 × n^0,434 + 50 × extra moduletypes),
  // niet meer afhankelijk van labour_rates.projectmgmtHoursBase / -PerModule.
  // Alleen het uurtarief blijft instelbaar.
  const pm = computeProjectMgmtHours(totalModules, distinctModuleTypes);
  const projectmgmtCost = pm.totalHours * rates.projectmgmtHourlyRate;
  assemblagehal.laborCost += projectmgmtCost;

  // Project-niveau labour entries — PM is projectbrede overhead. Door 'm als
  // CategoryLabourEntry te exposen verschijnt ie in de begroting onder
  // Assemblagehal → Arbeid (en kan ie ook uit/aan worden gevinkt).
  const projectLevelLabour: CategoryLabourEntry[] = [];
  if (projectmgmtCost > 0) {
    projectLevelLabour.push({
      inputLabel: "Projectmanagement",
      costGroup: "assemblagehal",
      hoursPerInput: 0,
      inputQty: totalModules,
      totalHours: pm.totalHours,
      cost: projectmgmtCost,
    });
  }

  // Handmatige transportregels uit projectTransport.
  for (const t of transport) {
    const cost = transportCost(t);
    if (t.costGroup === "bouwpakket") bouwpakket.transportCost += cost;
    else assemblagehal.transportCost += cost;
  }

  // Auto-transport Polen: inbound = I-joists m³ / 40 × €1600; outbound = alle bouwpakket m³ / 30 × €1600.
  const auto = computeAutoPolandTransport(allRows);
  bouwpakket.transportCost += auto.inboundCost + auto.outboundCost;

  // Auto-transport assemblagehal (3D modulair — bron: TransportCalculator). Wordt
  // door de client geset zodra de berekening draait; valt stil terug op 0 zolang
  // de gebruiker de Transport-tab nog niet heeft gebruikt.
  if (autoAssemblageTransport > 0) {
    assemblagehal.transportCost += autoAssemblageTransport;
  }
  bouwpakket.directCost    = bouwpakket.materialCost    + bouwpakket.laborCost    + bouwpakket.transportCost;
  installateur.directCost  = installateur.materialCost  + installateur.laborCost  + installateur.transportCost;
  assemblagehal.directCost = assemblagehal.materialCost + assemblagehal.laborCost + assemblagehal.transportCost;
  arbeid.directCost        = arbeid.materialCost        + arbeid.laborCost        + arbeid.transportCost;
  derden.directCost        = derden.materialCost        + derden.laborCost        + derden.transportCost;
  hoofdaannemer.directCost = hoofdaannemer.materialCost + hoofdaannemer.laborCost + hoofdaannemer.transportCost;

  // GFA voor per_m² markups + pricePerM2. Voorkeur: expliciete BVO per gebouw
  // (via `gfaByBuildingId`); fallback: effectieve input op `gfaInputLabel`.
  let gfa = 0;
  for (const br of buildingResults) {
    const area = gfaByBuildingId?.get(br.building.id) ?? (br.effectiveInputs[gfaInputLabel] ?? 0);
    gfa += area * br.building.count;
  }

  // Sort markup rows for deterministic processing.
  const sortedMarkups = [...markupRows].sort((a, b) => a.sortOrder - b.sortOrder);

  // Group-specific markups applied in order; 'totaal_ex_derden' resolves after all three
  // primary groups have been processed, so we do two passes: first compute group-level
  // markups that don't need totaal_ex_derden; then resolve those that do.
  const groupsInOrder: GroupTotals[] = [bouwpakket, installateur, assemblagehal, arbeid];

  // Pass 1: compute everything that doesn't depend on totaal_ex_derden
  for (const g of groupsInOrder) {
    const rows = sortedMarkups.filter((r) => r.costGroup === g.group);
    let cumulative = g.directCost;
    for (const r of rows) {
      const m = computeMarkup(r, {
        groupDirect: g.directCost, groupCumulative: cumulative,
        totaalExDerden: 0, inkoopDerden: 0, grandTotal: 0, bouwpakketPlusAssemblage: 0, gfa,
      });
      g.markups.push(m);
      cumulative += m.amount;
    }
  }
  // Derden: eigen markups (bv. AK + W&R 14 % × inkoop_derden) op basis van directCost.
  // Markup-resultaten worden bij derden.subtotal opgeteld. Om circulariteit te vermijden
  // gebruiken markups met basis=inkoop_derden de directCost (niet subtotal).
  {
    const rows = sortedMarkups.filter((r) => r.costGroup === "derden");
    let cumulative = derden.directCost;
    for (const r of rows) {
      const m = computeMarkup(r, {
        groupDirect: derden.directCost, groupCumulative: cumulative,
        totaalExDerden: 0, inkoopDerden: derden.directCost, grandTotal: 0,
        bouwpakketPlusAssemblage: 0, gfa,
      });
      derden.markups.push(m);
      cumulative += m.amount;
    }
    derden.totalMarkups = sum(derden.markups, (m) => m.amount);
    derden.subtotal = derden.directCost + derden.totalMarkups;
  }

  // Provisional totaal_ex_derden — sum of directCost + markups that don't depend on it
  // (we'll substitute actual values for 'totaal_ex_derden' basis rows in pass 2).
  function sumMarkupsSoFar(g: GroupTotals): number {
    // If a markup was computed with basis=totaal_ex_derden its basisAmount is 0; treat as 0 for now.
    return sum(g.markups, (m) => (m.basis === "totaal_ex_derden" ? 0 : m.amount));
  }
  const provisionalGroupSubtotals = groupsInOrder.map((g) => g.directCost + sumMarkupsSoFar(g));
  const provisionalTotaalExDerden = provisionalGroupSubtotals.reduce((a, b) => a + b, 0);

  // Pass 2: replace basis amounts for totaal_ex_derden markups using provisional value
  for (let i = 0; i < groupsInOrder.length; i++) {
    const g = groupsInOrder[i];
    for (let j = 0; j < g.markups.length; j++) {
      const m = g.markups[j];
      if (m.basis === "totaal_ex_derden") {
        const src = sortedMarkups.find((s) => s.id === m.id)!;
        g.markups[j] = computeMarkup(src, {
          groupDirect: g.directCost, groupCumulative: 0,
          totaalExDerden: provisionalTotaalExDerden, inkoopDerden: derden.subtotal, grandTotal: 0, bouwpakketPlusAssemblage: 0, gfa,
        });
      }
    }
    g.totalMarkups = sum(g.markups, (m) => m.amount);
    g.subtotal = g.directCost + g.totalMarkups;
  }

  const totaalExDerden = groupsInOrder.reduce((s, g) => s + g.subtotal, 0);

  // Hoofdaannemer: eigen groep met markups — blijft buiten totaalExDerden zodat die
  // basis stabiel blijft. grandTotal binnen deze groep = totaalExDerden + derden
  // (= "alles behalve hoofdaannemer zelf"), vast tijdens de hele hoofdaannemer-pass
  // zodat ABK en CAR dezelfde basis zien ongeacht volgorde.
  {
    const rows = sortedMarkups.filter((r) => r.costGroup === "hoofdaannemer");
    const hoofdGrandBase = totaalExDerden + derden.subtotal;
    let cumulative = hoofdaannemer.directCost;
    for (const r of rows) {
      const m = computeMarkup(r, {
        groupDirect: hoofdaannemer.directCost, groupCumulative: cumulative,
        totaalExDerden, inkoopDerden: derden.subtotal, grandTotal: hoofdGrandBase,
        bouwpakketPlusAssemblage: bouwpakket.subtotal + assemblagehal.subtotal, gfa,
      });
      hoofdaannemer.markups.push(m);
      cumulative += m.amount;
    }
    hoofdaannemer.totalMarkups = sum(hoofdaannemer.markups, (m) => m.amount);
    hoofdaannemer.subtotal = hoofdaannemer.directCost + hoofdaannemer.totalMarkups;
  }

  const preProjectMarkups = totaalExDerden + derden.subtotal + hoofdaannemer.subtotal;

  // Project-level markups (costGroup null)
  const projectMarkupSrc = sortedMarkups.filter((r) => r.costGroup == null);
  const projectMarkups: MarkupCalcRow[] = [];
  let grandCum = preProjectMarkups;
  for (const r of projectMarkupSrc) {
    const m = computeMarkup(r, {
      groupDirect: 0, groupCumulative: 0,
      totaalExDerden, inkoopDerden: derden.subtotal, grandTotal: grandCum,
      bouwpakketPlusAssemblage: bouwpakket.subtotal + assemblagehal.subtotal, gfa,
    });
    projectMarkups.push(m);
    grandCum += m.amount;
  }
  const totalProjectMarkups = sum(projectMarkups, (m) => m.amount);
  const totalExVat = preProjectMarkups + totalProjectMarkups;

  const totalMaterial = bouwpakket.materialCost + installateur.materialCost + assemblagehal.materialCost + arbeid.materialCost + derden.materialCost + hoofdaannemer.materialCost;
  const totalLabor    = bouwpakket.laborCost    + installateur.laborCost    + assemblagehal.laborCost    + arbeid.laborCost    + derden.laborCost    + hoofdaannemer.laborCost;
  const totalTransport = bouwpakket.transportCost + assemblagehal.transportCost;
  const totalDirect    = totalMaterial + totalLabor + totalTransport + derden.directCost + hoofdaannemer.directCost;

  return {
    buildings: buildingResults,
    groups: [bouwpakket, installateur, assemblagehal, arbeid, derden, hoofdaannemer],
    bouwpakket, installateur, assemblagehal, arbeid, derden, hoofdaannemer,
    autoTransport: auto,
    arbeidBuitenCost, projectmgmtCost, totalModules,
    projectmgmtHours: pm.totalHours,
    projectmgmtBaseHours: pm.baseHours,
    projectmgmtTypePenaltyHours: pm.typePenaltyHours,
    projectmgmtExponent: pm.exponent,
    distinctModuleTypes,
    arbeidBuitenHours,
    projectLevelLabour,
    totaalExDerden, preProjectMarkups,
    projectMarkups, totalProjectMarkups,
    totalDirect, totalMaterial, totalLabor, totalTransport,
    totalExVat, totalGFA: gfa, pricePerM2: gfa > 0 ? totalExVat / gfa : 0,
  };
}

// ── Formatters ──
export function formatEUR(value: number): string {
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}
export function formatEURdec(value: number, decimals: number = 2): string {
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}
/** Slim format: ≤ €10 → 2 decimalen, anders afgerond op hele euro's. */
export function formatEURsmart(value: number): string {
  if (value > 0 && value <= 10) return formatEURdec(value, 2);
  return formatEUR(value);
}
export function formatNumber(value: number, decimals: number = 1): string {
  return new Intl.NumberFormat("nl-NL", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}
/** Hoeveelheid-formatter: toont hele getallen zonder decimaal wanneer het getal
 * (binnen afrondingsmarge) een integer is; anders 1 decimaal. */
export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.05) return new Intl.NumberFormat("nl-NL").format(rounded);
  return formatNumber(value, 1);
}
export function formatPct(value: number): string { return `${Math.round(value * 100)}%`; }

export const COST_GROUP_LABELS: Record<CostGroup, string> = {
  bouwpakket: "Bouwpakket",
  installateur: "Installateur",
  assemblagehal: "Assemblagehal",
  arbeid: "Arbeid",
  derden: "Inkoop derden",
  hoofdaannemer: "Bijkomend (hoofdaannemer)",
};

export const COST_GROUP_DESCRIPTIONS: Record<CostGroup, string> = {
  bouwpakket: "Prefab constructie uit de fabriek (LVL, platen, dragende elementen) incl. 1d-transport",
  installateur: "Gebouwgebonden installaties (ventilatie, elektra, WKO, sanitair)",
  assemblagehal: "Materialen in de assemblagehal + afbouw + 3d-transport naar bouwplaats",
  arbeid: "Uren × uurtarief — per invoercategorie ingesteld in de kengetallen",
  derden: "Inkoop via hoofdaannemer (balkons, fundering)",
  hoofdaannemer: "Bijkomende hoofdaannemer-kosten: AK+W&R, ABK, coördinatie, CAR",
};

export const BASIS_LABELS: Record<string, string> = {
  group_direct: "materiaal + arbeid + transport in groep",
  group_cumulative: "lopend subtotaal in groep",
  totaal_ex_derden: "totaal exclusief derden",
  inkoop_derden: "inkoop derden",
  grand_total: "lopend totaal (incl. derden)",
  bouwpakket_plus_assemblage: "bouwpakket + assemblagehal",
};

/** Default onvoorzien-percentage per projectfase. User mag overschrijven. */
export function onvoorzienDefaultForStatus(status: string): number {
  switch (status) {
    case "SO": return 8;
    case "VO": return 5;
    case "DO": return 3;
    case "UO": return 0;
    default:   return 8;
  }
}
