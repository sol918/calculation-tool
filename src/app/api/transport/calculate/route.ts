import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, buildings, modules, buildingInputs, geocodeCache, routeCache } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── Configuration (defaults; later editable via settings UI) ─────────
const MAX_TRANSPORT_HEIGHT_M = 4.25;
const ABSOLUTE_MAX_WIDTH_M = 4.25;
const ROOF_HEIGHT_EXTRA_M = 0.50;
const DETOUR_FACTOR = 1.30;
const HGV_AVG_KMH = 70;
const EXTRA_TRIPS_AUTO_PCT = 0.05; // 5% van totaal trucks

const TRAILERS = [
  { id: "standard",       label: "Standaard oplegger", floorHeight: 1.15, maxLength: 13.60, maxWidth: 2.55, surcharge: 1.00 },
  { id: "mega",           label: "Mega-trailer",       floorHeight: 0.90, maxLength: 13.60, maxWidth: 2.55, surcharge: 1.05 },
  { id: "semi_dieplader", label: "Semi-dieplader",     floorHeight: 0.85, maxLength: 10.50, maxWidth: 2.55, surcharge: 1.15 },
  { id: "dieplader",      label: "Euro-dieplader",     floorHeight: 0.40, maxLength: 8.00,  maxWidth: 2.55, surcharge: 1.25 },
] as const;
type TrailerId = typeof TRAILERS[number]["id"];

const WIDTH_TARIFFS = [
  { widthMax: 2.60, rate: 1000.00 },
  { widthMax: 3.00, rate: 1166.67 },
  { widthMax: 3.20, rate: 1300.00 },
  { widthMax: 3.50, rate: 1333.33 },
  { widthMax: 4.00, rate: 2333.33 },
  { widthMax: Infinity, rate: 3000.00 },
];
function tariffForWidth(w: number): number {
  return WIDTH_TARIFFS.find((t) => w <= t.widthMax)!.rate;
}

const DEFAULT_START = "Raamsdonksveer, Nederland";

// ── Geocoding via Nominatim ──────────────────────────────────────────
async function geocode(address: string): Promise<{ lat: number; lon: number }> {
  const norm = address.trim();
  const existing = await db.query.geocodeCache.findFirst({ where: eq(geocodeCache.address, norm) });
  if (existing) return { lat: existing.lat, lon: existing.lon };
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(norm)}&format=json&limit=1&countrycodes=nl,be,de`;
  const res = await fetch(url, { headers: { "User-Agent": "sustainer-calc/1.0 (dev)" } });
  if (!res.ok) throw new Error(`Geocode failed for "${norm}" (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Geen resultaat voor "${norm}"`);
  const lat = parseFloat(data[0].lat);
  const lon = parseFloat(data[0].lon);
  await db.insert(geocodeCache).values({ address: norm, lat, lon });
  return { lat, lon };
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function route(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  restriction: { heightM: number; widthM: number; lengthM: number },
): Promise<{ distanceM: number; durationS: number; source: "ors" | "haversine"; orsError?: string }> {
  const key = `${from.lat.toFixed(4)},${from.lon.toFixed(4)}->${to.lat.toFixed(4)},${to.lon.toFixed(4)}|h${restriction.heightM.toFixed(1)}w${restriction.widthM.toFixed(1)}l${restriction.lengthM.toFixed(1)}`;
  const existing = await db.query.routeCache.findFirst({ where: eq(routeCache.cacheKey, key) });
  if (existing) return { distanceM: existing.distanceM, durationS: existing.durationS, source: existing.source as any };

  const orsKey = process.env.ORS_API_KEY;
  let orsError: string | undefined;
  if (orsKey) {
    try {
      const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-hgv", {
        method: "POST",
        headers: { "Authorization": orsKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
          options: {
            profile_params: {
              restrictions: {
                height: restriction.heightM, width: restriction.widthM, length: restriction.lengthM, weight: 40,
              },
            },
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const summary = data.routes?.[0]?.summary ?? data.features?.[0]?.properties?.summary;
        if (summary && typeof summary.distance === "number" && typeof summary.duration === "number") {
          await db.insert(routeCache).values({ cacheKey: key, distanceM: summary.distance, durationS: summary.duration, source: "ors" });
          return { distanceM: summary.distance, durationS: summary.duration, source: "ors" };
        }
        orsError = "ORS response zonder geldige summary";
      } else {
        const body = await res.text().catch(() => "");
        orsError = `ORS HTTP ${res.status}: ${body.slice(0, 160) || res.statusText}`;
        console.warn("[ORS]", orsError);
      }
    } catch (e: any) {
      orsError = `ORS fetch error: ${e?.message ?? String(e)}`;
      console.warn("[ORS]", orsError);
    }
  } else {
    orsError = "ORS_API_KEY niet in .env.local";
  }

  const distKm = haversineKm(from, to) * DETOUR_FACTOR;
  const distanceM = distKm * 1000;
  const durationS = (distKm / HGV_AVG_KMH) * 3600;
  await db.insert(routeCache).values({ cacheKey: key, distanceM, durationS, source: "haversine" });
  return { distanceM, durationS, source: "haversine", orsError };
}

function classifyTrailer(m: { heightM: number; widthM: number; lengthM: number; isRoof: boolean }): TrailerId | null {
  if (m.widthM > ABSOLUTE_MAX_WIDTH_M) return null;
  const effH = m.heightM + (m.isRoof ? ROOF_HEIGHT_EXTRA_M : 0);
  for (const t of TRAILERS) {
    if (effH + t.floorHeight <= MAX_TRANSPORT_HEIGHT_M && m.lengthM <= t.maxLength) return t.id;
  }
  return null;
}

interface WarningItem { severity: "warn" | "error"; message: string; }

// ── Handler ──────────────────────────────────────────────────────────
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const buildingIdFilter: string | undefined = body.buildingId;
  if (!projectId) return NextResponse.json({ error: "Missing projectId" }, { status: 400 });

  const projectRaw = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!projectRaw) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  // Defaults voor niet-ingevulde velden: Amsterdam als bestemming, 120 min laad-/lostijd.
  const project = {
    ...projectRaw,
    destinationAddress: projectRaw.destinationAddress?.trim() || "Amsterdam, Nederland",
    loadTimeMinutes: projectRaw.loadTimeMinutes >= 30 ? projectRaw.loadTimeMinutes : 120,
  };

  let bldgs = await db.select().from(buildings).where(eq(buildings.projectId, projectId));
  if (buildingIdFilter) bldgs = bldgs.filter((b) => b.id === buildingIdFilter);

  interface ModuleUnit {
    dims: string; lengthM: number; widthM: number; heightM: number; isRoof: boolean;
    buildingName: string; buildingId: string; buildingCount: number;
  }

  // Collect module units per building × trailerType.
  // Key format: buildingId|trailerType. Count per unit reflects ONE building instance
  // (multiplied later by buildingCount for total trucks).
  const perBuildingTrailer = new Map<string, ModuleUnit[]>();
  const warnings: WarningItem[] = [];
  let anyClassified = false;

  for (const b of bldgs) {
    const mods = await db.select().from(modules).where(eq(modules.buildingId, b.id));

    // Per-building gemiddeld aantal verdiepingen = module oppervlak / opp begane grond.
    // Als >= 1 dan is 1/floors het aandeel dakmodules per module-type.
    const inputs = await db.select().from(buildingInputs).where(eq(buildingInputs.buildingId, b.id));
    const bgg = inputs.find((i) => i.inputLabel === "_opp_begane_grond")?.quantity ?? 0;
    const moduleOpp = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
    const avgFloors = bgg > 0 ? moduleOpp / bgg : 1;
    const roofRatio = avgFloors >= 1 ? 1 / avgFloors : 0;

    // Classify variant and add to bucket. Optional explicit `isRoof` forces 100% roof.
    const addVariant = (m: typeof mods[number], variantCount: number, variantIsRoof: boolean) => {
      if (variantCount <= 0) return;
      const unit = {
        lengthM: m.lengthM, widthM: m.widthM, heightM: m.heightM,
        isRoof: variantIsRoof,
        dims: `${m.widthM.toFixed(3)}×${m.lengthM.toFixed(3)}×${m.heightM.toFixed(3)}${variantIsRoof ? " (dak)" : ""}`,
      };
      const trailer = classifyTrailer(unit);
      if (!trailer) {
        const reasons: string[] = [];
        if (m.widthM > ABSOLUTE_MAX_WIDTH_M) reasons.push(`breedte ${m.widthM.toFixed(3)} m > ${ABSOLUTE_MAX_WIDTH_M} m`);
        const effH = m.heightM + (variantIsRoof ? ROOF_HEIGHT_EXTRA_M : 0);
        if (effH + 0.40 > MAX_TRANSPORT_HEIGHT_M) reasons.push(`hoogte ${effH.toFixed(3)} m + 0,40 m dieplader > ${MAX_TRANSPORT_HEIGHT_M} m`);
        if (m.lengthM > 13.60) reasons.push(`lengte ${m.lengthM.toFixed(3)} m > 13,60 m trailerbed`);
        warnings.push({
          severity: "error",
          message: `Module ${variantIsRoof ? "(dak) " : ""}in ${b.name} past niet: ${reasons.join("; ") || "onbekende reden"}.`,
        });
        return;
      }
      anyClassified = true;
      const key = `${b.id}|${trailer}`;
      const list = perBuildingTrailer.get(key) ?? [];
      for (let i = 0; i < variantCount; i++) {
        list.push({ ...unit, buildingName: b.name, buildingId: b.id, buildingCount: b.count });
      }
      perBuildingTrailer.set(key, list);
    };

    for (const m of mods) {
      if (m.isRoof) {
        // Expliciet gemarkeerd als dak → volledige count als dakmodule.
        addVariant(m, m.count, true);
      } else if (roofRatio > 0) {
        // Automatische split o.b.v. aantal verdiepingen.
        const roofCount = Math.round(m.count * roofRatio);
        const regularCount = m.count - roofCount;
        addVariant(m, regularCount, false);
        addVariant(m, roofCount, true);
      } else {
        addVariant(m, m.count, false);
      }
    }
  }

  if (!anyClassified) {
    return NextResponse.json({ error: "Geen passende modules gevonden (of geen modules gedefinieerd)." }, { status: 400 });
  }

  // ── Geocode + route ────────────────────────────────────────────────
  const allModules = Array.from(perBuildingTrailer.values()).flat();
  const maxHeight = Math.max(...allModules.map((m) => m.heightM + (m.isRoof ? ROOF_HEIGHT_EXTRA_M : 0)));
  const maxWidth = Math.max(...allModules.map((m) => m.widthM));
  const restriction = {
    heightM: Math.min(maxHeight + 1.15, 4.0),
    widthM: Math.min(Math.max(maxWidth, 2.55), 4.0),
    lengthM: 16.5,
  };

  let startLoc, destLoc, waypointLoc;
  try {
    startLoc = await geocode(DEFAULT_START);
    destLoc = await geocode(project.destinationAddress);
    if (project.waypointAddress) waypointLoc = await geocode(project.waypointAddress);
  } catch (e: any) {
    return NextResponse.json({ error: `Geocoding mislukt: ${e.message}` }, { status: 502 });
  }

  const legs: { from: string; to: string; distanceM: number; durationS: number; source: string }[] = [];
  const legErrors: string[] = [];
  const addLeg = async (fromName: string, toName: string, from: { lat: number; lon: number }, to: { lat: number; lon: number }) => {
    const r = await route(from, to, restriction);
    legs.push({ from: fromName, to: toName, distanceM: r.distanceM, durationS: r.durationS, source: r.source });
    if (r.source === "haversine" && r.orsError) legErrors.push(r.orsError);
  };
  if (waypointLoc) {
    await addLeg("Start", "Tussenstop", startLoc, waypointLoc);
    await addLeg("Tussenstop", "Bestemming", waypointLoc, destLoc);
  } else {
    await addLeg("Start", "Bestemming", startLoc, destLoc);
  }
  if (project.returnToStart) await addLeg("Bestemming", "Start", destLoc, startLoc);

  const totalDistanceM = legs.reduce((s, l) => s + l.distanceM, 0);
  const totalDurationS = legs.reduce((s, l) => s + l.durationS, 0);
  const tripMinutes = totalDurationS / 60 + project.loadTimeMinutes;
  const hoursPerTruck = Math.max(1, Math.ceil(tripMinutes / 60));

  // ── Bin-pack per (building, trailer) ───────────────────────────────
  type Truck = { items: ModuleUnit[]; remainingLengthM: number };
  function binPack(items: ModuleUnit[], maxLength: number): Truck[] {
    const sorted = [...items].sort((a, b) => b.lengthM - a.lengthM);
    const trucks: Truck[] = [];
    for (const it of sorted) {
      const fit = trucks.find((t) => t.remainingLengthM + 1e-6 >= it.lengthM);
      if (fit) { fit.items.push(it); fit.remainingLengthM -= it.lengthM; }
      else trucks.push({ items: [it], remainingLengthM: maxLength - it.lengthM });
    }
    return trucks;
  }
  function patternKey(t: Truck): string {
    const counts = new Map<string, number>();
    for (const it of t.items) counts.set(it.dims, (counts.get(it.dims) ?? 0) + 1);
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${v}× ${k}`).join(" + ");
  }

  interface BuildingTrailerGroup {
    buildingName: string; buildingCount: number;
    modulesPerInstance: number; trucksPerInstance: number; totalTrucks: number;
    patterns: { description: string; trucksPerInstance: number; totalTrucks: number; modulesPerTruck: number }[];
  }
  interface TrailerResult {
    trailer: TrailerId; trailerLabel: string;
    modulesTotal: number; trucksPacked: number; trucksExtra: number; trucksTotal: number;
    hoursPerTruck: number;
    maxWidth: number; dayRate: number; hourlyRate: number; surcharge: number; cost: number;
    truckUtilizationPct: number;
    buildings: BuildingTrailerGroup[];
  }
  const perTrailerResult: TrailerResult[] = [];

  for (const trailerSpec of TRAILERS) {
    // Gather all (building, items) for this trailer
    const buildingGroups: BuildingTrailerGroup[] = [];
    let totalTrucks = 0;
    let totalUsedLength = 0;
    let totalModules = 0;
    let maxWidthInGroup = 0;

    for (const [key, items] of perBuildingTrailer) {
      if (!key.endsWith(`|${trailerSpec.id}`)) continue;
      const buildingCount = items[0]?.buildingCount ?? 1;
      const buildingName = items[0]?.buildingName ?? "?";
      // Bin-pack modules of ONE building-instance (don't mix across buildings).
      const packedTrucks = binPack(items, trailerSpec.maxLength);
      const trucksPerInstance = packedTrucks.length;
      const modulesPerInstance = items.length;

      const patternMap = new Map<string, { description: string; trucksPerInstance: number; modulesPerTruck: number }>();
      for (const t of packedTrucks) {
        const k = patternKey(t);
        const existing = patternMap.get(k);
        if (existing) existing.trucksPerInstance += 1;
        else patternMap.set(k, { description: k, trucksPerInstance: 1, modulesPerTruck: t.items.length });
      }
      const patterns = Array.from(patternMap.values())
        .map((p) => ({ ...p, totalTrucks: p.trucksPerInstance * buildingCount }))
        .sort((a, b) => b.trucksPerInstance - a.trucksPerInstance);

      const usedLengthPerInstance = packedTrucks.reduce((s, t) => s + (trailerSpec.maxLength - t.remainingLengthM), 0);

      buildingGroups.push({
        buildingName, buildingCount,
        modulesPerInstance, trucksPerInstance,
        totalTrucks: trucksPerInstance * buildingCount,
        patterns,
      });

      totalTrucks += trucksPerInstance * buildingCount;
      totalUsedLength += usedLengthPerInstance * buildingCount;
      totalModules += modulesPerInstance * buildingCount;
      maxWidthInGroup = Math.max(maxWidthInGroup, ...items.map((it) => it.widthM));
    }

    if (buildingGroups.length === 0) continue;

    const dayRate = tariffForWidth(maxWidthInGroup);
    const hourlyRate = dayRate / project.workdayHours;
    const utilization = totalTrucks > 0 ? (totalUsedLength / (totalTrucks * trailerSpec.maxLength)) * 100 : 0;

    perTrailerResult.push({
      trailer: trailerSpec.id, trailerLabel: trailerSpec.label,
      modulesTotal: totalModules, trucksPacked: totalTrucks, trucksExtra: 0, trucksTotal: totalTrucks,
      hoursPerTruck,
      maxWidth: maxWidthInGroup, dayRate, hourlyRate, surcharge: trailerSpec.surcharge, cost: 0,
      truckUtilizationPct: utilization,
      buildings: buildingGroups,
    });
  }

  // Extra transporten: auto = ceil(5% × trucksPacked) maar ALLEEN voor trailers waar
  // modules gemixt zijn (>1 module per truck in minstens één patroon). Bij 1-module-
  // per-truck is het aantal exact en voegen extra ritten niets toe.
  // Handmatige override = één project-breed getal; dat wordt op de trailer met de meeste
  // trucks geplakt. Extras worden geprijsd tegen hetzelfde uurtarief × uren × toeslag.
  const extraTripsAuto = (project as any).extraTripsAuto !== false;
  if (extraTripsAuto) {
    for (const pt of perTrailerResult) {
      const hasMixed = pt.buildings.some((b) => b.patterns.some((p) => p.modulesPerTruck > 1));
      pt.trucksExtra = hasMixed ? Math.ceil(pt.trucksPacked * EXTRA_TRIPS_AUTO_PCT) : 0;
    }
  } else {
    const totalExtras = Math.max(0, project.extraTripsCount);
    // Zet alles op de trailer met de meeste trucks (fallback: eerste).
    if (perTrailerResult.length > 0) {
      const target = perTrailerResult.reduce((a, b) => (b.trucksPacked > a.trucksPacked ? b : a));
      target.trucksExtra = totalExtras;
    }
  }
  for (const pt of perTrailerResult) {
    pt.trucksTotal = pt.trucksPacked + pt.trucksExtra;
    pt.cost = pt.trucksTotal * pt.hoursPerTruck * pt.hourlyRate * pt.surcharge;
  }

  const trailerCost = perTrailerResult.reduce((s, p) => s + p.cost, 0);
  const totalTrucksAll = perTrailerResult.reduce((s, p) => s + p.trucksTotal, 0);
  const totalExtras = perTrailerResult.reduce((s, p) => s + p.trucksExtra, 0);
  const totalCost = trailerCost;

  if (legs.some((l) => l.source === "haversine")) {
    const uniqErrs = Array.from(new Set(legErrors)).join(" · ") || "onbekende reden";
    warnings.push({
      severity: "warn",
      message: `Route berekend met Haversine × 1,3 @ 70 km/h (fallback). Reden: ${uniqErrs}.`,
    });
  }

  return NextResponse.json({
    scope: buildingIdFilter ? "building" : "all",
    buildingName: buildingIdFilter ? (bldgs[0]?.name ?? null) : null,
    route: {
      totalDistanceKm: totalDistanceM / 1000,
      totalDurationHours: totalDurationS / 3600,
      legs,
      startAddress: DEFAULT_START,
      waypointAddress: project.waypointAddress ?? null,
      destinationAddress: project.destinationAddress,
      returnToStart: project.returnToStart,
    },
    trailers: perTrailerResult,
    totalTrucksAll,
    trailerCost,
    extras: { total: totalExtras, auto: extraTripsAuto, pct: EXTRA_TRIPS_AUTO_PCT },
    totalCost,
    warnings,
    assumptions: {
      maxTransportHeightM: MAX_TRANSPORT_HEIGHT_M,
      roofHeightExtraM: ROOF_HEIGHT_EXTRA_M,
      trailers: TRAILERS.map((t) => ({ id: t.id, label: t.label, floorHeight: t.floorHeight, maxLength: t.maxLength, maxWidth: t.maxWidth, surcharge: t.surcharge })),
      widthTariffs: WIDTH_TARIFFS.filter((t) => t.widthMax !== Infinity).concat([{ widthMax: 999, rate: WIDTH_TARIFFS[WIDTH_TARIFFS.length - 1].rate }]),
      loadTimeMinutes: project.loadTimeMinutes,
      workdayHours: project.workdayHours,
      detourFactor: DETOUR_FACTOR,
      hgvAvgKmh: HGV_AVG_KMH,
      extraTripsAutoPct: EXTRA_TRIPS_AUTO_PCT,
    },
  });
}
