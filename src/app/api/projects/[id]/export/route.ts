import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import {
  projects, buildings, modules as modulesTable, buildingInputs, overrides,
  materials, kengetalSets, kengetalRows, kengetalLabour,
  projectTransport, vehicleTypes, markupRows, labourRates, projectExtraLines,
} from "@/lib/db/schema";
import {
  calculateBuilding, calculateProject, computeLearningFactor, computeBvo, computeEngineering,
  DEFAULT_LABOUR_RATES, DEFAULT_EFFICIENCY, COST_GROUP_LABELS, BASIS_LABELS,
} from "@/lib/calculation";
import type { CostGroup } from "@/types";
import { STANDARD_CATEGORIES, CATEGORY_GROUP_ORDER, CATEGORY_GROUP_LABELS } from "@/lib/kengetal-categories";
import { eq } from "drizzle-orm";

// Kleuren (RGB in ARGB hex voor ExcelJS).
const COLOR = {
  brand:        "FF493EE5",
  brandSoft:    "FFE8EAFB",
  surface:      "FFF6F4EF",   // warm cream achtergrond
  totalsDark:   "FF181C1E",
  white:        "FFFFFFFF",
  bouwpakket:   "FFDCFCE7",   // emerald-100
  installateur: "FFFEF3C7",   // amber-100
  assemblagehal:"FFDBEAFE",   // sky-100
  derden:       "FFF1F5F9",   // slate-100
  staart:       "FFFAE8FF",   // fuchsia-100
  rowAlt:       "FFFAFAF9",
  headerText:   "FF0E1012",
  muted:        "FF6B7280",
  ghost:        "FFE5E7EB",
};

const GROUP_COLORS: Record<CostGroup, string> = {
  bouwpakket:   COLOR.bouwpakket,
  installateur: COLOR.installateur,
  assemblagehal:COLOR.assemblagehal,
  arbeid:       COLOR.rowAlt,
  derden:       COLOR.derden,
  hoofdaannemer:COLOR.rowAlt,
};

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, params.id) });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Disabled keys: door de begroting-UI meegegeven via ?disabled=key1,key2,...
  // Ondersteunde key-formaten: "grp:{group}", "cat:{group}:{category}",
  // "mat:{materialId}", "mk:{markupId}", "tr:{group}", "labgroup:{group}",
  // "lab:{group}:{inputLabel}". Elke "disabled" rij wordt overgeslagen in
  // de export — zo komt de Excel exact overeen met wat op het scherm staat.
  const _url = new URL(_req.url);
  const disabledParam = _url.searchParams.get("disabled") ?? "";
  const disabled = new Set<string>(disabledParam.split(",").map((s) => decodeURIComponent(s.trim())).filter(Boolean));
  // Sanity check is alleen voor interne validatie — niet meegeven aan klanten.
  // Opt-in via ?sanity=1.
  const includeSanity = _url.searchParams.get("sanity") === "1";
  const isOff = (key: string) => disabled.has(key);
  const isGroupOff = (g: string) => isOff(`grp:${g}`);
  const isCatOff = (g: string, cat: string) => isGroupOff(g) || isOff(`cat:${g}:${cat}`);
  const isMatOff = (g: string, cat: string, matId: string) => isCatOff(g, cat) || isOff(`mat:${matId}`);
  const isLabGroupOff = (g: string) => isGroupOff(g) || isOff(`labgroup:${g}`);
  const isLabEntryOff = (g: string, label: string) => isLabGroupOff(g) || isOff(`lab:${g}:${label}`);
  const isTransportOff = (g: string) => isGroupOff(g) || isOff(`tr:${g}`);
  const isMarkupOff = (group: string | null, mkId: string) => (group ? isGroupOff(group) : false) || isOff(`mk:${mkId}`);

  // Assemblagehal-transport (3D modulair): in de UI wordt dit via de transport-calc
  // endpoint opgehaald en door de client in ProjectContext gezet. Voor de server-
  // side export halen we het hier zelf op, anders ontbreekt die post volledig in
  // het Excel-bestand. Faalt de fetch → fallback 0.
  let autoAssemblageTransport = 0;
  try {
    const origin = new URL(_req.url).origin;
    const res = await fetch(`${origin}/api/transport/calculate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: _req.headers.get("cookie") ?? "",
      },
      body: JSON.stringify({ projectId: params.id }),
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.totalCost === "number") autoAssemblageTransport = body.totalCost;
    }
  } catch { /* stil falen — export gaat door met 0 */ }

  // ── Fetch alles ─────────────────────────────────────────────────
  const projBuildings = await db.select().from(buildings).where(eq(buildings.projectId, project.id)).orderBy(buildings.sortOrder);
  const allMaterials = await db.select().from(materials);
  const materialsMap = new Map(allMaterials.map((m) => [m.id, m]));
  const allSets = await db.select().from(kengetalSets);
  const allSetsById = new Map(allSets.map((s) => [s.id, s]));

  const setIdsUsed = new Set<string>();
  for (const b of projBuildings) if (b.kengetalSetId) setIdsUsed.add(b.kengetalSetId);
  if (project.defaultKengetalSetId) setIdsUsed.add(project.defaultKengetalSetId);

  const rowsBySet = new Map<string, typeof kengetalRows.$inferSelect[]>();
  const labourBySet = new Map<string, typeof kengetalLabour.$inferSelect[]>();
  for (const id of setIdsUsed) {
    rowsBySet.set(id, await db.select().from(kengetalRows).where(eq(kengetalRows.setId, id)));
    labourBySet.set(id, await db.select().from(kengetalLabour).where(eq(kengetalLabour.setId, id)));
  }

  const inputsByBuilding = new Map<string, typeof buildingInputs.$inferSelect[]>();
  const modsByBuilding = new Map<string, typeof modulesTable.$inferSelect[]>();
  const overridesByBuilding = new Map<string, typeof overrides.$inferSelect[]>();
  for (const b of projBuildings) {
    inputsByBuilding.set(b.id, await db.select().from(buildingInputs).where(eq(buildingInputs.buildingId, b.id)));
    modsByBuilding.set(b.id, await db.select().from(modulesTable).where(eq(modulesTable.buildingId, b.id)));
    overridesByBuilding.set(b.id, await db.select().from(overrides).where(eq(overrides.buildingId, b.id)));
  }

  const transportRaw = await db.select().from(projectTransport).where(eq(projectTransport.projectId, project.id));
  const allVt = await db.select().from(vehicleTypes);
  const transport = transportRaw.map((t) => ({ ...t, vehicleType: allVt.find((v) => v.id === t.vehicleTypeId) }));
  const mkRows = await db.select().from(markupRows).where(eq(markupRows.projectId, project.id));
  const extraLines = await db.select().from(projectExtraLines).where(eq(projectExtraLines.projectId, project.id));
  const rates = await db.query.labourRates.findFirst({ where: eq(labourRates.orgId, project.ownerOrgId) })
    ?? DEFAULT_LABOUR_RATES;

  // ── Calc ────────────────────────────────────────────────────────
  const effFor = (setId: string | null) => {
    const s = setId ? allSetsById.get(setId) : null;
    return s ? {
      vatHuidig: s.effVatHuidig, vatMax: s.effVatMax, lr: s.effLr, nRef: s.effNRef,
    } : DEFAULT_EFFICIENCY;
  };
  const buildingResults = projBuildings.map((b) => {
    const setId = b.kengetalSetId ?? project.defaultKengetalSetId ?? "";
    return calculateBuilding(
      b,
      inputsByBuilding.get(b.id) ?? [],
      modsByBuilding.get(b.id) ?? [],
      rowsBySet.get(setId) ?? [],
      labourBySet.get(setId) ?? [],
      materialsMap,
      overridesByBuilding.get(b.id) ?? [],
      rates,
      effFor(setId),
    );
  });
  const allModulesFlat = projBuildings.flatMap((b) =>
    (modsByBuilding.get(b.id) ?? []).map((m) => ({ ...m, count: m.count * b.count })),
  );
  const projLearn = computeLearningFactor(allModulesFlat, effFor(project.defaultKengetalSetId)).factor;

  // BVO per gebouw — zelfde berekening als in de UI (useCalculation).
  const gfaByBuildingId = new Map<string, number>();
  for (const br of buildingResults) {
    const setId = br.building.kengetalSetId ?? project.defaultKengetalSetId ?? "";
    const setName = allSetsById.get(setId)?.name ?? null;
    gfaByBuildingId.set(br.building.id, computeBvo(br.effectiveInputs, setName));
  }

  // Distinct moduletypes voor PM-formule (200 × n^0,434 + 50 × extra types).
  const moduleTypeKeys = new Set<string>();
  for (const b of projBuildings) {
    for (const m of (modsByBuilding.get(b.id) ?? [])) {
      moduleTypeKeys.add(`${m.lengthM}|${m.widthM}|${m.heightM}`);
    }
  }
  const calc = calculateProject(
    project, buildingResults, transport, mkRows, rates,
    "Module oppervlak", projLearn, gfaByBuildingId, autoAssemblageTransport,
    moduleTypeKeys.size, extraLines,
  );

  // ── Build Excel ─────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sustainer Calculator";
  wb.created = new Date();
  const ws = wb.addWorksheet("Begroting", {
    views: [{ state: "normal", showGridLines: false, zoomScale: 100 }],
    properties: { outlineLevelRow: 3 },
  });

  // Column layout (8 kolommen). Voor leaf-rijen (materialen / arbeid / transport):
  //   A: Omschrijving · B: Netto · C: Eh · D: Verlies% · E: Bruto (formule)
  //   F: Prijs · G: Bedrag (formule = E*F) · H: Toelichting
  // Voor markup-rijen:
  //   A: Naam · B: Waarde · D: Type · E: Basis · G: Bedrag (formule) · H: Groep
  ws.columns = [
    { width: 48 },  // A: Omschrijving
    { width: 12 },  // B: Netto
    { width: 8 },   // C: Eenheid
    { width: 10 },  // D: Verlies %
    { width: 12 },  // E: Bruto
    { width: 12 },  // F: Prijs
    { width: 16 },  // G: Bedrag €
    { width: 26 },  // H: Toelichting
  ];

  let row = 1;

  // ── Header band ─────────────────────────────────────────────────
  ws.mergeCells(`A${row}:H${row}`);
  const titleCell = ws.getCell(`A${row}`);
  titleCell.value = "SUSTAINER CALCULATOR — BEGROTING";
  titleCell.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.white } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalsDark } };
  ws.getRow(row).height = 22;
  row++;

  ws.mergeCells(`A${row}:H${row}`);
  const nameCell = ws.getCell(`A${row}`);
  nameCell.value = project.name;
  nameCell.font = { name: "Inter", size: 20, bold: true };
  nameCell.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(row).height = 30;
  row++;

  ws.mergeCells(`A${row}:H${row}`);
  const metaCell = ws.getCell(`A${row}`);
  const metaParts = [
    project.client,
    project.assemblyParty,
    project.status ? `fase ${project.status}` : null,
    `${projBuildings.length} gebouw${projBuildings.length === 1 ? "" : "en"}`,
    `${calc.totalModules} modules`,
    new Date().toLocaleDateString("nl-NL"),
  ].filter(Boolean);
  metaCell.value = metaParts.join(" · ");
  metaCell.font = { name: "Inter", size: 10, color: { argb: COLOR.muted } };
  metaCell.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(row).height = 18;
  row++;

  row++; // whitespace

  // ── KPI-band ────────────────────────────────────────────────────
  const kpiStart = row;
  const kpis: [string, number | string, string?][] = [
    ["Totaal excl. BTW", calc.totalExVat, "€"],
    ["Prijs per m² BVO", calc.pricePerM2, "€/m²"],
    ["BVO totaal", calc.totalGFA, "m²"],
    ["Modules", calc.totalModules, "stuks"],
  ];
  ws.mergeCells(`A${row}:H${row}`);
  ws.getCell(`A${row}`).value = "SAMENVATTING";
  ws.getCell(`A${row}`).font = { name: "Inter", size: 9, bold: true, color: { argb: COLOR.muted } };
  ws.getCell(`A${row}`).alignment = { indent: 1 };
  row++;
  for (const [label, value, unit] of kpis) {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { name: "Inter", size: 10 };
    ws.getCell(`A${row}`).alignment = { indent: 1 };
    ws.getCell(`G${row}`).value = value;
    ws.getCell(`G${row}`).font = { name: "Inter", size: 11, bold: typeof value === "number" };
    ws.getCell(`G${row}`).alignment = { horizontal: "right" };
    if (typeof value === "number") {
      ws.getCell(`G${row}`).numFmt = unit === "€" || unit === "€/m²" ? "€ #,##0" : "#,##0";
    }
    ws.getCell(`H${row}`).value = unit ?? "";
    ws.getCell(`H${row}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
    row++;
  }
  row++; // whitespace

  // ── Helpers ─────────────────────────────────────────────────────
  const setRow = (r: number, values: (string | number | null)[], opts?: {
    bold?: boolean; italic?: boolean; color?: string; fill?: string; indent?: number;
    numFmt?: string; borderTop?: boolean; borderBottom?: boolean; outlineLevel?: number;
    hidden?: boolean;
  }) => {
    const rowRef = ws.getRow(r);
    if (opts?.outlineLevel != null) rowRef.outlineLevel = opts.outlineLevel;
    if (opts?.hidden) rowRef.hidden = true;
    values.forEach((v, i) => {
      const cell = rowRef.getCell(i + 1);
      if (v !== null) cell.value = v;
      cell.font = {
        name: "Inter", size: 10,
        bold: opts?.bold,
        italic: opts?.italic,
        color: opts?.color ? { argb: opts.color } : undefined,
      };
      if (i === 0 && opts?.indent) cell.alignment = { indent: opts.indent };
      if (i > 0 && typeof v === "number") {
        cell.alignment = { horizontal: "right" };
      }
      if (opts?.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
      if (opts?.numFmt && typeof v === "number") cell.numFmt = opts.numFmt;
      if (opts?.borderTop) cell.border = { ...(cell.border ?? {}), top: { style: "thin", color: { argb: COLOR.ghost } } };
      if (opts?.borderBottom) cell.border = { ...(cell.border ?? {}), bottom: { style: "thin", color: { argb: COLOR.ghost } } };
    });
  };

  const EUR = "€ #,##0";
  const EUR2 = "€ #,##0.00";
  const NUM = "#,##0.0";
  const NUM2 = "#,##0.00";
  const PCT = "0.0%";

  // Formule-tracking per groep. In plaats van losse cel-refs te stapelen gebruiken
  // we SUBTOTAL(9, range) — deze functie telt alles binnen het bereik OP MAAR slaat
  // andere SUBTOTAL-cellen over. Daardoor kunnen subtotalen genest worden zonder
  // dubbel te tellen, en is het eindtotaal één simpele SUBTOTAL over het hele vel.
  //   directCellRef  → Subtotaal-rij van de groep (wordt door markup-formules gebruikt
  //                    als `group_direct` / `group_cumulative` basis).
  //   dataRowStart   → eerste rij in F waar leaf-data staat (materiaal-details, arbeid,
  //                    transport). Gebruikt om `SUBTOTAL(9, dataStart:dataEnd)` voor de
  //                    groeps-subtotaal en het totaal te bouwen.
  //   dataRowEnd     → laatste rij met leaf-data (exclusief de Subtotaal-rij zelf).
  const groupCells: Record<CostGroup, {
    directCellRef?: string;
    dataRowStart?: number;
    dataRowEnd?: number;
  }> = {
    bouwpakket:   {},
    installateur: {},
    assemblagehal:{},
    arbeid:       {},
    derden:       {},
    hoofdaannemer:{},
  };
  // Eerste rij met leaf-data in het hele vel — voor het eindtotaal.
  let firstDataRow: number | null = null;

  // ── Markup-tracking (voor inline rendering per groep + Pass B fill) ─
  const sortedMarkups = [...mkRows]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((m) => !isMarkupOff(m.costGroup, m.id));
  const markupAmountCells: Record<string, string[]> = {
    bouwpakket: [], installateur: [], assemblagehal: [], arbeid: [], derden: [], hoofdaannemer: [], _project: [],
  };
  // Markups die later (na alle groepen) moeten worden gepatcht omdat ze afhangen
  // van subtotalen die op het moment van inline-render nog niet bekend waren.
  const tedRowNums: { rowNum: number; group: string; pct: number }[] = [];
  const grandTotalRowNums: { rowNum: number; pct: number }[] = [];
  const bpPlusAsmRowNums: { rowNum: number; pct: number }[] = [];

  // Helper: render markups voor één groep, inline na de directe-kosten subtotal.
  // Returnt het laatste rij-nr (voor "Subtotaal incl. opslagen").
  const renderMarkupsForGroup = (groupKey: CostGroup, groupDirectRef: string): number => {
    const groupMarkups = sortedMarkups.filter((m) => m.costGroup === groupKey);
    let lastMarkupRow = -1;
    for (const m of groupMarkups) {
      const typeLabel = m.type === "percentage" ? "%" : m.type === "per_m2" ? "€/m²" : "vast";
      const basisLabel = m.type === "percentage" ? BASIS_LABELS[m.basis] ?? "—" : "—";
      const rowNum = row;
      // A=naam, B=waarde, C=leeg, D=type, E=basis, F=leeg, G=bedrag (formule), H=leeg
      setRow(rowNum, [m.name, m.value, "", typeLabel, basisLabel, null, null, null], { indent: 2 });
      ws.getCell(`B${rowNum}`).numFmt = m.type === "percentage" ? "0.00" : m.type === "per_m2" ? EUR2 : EUR;
      ws.getCell(`D${rowNum}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
      ws.getCell(`E${rowNum}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };

      const gfaRef = `$G$${kpiStart + 3}`;
      let amountFormula: string;
      if (m.type === "percentage") {
        if (m.basis === "group_direct") {
          amountFormula = `${groupDirectRef}*B${rowNum}/100`;
        } else if (m.basis === "group_cumulative") {
          // Subtotaal van de groep + voorgaande non-TED markups in dezelfde groep.
          const prev = [...(markupAmountCells[groupKey] ?? [])];
          amountFormula = `(${groupDirectRef}${prev.length > 0 ? "+" + prev.join("+") : ""})*B${rowNum}/100`;
        } else if (m.basis === "inkoop_derden") {
          amountFormula = `(${groupCells.derden.directCellRef ?? "0"})*B${rowNum}/100`;
        } else if (m.basis === "totaal_ex_derden") {
          amountFormula = "0"; // pass B
          tedRowNums.push({ rowNum, group: groupKey, pct: m.value });
        } else if (m.basis === "bouwpakket_plus_assemblage") {
          amountFormula = "0"; // pass B
          bpPlusAsmRowNums.push({ rowNum, pct: m.value });
        } else if (m.basis === "grand_total") {
          amountFormula = "0"; // pass B
          grandTotalRowNums.push({ rowNum, pct: m.value });
        } else {
          amountFormula = "0";
        }
      } else if (m.type === "per_m2") {
        amountFormula = `B${rowNum}*${gfaRef}`;
      } else {
        amountFormula = `B${rowNum}`;
      }
      ws.getCell(`G${rowNum}`).value = { formula: amountFormula };
      ws.getCell(`G${rowNum}`).numFmt = EUR;
      ws.getCell(`G${rowNum}`).font = { name: "Inter", size: 10, bold: true };

      markupAmountCells[groupKey].push(`G${rowNum}`);
      lastMarkupRow = rowNum;
      row++;
    }
    return lastMarkupRow;
  };

  // ── Render een groep ────────────────────────────────────────────
  // Structuur: group-header → kolomkoppen → categorie-SUBTOTAL (met geneste leaves)
  //   → arbeid-SUBTOTAL (leaves) → transport-SUBTOTAL (leaves) → Subtotaal-groep.
  // De Subtotaal-rij is zelf SUBTOTAL(9, groupDataStart:groupDataEnd). Omdat SUBTOTAL
  // nested SUBTOTAL-cellen overslaat, telt dat alleen de leaf-cellen — precies wat we
  // willen voor de directe kosten van de groep.
  const renderGroup = (groupKey: CostGroup, displayLabel: string, fillColor: string) => {
    const g = calc.groups.find((x) => x.group === groupKey);
    if (!g || (g.rows.length === 0 && g.laborCost === 0 && g.transportCost === 0 && g.totalMarkups === 0)) return;
    if (isGroupOff(groupKey)) return;

    // Group header bar.
    ws.mergeCells(`A${row}:H${row}`);
    const hdr = ws.getCell(`A${row}`);
    hdr.value = displayLabel.toUpperCase();
    hdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
    hdr.alignment = { vertical: "middle", indent: 1 };
    hdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
    ws.getRow(row).height = 22;
    row++;

    // Column headers.
    setRow(row, ["Post", "Netto", "Eh.", "Verlies %", "Bruto", "Prijs/eh", "Bedrag", "Toelichting"], {
      bold: true, color: COLOR.muted, fill: COLOR.rowAlt,
      indent: 1, borderBottom: true,
    });
    ["B", "C", "D", "E", "F", "G"].forEach((col) => {
      ws.getCell(`${col}${row}`).alignment = { horizontal: "right" };
    });
    row++;

    const groupDataStart = row; // eerste rij waar leaf- of category-SUBTOTAL staat

    // Materials grouped by category (each category collapsible).
    const byCat = new Map<string, typeof g.rows>();
    for (const r of g.rows) {
      const list = byCat.get(r.material.category) ?? [];
      list.push(r); byCat.set(r.material.category, list);
    }
    for (const [cat, matRows] of byCat) {
      if (isCatOff(groupKey, cat)) continue;
      // Filter materialen die individueel uitgevinkt zijn.
      const enabledMats = matRows.filter((r) => !isMatOff(groupKey, cat, r.material.id));
      if (enabledMats.length === 0) continue;
      const catHeaderRow = row;
      row++;

      const detailStart = row;
      for (const r of enabledMats) {
        const name = r.material.description
          ? `${r.material.name} — ${r.material.description}`
          : r.material.name;
        const rowNum = row;
        ws.getRow(rowNum).outlineLevel = 1;
        ws.getRow(rowNum).hidden = true;
        // A=naam, B=netto, C=eh, D=verlies%, E=bruto (formule), F=prijs, G=bedrag (formule), H=toelichting
        setRow(rowNum, [name, r.netto, r.material.unit, r.loss, null, r.price, null, null], { indent: 2 });
        ws.getCell(`E${rowNum}`).value = { formula: `B${rowNum}*(1+D${rowNum})` };
        ws.getCell(`G${rowNum}`).value = { formula: `E${rowNum}*F${rowNum}` };
        ws.getCell(`B${rowNum}`).numFmt = NUM;
        ws.getCell(`D${rowNum}`).numFmt = PCT;
        ws.getCell(`E${rowNum}`).numFmt = NUM;
        ws.getCell(`F${rowNum}`).numFmt = r.price <= 10 && r.price > 0 ? EUR2 : EUR;
        ws.getCell(`G${rowNum}`).numFmt = EUR;
        row++;
      }
      const detailEnd = row - 1;

      // Categorie-subtotaal via SUBTOTAL — slaat zichzelf automatisch over als
      // deze rij in een bovenliggende SUBTOTAL-range voorkomt.
      setRow(catHeaderRow, [cat, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`G${catHeaderRow}`).value = { formula: `SUBTOTAL(9,G${detailStart}:G${detailEnd})` };
      ws.getCell(`G${catHeaderRow}`).numFmt = EUR;
      ws.getCell(`G${catHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    }

    // Labour / bewerking entries.
    const labourEntries: { e: typeof calc.buildings[number]["labourEntries"][number]; mult: number }[] = [];
    if (!isLabGroupOff(groupKey)) {
      for (const br of calc.buildings) {
        const mult = br.building.count;
        for (const e of br.labourEntries) {
          if (e.costGroup !== groupKey) continue;
          if (isLabEntryOff(groupKey, e.inputLabel)) continue;
          labourEntries.push({ e, mult });
        }
      }
    }
    const showProjectMgmt = groupKey === "assemblagehal" && calc.projectmgmtCost > 0
      && !isLabGroupOff(groupKey) && !isLabEntryOff(groupKey, "Projectmanagement");
    if (labourEntries.length > 0 || showProjectMgmt) {
      const labHeaderRow = row;
      row++;
      const labStart = row;

      const collapse = (l: string) => l.replace(/^Module Aant (BG|Dak|Tussenvd)(\s—|$)/, "Module Aant$2");
      const agg = new Map<string, { qty: number; rate: number; cost: number; unit: string }>();
      for (const { e, mult } of labourEntries) {
        const key = collapse(e.inputLabel);
        const unit = groupKey === "bouwpakket" ? "m³" : "u";
        const existing = agg.get(key);
        const addQty = e.totalHours * mult;
        const addCost = e.cost * mult;
        if (existing) {
          existing.qty += addQty;
          existing.cost += addCost;
        } else {
          agg.set(key, { qty: addQty, rate: 0, cost: addCost, unit });
        }
      }
      if (groupKey === "bouwpakket") {
        const gez = { qty: 0, cost: 0 };
        const cnc = { qty: 0, cost: 0 };
        const steen = { qty: 0, cost: 0 };
        const overige = { qty: 0, cost: 0 };
        for (const [label, v] of agg) {
          if (label.endsWith("— gezaagd")) { gez.qty += v.qty; gez.cost += v.cost; }
          else if (label.endsWith("— CNC simpel") || label.endsWith("— CNC complex")) { cnc.qty += v.qty; cnc.cost += v.cost; }
          else if (label.endsWith("— steenachtig")) { steen.qty += v.qty; steen.cost += v.cost; }
          else { overige.qty += v.qty; overige.cost += v.cost; }
        }
        agg.clear();
        if (gez.cost > 0)     agg.set("Gezaagd",     { qty: gez.qty,     rate: 0, cost: gez.cost,     unit: "m³" });
        if (cnc.cost > 0)     agg.set("CNC",         { qty: cnc.qty,     rate: 0, cost: cnc.cost,     unit: "m³" });
        if (steen.cost > 0)   agg.set("Steenachtig", { qty: steen.qty,   rate: 0, cost: steen.cost,   unit: "m³" });
        if (overige.cost > 0) agg.set("Overig",      { qty: overige.qty, rate: 0, cost: overige.cost, unit: "m³" });
      }
      // Recompute rate als gewogen gemiddelde — `qty * rate = cost` moet exact
      // kloppen, anders wijkt de Excel-formule (B*F) af van de echte cost.
      for (const v of agg.values()) {
        v.rate = v.qty > 0 ? v.cost / v.qty : 0;
      }
      const entries = Array.from(agg.entries()).sort(([, a], [, b]) => b.cost - a.cost);
      for (const [label, v] of entries) {
        const rowNum = row;
        ws.getRow(rowNum).outlineLevel = 1;
        ws.getRow(rowNum).hidden = true;
        // A=label, B=qty, C=unit, D/E leeg (geen verlies op arbeid), F=rate, G=bedrag (B*F), H leeg
        setRow(rowNum, [label, v.qty, v.unit, null, null, v.rate, null, null], { indent: 2 });
        ws.getCell(`G${rowNum}`).value = { formula: `B${rowNum}*F${rowNum}` };
        ws.getCell(`B${rowNum}`).numFmt = NUM;
        ws.getCell(`F${rowNum}`).numFmt = v.rate <= 10 && v.rate > 0 ? EUR2 : EUR;
        ws.getCell(`G${rowNum}`).numFmt = EUR;
        row++;
      }

      // Module-gedreven arbeid (assemblagehal). Project-niveau PM (vaste formule)
      // landt hier; arbeid-buiten op project-niveau is afgeschaft (verloopt nu via
      // per-kengetal `arbeidBuitenHrsPerInput`, dus het zit al in de aggregaties hierboven).
      if (showProjectMgmt) {
        const rowNum = row;
        ws.getRow(rowNum).outlineLevel = 1;
        ws.getRow(rowNum).hidden = true;
        const tooltip = `200 × ${calc.totalModules}^0,434 + 50 × ${Math.max(0, calc.distinctModuleTypes - 1)} (PM-formule)`;
        // A=label, B=uren, C=u, D/E leeg, F=tarief, G=bedrag (formule), H=toelichting
        setRow(rowNum, ["Projectmanagement", calc.projectmgmtHours, "u", null, null, rates.projectmgmtHourlyRate, null, tooltip], { indent: 2 });
        ws.getCell(`G${rowNum}`).value = { formula: `B${rowNum}*F${rowNum}` };
        ws.getCell(`B${rowNum}`).numFmt = NUM;
        ws.getCell(`F${rowNum}`).numFmt = EUR;
        ws.getCell(`G${rowNum}`).numFmt = EUR;
        row++;
      }

      const labEnd = row - 1;
      const title = groupKey === "bouwpakket" ? "Bouwpakket-bewerking" : "Arbeid";
      setRow(labHeaderRow, [title, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`G${labHeaderRow}`).value = { formula: `SUBTOTAL(9,G${labStart}:G${labEnd})` };
      ws.getCell(`G${labHeaderRow}`).numFmt = EUR;
      ws.getCell(`G${labHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    }

    // Transport Polen (bouwpakket) of manueel transport — alleen als niet uitgevinkt.
    if (groupKey === "bouwpakket" && (calc.autoTransport.inboundCost + calc.autoTransport.outboundCost) > 0 && !isTransportOff(groupKey)) {
      const tpHeaderRow = row;
      row++;
      const tpStart = row;

      const inbRow = row;
      ws.getRow(inbRow).outlineLevel = 1;
      ws.getRow(inbRow).hidden = true;
      // A=label, B=trucks, C="truck(s)", D/E leeg, F=prijs/truck, G=bedrag, H=tooltip
      setRow(inbRow, [
        "→ VMG Polen (Lodz) — I-joists",
        calc.autoTransport.inboundTrucks, "truck(s)", null, null, 700, null,
        `${calc.autoTransport.inboundM3.toFixed(1)} m³ / 40 m³ per truck`,
      ], { indent: 2 });
      ws.getCell(`G${inbRow}`).value = { formula: `B${inbRow}*F${inbRow}` };
      ws.getCell(`F${inbRow}`).numFmt = EUR;
      ws.getCell(`G${inbRow}`).numFmt = EUR;
      row++;

      const outRow = row;
      ws.getRow(outRow).outlineLevel = 1;
      ws.getRow(outRow).hidden = true;
      setRow(outRow, [
        "← Lodz → Raamsdonksveer — bouwpakket",
        calc.autoTransport.outboundTrucks, "truck(s)", null, null, 1600, null,
        `${calc.autoTransport.outboundM3.toFixed(1)} m³ / 30 m³ per truck`,
      ], { indent: 2 });
      ws.getCell(`G${outRow}`).value = { formula: `B${outRow}*F${outRow}` };
      ws.getCell(`F${outRow}`).numFmt = EUR;
      ws.getCell(`G${outRow}`).numFmt = EUR;
      row++;

      const tpEnd = row - 1;
      setRow(tpHeaderRow, ["Transport Polen", null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`G${tpHeaderRow}`).value = { formula: `SUBTOTAL(9,G${tpStart}:G${tpEnd})` };
      ws.getCell(`G${tpHeaderRow}`).numFmt = EUR;
      ws.getCell(`G${tpHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    } else if (g.transportCost > 0 && !isTransportOff(groupKey)) {
      const trRow = row;
      setRow(trRow, ["Transport", null, null, null, null, null, g.transportCost, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`G${trRow}`).numFmt = EUR;
      row++;
    }

    // Handmatige posten (per project) — tellen op bij de directe kosten van deze
    // groep. Disabled-keys (xl:{id}) worden gerespecteerd via de UI-export.
    const groupExtras = extraLines.filter((x) => x.costGroup === groupKey && !isOff(`xl:${x.id}`));
    if (groupExtras.length > 0) {
      const xlHeaderRow = row;
      row++;
      const xlStart = row;
      for (const x of groupExtras) {
        const rn = row;
        ws.getRow(rn).outlineLevel = 1;
        ws.getRow(rn).hidden = true;
        // A=desc, B=qty, C=eh, D-E leeg, F=prijs, G=bedrag (=B*F), H leeg
        setRow(rn, [x.description || "Handmatige post", x.quantity, x.unit, null, null, x.pricePerUnit, null, null], { indent: 2 });
        ws.getCell(`G${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws.getCell(`B${rn}`).numFmt = NUM;
        ws.getCell(`F${rn}`).numFmt = EUR;
        ws.getCell(`G${rn}`).numFmt = EUR;
        row++;
      }
      const xlEnd = row - 1;
      setRow(xlHeaderRow, ["Handmatige posten", null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`G${xlHeaderRow}`).value = { formula: `SUBTOTAL(9,G${xlStart}:G${xlEnd})` };
      ws.getCell(`G${xlHeaderRow}`).numFmt = EUR;
      ws.getCell(`G${xlHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    }

    const groupDataEnd = row - 1;
    const hasLeafData = groupDataEnd >= groupDataStart;
    if (hasLeafData && firstDataRow === null) firstDataRow = groupDataStart;
    groupCells[groupKey].dataRowStart = groupDataStart;
    groupCells[groupKey].dataRowEnd = groupDataEnd;

    // Subtotaal-rij = SUBTOTAL(9, range). Slaat geneste categorie-/arbeid-/transport-
    // SUBTOTAL cellen over → somt alleen de leaves op (= direct cost). Als de groep
    // geen leaf-data heeft (alleen markups — typisch voor hoofdaannemer) geven we
    // een harde 0 zodat markup-formules die de directRef gebruiken niets onzinnigs
    // doen.
    const subtotalRow = row;
    setRow(subtotalRow, [`Subtotaal ${displayLabel.toLowerCase()} (direct)`, null, null, null, null, null, null, null], {
      bold: true, indent: 1, borderTop: true,
    });
    ws.getCell(`G${subtotalRow}`).value = hasLeafData
      ? { formula: `SUBTOTAL(9,G${groupDataStart}:G${groupDataEnd})` }
      : 0;
    ws.getCell(`G${subtotalRow}`).numFmt = EUR;
    ws.getCell(`G${subtotalRow}`).font = { name: "Inter", size: 10, bold: true };
    groupCells[groupKey].directCellRef = `G${subtotalRow}`;
    row++;

    // Inline markups voor deze groep (Marge, AK, W&R, etc.) — direct na het
    // subtotaal-direct, voor de "Subtotaal incl. opslagen"-rij.
    const directRef = `G${subtotalRow}`;
    const lastMarkupRow = renderMarkupsForGroup(groupKey, directRef);

    // Subtotaal incl. opslagen — alleen als er markups in deze groep zaten.
    // SUBTOTAL(9, range) skipt zichzelf-genest, dus bevat exact: leaves + markups
    // (alle direct-/cat-/lab-/transport-SUBTOTAL-cellen worden overgeslagen).
    // Hierdoor telt het grand-total deze rij niet dubbel.
    if (lastMarkupRow > 0) {
      const inclRow = row;
      setRow(inclRow, [`Subtotaal ${displayLabel.toLowerCase()} (incl. opslagen)`, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.brandSoft,
      });
      ws.getCell(`G${inclRow}`).value = {
        formula: `SUBTOTAL(9,G${groupDataStart}:G${lastMarkupRow})`,
      };
      ws.getCell(`G${inclRow}`).numFmt = EUR;
      ws.getCell(`G${inclRow}`).font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.brand } };
      row++;
    }
  };

  // Render alle kostengroepen (volgorde overeenkomstig UI).
  renderGroup("bouwpakket",    COST_GROUP_LABELS.bouwpakket,    GROUP_COLORS.bouwpakket);
  row++;
  renderGroup("installateur",  COST_GROUP_LABELS.installateur,  GROUP_COLORS.installateur);
  row++;
  renderGroup("assemblagehal", COST_GROUP_LABELS.assemblagehal, GROUP_COLORS.assemblagehal);
  row++;
  renderGroup("derden",        COST_GROUP_LABELS.derden,        GROUP_COLORS.derden);
  renderGroup("hoofdaannemer", COST_GROUP_LABELS.hoofdaannemer, GROUP_COLORS.hoofdaannemer);
  row++;

  // ── Pass B: vul placeholders in (TED, grand_total, bp+asm) ─────
  // Markups zijn inline per groep gerenderd. Sommige formules wachten op
  // referenties die pas na alle groepen bekend zijn.
  const bpRef  = groupCells.bouwpakket.directCellRef  ?? "0";
  const insRef = groupCells.installateur.directCellRef ?? "0";
  const asmRef = groupCells.assemblagehal.directCellRef ?? "0";
  const derRef = groupCells.derden.directCellRef       ?? "0";
  const tedRowNumSet = new Set(tedRowNums.map((t) => `G${t.rowNum}`));

  for (const { rowNum, group, pct } of tedRowNums) {
    const allBpInsAsmMk = [
      ...markupAmountCells.bouwpakket,
      ...markupAmountCells.installateur,
      ...markupAmountCells.assemblagehal,
    ];
    const nonTedBpInsAsmMk = allBpInsAsmMk.filter((cellRef) => !tedRowNumSet.has(cellRef));
    const markupsPart = group === "hoofdaannemer" ? allBpInsAsmMk : nonTedBpInsAsmMk;
    const terms = [bpRef, insRef, asmRef, ...markupsPart].filter((t) => t && t !== "0");
    ws.getCell(`G${rowNum}`).value = { formula: `(${terms.join("+")})*B${rowNum}/100` };
  }
  if (bpPlusAsmRowNums.length > 0) {
    const terms = [
      bpRef, asmRef,
      ...markupAmountCells.bouwpakket,
      ...markupAmountCells.assemblagehal,
    ].filter((t) => t && t !== "0");
    for (const { rowNum } of bpPlusAsmRowNums) {
      ws.getCell(`G${rowNum}`).value = { formula: `(${terms.join("+")})*B${rowNum}/100` };
    }
  }
  if (grandTotalRowNums.length > 0) {
    const markupParts = [
      ...markupAmountCells.bouwpakket,
      ...markupAmountCells.installateur,
      ...markupAmountCells.assemblagehal,
      ...markupAmountCells.derden,
    ];
    const terms = [bpRef, insRef, asmRef, derRef, ...markupParts].filter((t) => t && t !== "0");
    const baseExpr = terms.join("+");
    for (const { rowNum } of grandTotalRowNums) {
      ws.getCell(`G${rowNum}`).value = { formula: `(${baseExpr})*B${rowNum}/100` };
    }
  }

  // ── Engineering ───────────────────────────────────────────────
  // Sustainer engineering fee + Constructie, per gebouw × building.count.
  // Wordt in de website-begroting als aparte sectie boven het grand-total getoond.
  const engineeringRows: number[] = [];
  const engStart = row;
  if (!isOff("grp:engineering")) {
    let engHasData = false;
    for (const br of buildingResults) {
      const mods = modsByBuilding.get(br.building.id) ?? [];
      const bvo = gfaByBuildingId.get(br.building.id) ?? 0;
      const area = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
      const bgg = br.effectiveInputs["_opp_begane_grond"] ?? 0;
      const floorsRaw = area > 0 && bgg > 0 ? area / bgg : 1;
      const floors = Math.abs(floorsRaw - Math.round(floorsRaw)) < 0.1 ? Math.round(floorsRaw) : floorsRaw;
      const eng = computeEngineering(mods, bvo, floors);
      const mult = br.building.count;
      const feeCost = eng.engineeringTotal * mult;
      const conCost = eng.constructieTotal * mult;
      if (feeCost <= 0 && conCost <= 0) continue;
      if (!engHasData) {
        // Header bij eerste rij.
        ws.mergeCells(`A${row}:H${row}`);
        const eHdr = ws.getCell(`A${row}`);
        eHdr.value = "ENGINEERING";
        eHdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
        eHdr.alignment = { vertical: "middle", indent: 1 };
        eHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.brandSoft } };
        ws.getRow(row).height = 22;
        row++;
        engHasData = true;
      }
      if (feeCost > 0) {
        const rn = row;
        setRow(rn, [`Sustainer fee — ${br.building.name}`, eng.engineeringPerM2, "€/m²", null, null, bvo * mult, null, null], { indent: 2 });
        ws.getCell(`G${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws.getCell(`B${rn}`).numFmt = EUR;
        ws.getCell(`F${rn}`).numFmt = NUM;
        ws.getCell(`G${rn}`).numFmt = EUR;
        engineeringRows.push(rn);
        row++;
      }
      if (conCost > 0) {
        const rn = row;
        setRow(rn, [`Constructieberekening — ${br.building.name}`, eng.constructiePerM2, "€/m²", null, null, bvo * mult, null, null], { indent: 2 });
        ws.getCell(`G${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws.getCell(`B${rn}`).numFmt = EUR;
        ws.getCell(`F${rn}`).numFmt = NUM;
        ws.getCell(`G${rn}`).numFmt = EUR;
        engineeringRows.push(rn);
        row++;
      }
    }
    if (engHasData && engineeringRows.length > 0) {
      const engSubRow = row;
      setRow(engSubRow, ["Subtotaal engineering", null, null, null, null, null, null, null], {
        bold: true, indent: 1, borderTop: true, fill: COLOR.brandSoft,
      });
      // SUBTOTAL over de eng-leaf rijen — net als alle andere subtotalen.
      const firstEng = engineeringRows[0];
      const lastEng = engineeringRows[engineeringRows.length - 1];
      ws.getCell(`G${engSubRow}`).value = { formula: `SUBTOTAL(9,G${firstEng}:G${lastEng})` };
      ws.getCell(`G${engSubRow}`).numFmt = EUR;
      ws.getCell(`G${engSubRow}`).font = { name: "Inter", size: 10, bold: true };
      row++;
    }
  }
  const engEnd = row - 1;
  const mkEnd = row - 1;

  row++;
  // ── Grand total ────────────────────────────────────────────────
  ws.mergeCells(`A${row}:H${row}`);
  const gtHdrCell = ws.getCell(`A${row}`);
  gtHdrCell.value = "TOTAAL EXCL. BTW";
  gtHdrCell.font = { name: "Inter", size: 14, bold: true, color: { argb: COLOR.white } };
  gtHdrCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalsDark } };
  gtHdrCell.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(row).height = 26;
  row++;

  const grandTotalRow = row;
  // SUBTOTAL(9, range) telt álle cellen in het bereik op MAAR slaat zelf-genest
  // SUBTOTAL-cellen over. Zo telt het:
  //   • alle leaf-rijen (materiaal-details, arbeid-details, transport-details)
  //   • alle markup-rijen (gewone formules, geen SUBTOTAL)
  // Maar overslaat:
  //   • categorie-subtotalen, arbeid/transport-parents
  //   • per-groep "Subtotaal ..."-rijen
  // → geen dubbeltelling mogelijk, ongeacht hoeveel lagen genest.
  const grandStart = firstDataRow ?? grandTotalRow;
  const grandEnd = mkEnd;
  const grandFormula = `SUBTOTAL(9,G${grandStart}:G${grandEnd})`;
  setRow(grandTotalRow, ["Totaal project", null, null, null, null, null, null, null], {
    bold: true, color: COLOR.brand, indent: 1, fill: COLOR.brandSoft,
  });
  ws.getCell(`G${grandTotalRow}`).value = { formula: grandFormula };
  ws.getCell(`G${grandTotalRow}`).numFmt = EUR;
  ws.getCell(`G${grandTotalRow}`).font = { name: "Inter", size: 14, bold: true, color: { argb: COLOR.brand } };
  ws.getCell(`G${grandTotalRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.brandSoft } };
  ws.getRow(grandTotalRow).height = 26;
  row++;

  // Overschrijf KPI's (bovenaan) met formules zodat ze meebewegen met bewerkingen.
  ws.getCell(`G${kpiStart + 1}`).value = { formula: `G${grandTotalRow}` };
  ws.getCell(`G${kpiStart + 1}`).numFmt = EUR;
  ws.getCell(`G${kpiStart + 2}`).value = { formula: `IFERROR(G${grandTotalRow}/G${kpiStart + 3},0)` };
  ws.getCell(`G${kpiStart + 2}`).numFmt = EUR;

  // Prijs per m² BVO als afgeleide
  const pricePerM2Row = row;
  const gfaRefBvo = `$G$${kpiStart + 3}`;
  setRow(pricePerM2Row, ["Prijs per m² BVO", null, null, null, null, null, null, null], {
    italic: true, color: COLOR.muted, indent: 1,
  });
  ws.getCell(`G${pricePerM2Row}`).value = { formula: `IFERROR(G${grandTotalRow}/${gfaRefBvo},0)` };
  ws.getCell(`G${pricePerM2Row}`).numFmt = EUR;
  row++;

  // ── Sanity check — server-side tracker ────────────────────────
  // Berekent server-side EXACT wat Excel zou moeten optellen, gegeven dezelfde
  // disabled-state filtering. JS-replica van de SUBTOTAL-formules: telt alle
  // leaves op (materialen / arbeid / transport / extras / engineering) per groep,
  // dan markup-bedragen via dezelfde TED/grand_total/bp+asm logica als calc.ts.
  //
  // Mismatch = formule-bug. Match = Excel formules berekenen wat ze moeten.
  type GroupKey = "bouwpakket" | "installateur" | "assemblagehal" | "derden";
  // Granulair: per groep × per component zodat we kunnen pinpointen waar Excel
  // afwijkt. directs[g] = som van alle componenten.
  const trackerComp: Record<GroupKey, { mat: number; lab: number; trans: number; extra: number; pm: number }> = {
    bouwpakket:   { mat: 0, lab: 0, trans: 0, extra: 0, pm: 0 },
    installateur: { mat: 0, lab: 0, trans: 0, extra: 0, pm: 0 },
    assemblagehal:{ mat: 0, lab: 0, trans: 0, extra: 0, pm: 0 },
    derden:       { mat: 0, lab: 0, trans: 0, extra: 0, pm: 0 },
  };
  const trackerDirects: Record<GroupKey, number> = { bouwpakket: 0, installateur: 0, assemblagehal: 0, derden: 0 };
  const computeTrackerDirect = () => {
    for (const g of calc.groups) {
      const gk = g.group as string;
      if (!(gk in trackerDirects)) continue;
      if (isGroupOff(gk)) continue;
      for (const r of g.rows) {
        if (isMatOff(gk, r.material.category, r.material.id)) continue;
        trackerComp[gk as GroupKey].mat += r.materialCost;
      }
    }
    for (const br of calc.buildings) {
      const mult = br.building.count;
      for (const e of br.labourEntries) {
        const gk = e.costGroup as string;
        if (!(gk in trackerDirects)) continue;
        if (isLabGroupOff(gk) || isLabEntryOff(gk, e.inputLabel)) continue;
        trackerComp[gk as GroupKey].lab += e.cost * mult;
      }
    }
    if (!isLabGroupOff("assemblagehal") && !isLabEntryOff("assemblagehal", "Projectmanagement")) {
      trackerComp.assemblagehal.pm += calc.projectmgmtCost;
    }
    if (!isTransportOff("bouwpakket")) {
      trackerComp.bouwpakket.trans += (calc.autoTransport.inboundCost + calc.autoTransport.outboundCost);
    }
    for (const g of calc.groups) {
      const gk = g.group as string;
      if (gk === "bouwpakket") continue;
      if (!(gk in trackerDirects)) continue;
      if (isTransportOff(gk)) continue;
      trackerComp[gk as GroupKey].trans += g.transportCost;
    }
    for (const x of extraLines) {
      const gk = x.costGroup as string;
      if (!(gk in trackerDirects)) continue;
      if (isOff(`xl:${x.id}`)) continue;
      trackerComp[gk as GroupKey].extra += (x.quantity ?? 0) * (x.pricePerUnit ?? 0);
    }
    // Roll-up.
    for (const gk of Object.keys(trackerDirects) as GroupKey[]) {
      const c = trackerComp[gk];
      trackerDirects[gk] = c.mat + c.lab + c.trans + c.extra + c.pm;
    }
  };
  computeTrackerDirect();

  // Engineering totaal — toegevoegd los van directs.
  let engTotal = 0;
  for (const br of buildingResults) {
    const mods = modsByBuilding.get(br.building.id) ?? [];
    const bvo = gfaByBuildingId.get(br.building.id) ?? 0;
    const area = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
    const bgg = br.effectiveInputs["_opp_begane_grond"] ?? 0;
    const floorsRaw = area > 0 && bgg > 0 ? area / bgg : 1;
    const floors = Math.abs(floorsRaw - Math.round(floorsRaw)) < 0.1 ? Math.round(floorsRaw) : floorsRaw;
    const eng = computeEngineering(mods, bvo, floors);
    engTotal += (eng.engineeringTotal + eng.constructieTotal) * br.building.count;
  }

  // Markup-bedragen — zelfde 2-pass logica als de Excel-formules.
  type MarkupCalc = { id: string; group: string; basis: string; type: string; pct: number; amount: number };
  const trackerMarkups: MarkupCalc[] = [];
  const sortedMk = [...mkRows]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((m) => !isMarkupOff(m.costGroup, m.id));
  // Pass 1: simpele bases
  for (const m of sortedMk) {
    const gk = (m.costGroup ?? "") as GroupKey;
    let amount = 0;
    if (m.type === "percentage") {
      const pct = m.value / 100;
      if (m.basis === "group_direct") {
        amount = (trackerDirects[gk] ?? 0) * pct;
      } else if (m.basis === "group_cumulative") {
        const prev = trackerMarkups
          .filter((x) => x.group === gk && !["totaal_ex_derden", "grand_total", "bouwpakket_plus_assemblage"].includes(x.basis))
          .reduce((s, x) => s + x.amount, 0);
        amount = ((trackerDirects[gk] ?? 0) + prev) * pct;
      } else if (m.basis === "inkoop_derden") {
        amount = (trackerDirects.derden ?? 0) * pct;
      }
    } else if (m.type === "fixed") {
      amount = m.value;
    }
    trackerMarkups.push({ id: m.id, group: m.costGroup ?? "", basis: m.basis, type: m.type, pct: m.value / 100, amount });
  }
  // Pass 2A: TED-markups IN bp/inst/asm (basis = bp+inst+asm + non-TED markups
  //          in those 3). Onafhankelijk van andere TED's. Dependency: alleen Pass 1.
  const tedSet = new Set(trackerMarkups.filter((x) => x.basis === "totaal_ex_derden").map((x) => x.id));
  for (const m of trackerMarkups) {
    if (m.type !== "percentage" || m.basis !== "totaal_ex_derden" || m.group === "hoofdaannemer") continue;
    const allMk = trackerMarkups.filter((x) => ["bouwpakket","installateur","assemblagehal"].includes(x.group));
    const nonTed = allMk.filter((x) => !tedSet.has(x.id));
    const sumMk = nonTed.reduce((s, x) => s + x.amount, 0);
    m.amount = (trackerDirects.bouwpakket + trackerDirects.installateur + trackerDirects.assemblagehal + sumMk) * m.pct;
  }
  // Pass 2B: TED-markups IN hoofdaannemer (basis incl. TED markups in bp/inst/asm
  //          die nu zijn berekend in Pass 2A).
  for (const m of trackerMarkups) {
    if (m.type !== "percentage" || m.basis !== "totaal_ex_derden" || m.group !== "hoofdaannemer") continue;
    const allMk = trackerMarkups.filter((x) => ["bouwpakket","installateur","assemblagehal"].includes(x.group));
    const sumMk = allMk.reduce((s, x) => s + x.amount, 0);
    m.amount = (trackerDirects.bouwpakket + trackerDirects.installateur + trackerDirects.assemblagehal + sumMk) * m.pct;
  }
  // Pass 3: bp+asm en grand_total — gebruiken alle markups in bp/asm (resp. bp/inst/asm/der)
  //         inclusief de TED's uit Pass 2A. Hoofdaannemer-markups zelf nooit in basis.
  for (const m of trackerMarkups) {
    if (m.type !== "percentage") continue;
    if (m.basis === "bouwpakket_plus_assemblage") {
      const sumMk = trackerMarkups.filter((x) => x.group === "bouwpakket" || x.group === "assemblagehal").reduce((s, x) => s + x.amount, 0);
      m.amount = (trackerDirects.bouwpakket + trackerDirects.assemblagehal + sumMk) * m.pct;
    } else if (m.basis === "grand_total") {
      const sumMk = trackerMarkups.filter((x) => ["bouwpakket","installateur","assemblagehal","derden"].includes(x.group)).reduce((s, x) => s + x.amount, 0);
      m.amount = (trackerDirects.bouwpakket + trackerDirects.installateur + trackerDirects.assemblagehal + trackerDirects.derden + sumMk) * m.pct;
    }
  }
  const trackerMarkupTotal = trackerMarkups.reduce((s, x) => s + x.amount, 0);
  const expectedAppTotal =
    trackerDirects.bouwpakket + trackerDirects.installateur + trackerDirects.assemblagehal + trackerDirects.derden
    + trackerMarkupTotal
    + engTotal;

  if (includeSanity) {
  row++;
  const sanityHeaderRow = row;
  ws.mergeCells(`A${sanityHeaderRow}:H${sanityHeaderRow}`);
  const sHdr = ws.getCell(`A${sanityHeaderRow}`);
  sHdr.value = "SANITY CHECK — server-tracker per component (vergelijk met Subtotaal-direct per groep)";
  sHdr.font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.muted } };
  sHdr.alignment = { vertical: "middle", indent: 1 };
  sHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.surface } };
  ws.getRow(sanityHeaderRow).height = 18;
  row++;

  // Per-groep direct breakdown (= materialen + arbeid + transport + extras + PM).
  // Vergelijk met "Subtotaal {groep} (direct)" cel in elke groep.
  const breakdown: { label: string; value: number; excelRef?: string }[] = [
    { label: "Bouwpakket (direct, tracker)",   value: trackerDirects.bouwpakket,   excelRef: groupCells.bouwpakket.directCellRef },
    { label: "Installateur (direct, tracker)", value: trackerDirects.installateur, excelRef: groupCells.installateur.directCellRef },
    { label: "Assemblagehal (direct, tracker)", value: trackerDirects.assemblagehal, excelRef: groupCells.assemblagehal.directCellRef },
    { label: "Inkoop derden (direct, tracker)", value: trackerDirects.derden,      excelRef: groupCells.derden.directCellRef },
  ];
  for (const b of breakdown) {
    setRow(row, [b.label, null, null, null, null, null, b.value, null], {
      italic: true, color: COLOR.muted, indent: 1,
    });
    ws.getCell(`G${row}`).numFmt = EUR;
    if (b.excelRef) {
      ws.getCell(`H${row}`).value = { formula: `IF(ABS(${b.excelRef}-G${row})<0.5,"OK","Excel: "&TEXT(${b.excelRef},"€ #,##0")&" diff "&TEXT(${b.excelRef}-G${row},"€ #,##0;-€ #,##0")&"")` };
      ws.getCell(`H${row}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
    }
    row++;
  }
  // Sub-breakdown per groep (mat / lab / trans / extra / pm).
  for (const gk of ["bouwpakket", "installateur", "assemblagehal", "derden"] as GroupKey[]) {
    const c = trackerComp[gk];
    const total = c.mat + c.lab + c.trans + c.extra + c.pm;
    if (total === 0) continue;
    const indent = (label: string) => `   ${label}`;
    setRow(row, [indent(`${gk} · materialen`),  null, null, null, null, null, c.mat,   null], { italic: true, color: COLOR.muted, indent: 2 }); ws.getCell(`G${row}`).numFmt = EUR; row++;
    setRow(row, [indent(`${gk} · arbeid`),      null, null, null, null, null, c.lab,   null], { italic: true, color: COLOR.muted, indent: 2 }); ws.getCell(`G${row}`).numFmt = EUR; row++;
    setRow(row, [indent(`${gk} · transport`),   null, null, null, null, null, c.trans, null], { italic: true, color: COLOR.muted, indent: 2 }); ws.getCell(`G${row}`).numFmt = EUR; row++;
    setRow(row, [indent(`${gk} · extra-posten`), null, null, null, null, null, c.extra, null], { italic: true, color: COLOR.muted, indent: 2 }); ws.getCell(`G${row}`).numFmt = EUR; row++;
    if (gk === "assemblagehal") {
      setRow(row, [indent(`${gk} · PM`),         null, null, null, null, null, c.pm,    null], { italic: true, color: COLOR.muted, indent: 2 }); ws.getCell(`G${row}`).numFmt = EUR; row++;
    }
  }
  // Markup-bedragen (server-tracker totaal) — alleen totaal, geen per-markup vergelijk.
  setRow(row, ["Markups totaal (alle groepen + hoofdaannemer, tracker)", null, null, null, null, null, trackerMarkupTotal, null], {
    italic: true, color: COLOR.muted, indent: 1,
  });
  ws.getCell(`G${row}`).numFmt = EUR;
  row++;
  // Engineering.
  setRow(row, ["Engineering (tracker)", null, null, null, null, null, engTotal, null], {
    italic: true, color: COLOR.muted, indent: 1,
  });
  ws.getCell(`G${row}`).numFmt = EUR;
  row++;

  // Verwacht totaal + vergelijk met Excel grand total.
  setRow(row, ["Verwacht totaal (tracker som)", null, null, null, null, null, expectedAppTotal, null], {
    italic: true, color: COLOR.muted, indent: 1,
  });
  ws.getCell(`G${row}`).numFmt = EUR;
  const expectedRow = row;
  row++;
  setRow(row, ["Excel grand total (formule)", null, null, null, null, null, null, null], { italic: true, color: COLOR.muted, indent: 1 });
  ws.getCell(`G${row}`).value = { formula: `G${grandTotalRow}` };
  ws.getCell(`G${row}`).numFmt = EUR;
  const excelRow = row;
  row++;
  setRow(row, ["Verschil (Excel − tracker)", null, null, null, null, null, null, null], { italic: true, color: COLOR.muted, indent: 1 });
  ws.getCell(`G${row}`).value = { formula: `G${excelRow}-G${expectedRow}` };
  ws.getCell(`G${row}`).numFmt = EUR;
  const diffRow = row;
  row++;
  setRow(row, ["Status", null, null, null, null, null, null, null], { bold: true, indent: 1 });
  ws.getCell(`G${row}`).value = { formula: `IF(ABS(G${diffRow})<0.5,"OK","MISMATCH")` };
  ws.getCell(`G${row}`).font = { name: "Inter", size: 10, bold: true };
  row++;
  } // end if (includeSanity) — Tab 1

  // Server-side log voor stille mismatch-detectie zonder dat het in Excel komt.
  // Als deze warning komt is er een formule-bug; check via ?sanity=1.
  // Geen vergelijking mogelijk hier zonder Excel formule te evalueren — we loggen
  // alleen het verwachte totaal voor traceability.
  console.log(`[export] project=${project.id} expectedTotal=€${expectedAppTotal.toFixed(2)}`);

  // Freeze top header rows.
  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];

  // Ingebouwde outline-properties: default dicht.
  ws.properties = { ...ws.properties, outlineProperties: { summaryBelow: false, summaryRight: false } };

  // ── Tweede tab: "Per invoercategorie" ──────────────────────────
  // Toont per kostengroep een breakdown PER input-label (b.v. "Module Opp Vloer BG"),
  // met daaronder direct de individuele materialen (LVLS, FERM18, …) — geen tussen-
  // categorie zoals "I-Joist" of "LVL". Bron: r.contributions[] uit de calc.
  const ws2 = wb.addWorksheet("Per invoercategorie", {
    views: [{ state: "normal", showGridLines: false, zoomScale: 100 }],
    properties: { outlineLevelRow: 2 },
  });
  ws2.columns = [
    { width: 44 },  // A: Naam (input-label of materiaal)
    { width: 12 },  // B: Netto invoer (qty)
    { width: 8 },   // C: Eh
    { width: 12 },  // D: Ratio (mat-eh / invoer-eh)
    { width: 12 },  // E: Verlies %
    { width: 12 },  // F: Bruto
    { width: 12 },  // G: Prijs
    { width: 16 },  // H: Bedrag
  ];

  let r2 = 1;
  ws2.mergeCells(`A${r2}:H${r2}`);
  const t2 = ws2.getCell(`A${r2}`);
  t2.value = "PER INVOERCATEGORIE — herkomst van elk materiaal";
  t2.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.white } };
  t2.alignment = { vertical: "middle", indent: 1 };
  t2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalsDark } };
  ws2.getRow(r2).height = 22;
  r2++;
  r2++;

  // Helper: zet rij in ws2.
  const setRow2 = (r: number, vals: (string | number | null)[], opts?: {
    bold?: boolean; italic?: boolean; color?: string; fill?: string; indent?: number;
    numFmt?: string; outlineLevel?: number; hidden?: boolean;
  }) => {
    const ref = ws2.getRow(r);
    if (opts?.outlineLevel != null) ref.outlineLevel = opts.outlineLevel;
    if (opts?.hidden) ref.hidden = true;
    vals.forEach((v, i) => {
      const cell = ref.getCell(i + 1);
      if (v !== null) cell.value = v;
      cell.font = {
        name: "Inter", size: 10,
        bold: opts?.bold, italic: opts?.italic,
        color: opts?.color ? { argb: opts.color } : undefined,
      };
      if (i === 0 && opts?.indent) cell.alignment = { indent: opts.indent };
      if (i > 0 && typeof v === "number") cell.alignment = { horizontal: "right" };
      if (opts?.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
    });
  };

  // Bouw aggregaten per groep → per input-label → per materiaal.
  // contribs[r] = scaled contributions (al × building.count uit mergeAllRows).
  type MatAgg = {
    material: typeof allMaterials[number];
    materialRow: typeof calc.groups[number]["rows"][number];
    inputQty: number;
    ratio: number;     // gemiddelde ratio (vrijwel altijd gelijk per kengetal-rij)
    netto: number;
  };
  const orderedGroups: { key: CostGroup; label: string; fill: string }[] = [
    { key: "bouwpakket",    label: COST_GROUP_LABELS.bouwpakket,    fill: GROUP_COLORS.bouwpakket },
    { key: "installateur",  label: COST_GROUP_LABELS.installateur,  fill: GROUP_COLORS.installateur },
    { key: "assemblagehal", label: COST_GROUP_LABELS.assemblagehal, fill: GROUP_COLORS.assemblagehal },
    { key: "derden",        label: COST_GROUP_LABELS.derden,        fill: GROUP_COLORS.derden },
  ];

  // Per-tab markup-tracking.
  const ws2GroupDirectRef: Record<string, string> = {};
  const ws2MarkupCells: Record<string, string[]> = {
    bouwpakket: [], installateur: [], assemblagehal: [], arbeid: [], derden: [], hoofdaannemer: [], _project: [],
  };
  const ws2TedRows: { rowNum: number; group: string }[] = [];
  const ws2GrandTotalRows: number[] = [];
  const ws2BpAsmRows: number[] = [];

  // Render markups inline voor één groep in ws2 (zelfde patroon als hoofd-tab).
  // Returnt het laatste rij-nr (voor "Subtotaal incl. opslagen"-SUBTOTAL).
  const ws2RenderMarkups = (groupKey: CostGroup, directRef: string): number => {
    const groupMarkups = sortedMarkups.filter((m) => m.costGroup === groupKey);
    if (groupMarkups.length === 0) return -1;
    let lastRow = -1;
    for (const m of groupMarkups) {
      const typeLabel = m.type === "percentage" ? "%" : m.type === "per_m2" ? "€/m²" : "vast";
      const basisLabel = m.type === "percentage" ? BASIS_LABELS[m.basis] ?? "—" : "—";
      const rn = r2;
      // A=naam, B=waarde, C=leeg, D=type, E=basis, F-G leeg, H=bedrag
      setRow2(rn, [m.name, m.value, "", typeLabel, basisLabel, null, null, null], { indent: 2 });
      ws2.getCell(`B${rn}`).numFmt = m.type === "percentage" ? "0.00" : m.type === "per_m2" ? EUR2 : EUR;
      ws2.getCell(`D${rn}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
      ws2.getCell(`E${rn}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
      let formula: string;
      if (m.type === "percentage") {
        if (m.basis === "group_direct") {
          formula = `${directRef}*B${rn}/100`;
        } else if (m.basis === "group_cumulative") {
          const prev = [...(ws2MarkupCells[groupKey] ?? [])];
          formula = `(${directRef}${prev.length > 0 ? "+" + prev.join("+") : ""})*B${rn}/100`;
        } else if (m.basis === "inkoop_derden") {
          formula = `(${ws2GroupDirectRef.derden ?? "0"})*B${rn}/100`;
        } else if (m.basis === "totaal_ex_derden") {
          formula = "0";
          ws2TedRows.push({ rowNum: rn, group: groupKey });
        } else if (m.basis === "bouwpakket_plus_assemblage") {
          formula = "0";
          ws2BpAsmRows.push(rn);
        } else if (m.basis === "grand_total") {
          formula = "0";
          ws2GrandTotalRows.push(rn);
        } else {
          formula = "0";
        }
      } else if (m.type === "per_m2") {
        formula = `B${rn}*0`; // GFA niet gerepliceerd in tab 2 — fallback
      } else {
        formula = `B${rn}`;
      }
      ws2.getCell(`H${rn}`).value = { formula };
      ws2.getCell(`H${rn}`).numFmt = EUR;
      ws2.getCell(`H${rn}`).font = { name: "Inter", size: 10, bold: true };
      ws2MarkupCells[groupKey].push(`H${rn}`);
      lastRow = rn;
      r2++;
    }
    return lastRow;
  };

  for (const { key: groupKey, label: displayLabel, fill: fillColor } of orderedGroups) {
    const g = calc.groups.find((x) => x.group === groupKey);
    if (!g || g.rows.length === 0) continue;
    if (isGroupOff(groupKey)) continue;

    // Aggregaat: inputLabel → materialId → MatAgg. Filter materialen die uit staan.
    // Materialen ZONDER contributions (Kolomcorrectie / S2P stelposten / CSV)
    // vangen we apart op zodat ze niet uit Tab 2 verdwijnen.
    const byInput = new Map<string, Map<string, MatAgg>>();
    const synthRows: typeof g.rows = [];
    for (const matRow of g.rows) {
      if (isMatOff(groupKey, matRow.material.category, matRow.material.id)) continue;
      const contribs = matRow.contributions ?? [];
      if (contribs.length === 0) {
        synthRows.push(matRow);
        continue;
      }
      for (const c of contribs) {
        const innerMap = byInput.get(c.inputLabel) ?? new Map<string, MatAgg>();
        const ex = innerMap.get(matRow.material.id);
        if (ex) {
          ex.inputQty += c.inputQty;
          ex.netto += c.netto;
        } else {
          innerMap.set(matRow.material.id, {
            material: matRow.material as any,
            materialRow: matRow,
            inputQty: c.inputQty,
            ratio: c.ratio,
            netto: c.netto,
          });
        }
        byInput.set(c.inputLabel, innerMap);
      }
    }
    if (byInput.size === 0 && synthRows.length === 0) continue;

    // Group header bar.
    ws2.mergeCells(`A${r2}:H${r2}`);
    const hdr = ws2.getCell(`A${r2}`);
    hdr.value = displayLabel.toUpperCase();
    hdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
    hdr.alignment = { vertical: "middle", indent: 1 };
    hdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
    ws2.getRow(r2).height = 22;
    r2++;

    // Column headers.
    setRow2(r2, ["Invoercategorie / materiaal", "Invoer-qty", "Eh", "Ratio", "Verlies %", "Bruto", "Prijs", "Bedrag"], {
      bold: true, color: COLOR.muted, fill: COLOR.rowAlt, indent: 1,
    });
    ["B", "C", "D", "E", "F", "G", "H"].forEach((col) => {
      ws2.getCell(`${col}${r2}`).alignment = { horizontal: "right" };
    });
    r2++;

    const groupDataStart = r2;
    const inputLabels = Array.from(byInput.keys()).sort((a, b) => a.localeCompare(b, "nl"));

    for (const inputLabel of inputLabels) {
      const matsByMat = byInput.get(inputLabel)!;
      const mats = Array.from(matsByMat.values()).sort((a, b) => b.netto * (b.materialRow.price ?? 0) - a.netto * (a.materialRow.price ?? 0));

      const labelHeaderRow = r2;
      r2++;
      const detailStart = r2;

      for (const m of mats) {
        const rn = r2;
        ws2.getRow(rn).outlineLevel = 1;
        ws2.getRow(rn).hidden = true;
        const matName = m.material.description
          ? `${m.material.name} — ${m.material.description}`
          : m.material.name;
        // Effectieve prijs/verlies uit de calc-row (bevat GEVA-variant en
        // building-overrides). NIET m.material.pricePerUnit/lossPct (raw DB).
        const loss = m.materialRow.loss ?? 0;
        const price = m.materialRow.price ?? 0;
        setRow2(rn, [matName, m.inputQty, "", m.ratio, loss, null, price, null], { indent: 2 });
        ws2.getCell(`F${rn}`).value = { formula: `B${rn}*D${rn}*(1+E${rn})` };
        ws2.getCell(`H${rn}`).value = { formula: `F${rn}*G${rn}` };
        ws2.getCell(`B${rn}`).numFmt = NUM;
        ws2.getCell(`D${rn}`).numFmt = NUM2;
        ws2.getCell(`E${rn}`).numFmt = PCT;
        ws2.getCell(`F${rn}`).numFmt = NUM;
        ws2.getCell(`G${rn}`).numFmt = price <= 10 && price > 0 ? EUR2 : EUR;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        r2++;
      }
      const detailEnd = r2 - 1;
      setRow2(labelHeaderRow, [inputLabel, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws2.getCell(`H${labelHeaderRow}`).value = { formula: `SUBTOTAL(9,H${detailStart}:H${detailEnd})` };
      ws2.getCell(`H${labelHeaderRow}`).numFmt = EUR;
      ws2.getCell(`H${labelHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    }

    // Synthetische rijen (Kolomcorrectie / S2P / CSV-imports — geen kengetal-link).
    if (synthRows.length > 0) {
      const sh = r2;
      r2++;
      const sstart = r2;
      for (const r of synthRows) {
        const rn = r2;
        ws2.getRow(rn).outlineLevel = 1;
        ws2.getRow(rn).hidden = true;
        const matName = r.material.description
          ? `${r.material.name} — ${r.material.description}`
          : r.material.name;
        // Geen kengetal-input → geen ratio. Toon netto direct.
        // A=naam, B=netto, C=eh, D=1 (ratio), E=loss, F=bruto formule, G=prijs, H=bedrag
        setRow2(rn, [matName, r.netto, r.material.unit, 1, r.loss, null, r.price, null], { indent: 2 });
        ws2.getCell(`F${rn}`).value = { formula: `B${rn}*D${rn}*(1+E${rn})` };
        ws2.getCell(`H${rn}`).value = { formula: `F${rn}*G${rn}` };
        ws2.getCell(`B${rn}`).numFmt = NUM;
        ws2.getCell(`D${rn}`).numFmt = NUM2;
        ws2.getCell(`E${rn}`).numFmt = PCT;
        ws2.getCell(`F${rn}`).numFmt = NUM;
        ws2.getCell(`G${rn}`).numFmt = (r.price ?? 0) <= 10 && (r.price ?? 0) > 0 ? EUR2 : EUR;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        r2++;
      }
      const send = r2 - 1;
      setRow2(sh, ["Overige posten (geen kengetal-link)", null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws2.getCell(`H${sh}`).value = { formula: `SUBTOTAL(9,H${sstart}:H${send})` };
      ws2.getCell(`H${sh}`).numFmt = EUR;
      ws2.getCell(`H${sh}`).font = { name: "Inter", size: 10, bold: true };
    }

    // ── Extra leaves: arbeid + transport + handmatige posten + PM ──
    // Zelfde items als in Tab 1 zodat het direct-totaal van Tab 2 overeenkomt.

    // Per-kengetal arbeid (assemblage/installatie/arbeid-buiten/bewerking).
    const labEntries: { e: typeof calc.buildings[number]["labourEntries"][number]; mult: number }[] = [];
    if (!isLabGroupOff(groupKey)) {
      for (const br of calc.buildings) {
        const mult = br.building.count;
        for (const e of br.labourEntries) {
          if (e.costGroup !== groupKey) continue;
          if (isLabEntryOff(groupKey, e.inputLabel)) continue;
          labEntries.push({ e, mult });
        }
      }
    }
    const showProjectMgmt2 = groupKey === "assemblagehal" && calc.projectmgmtCost > 0
      && !isLabGroupOff(groupKey) && !isLabEntryOff(groupKey, "Projectmanagement");
    if (labEntries.length > 0 || showProjectMgmt2) {
      const lh = r2;
      r2++;
      const lstart = r2;
      const collapse = (l: string) => l.replace(/^Module Aant (BG|Dak|Tussenvd)(\s—|$)/, "Module Aant$2");
      const agg = new Map<string, { qty: number; rate: number; cost: number; unit: string }>();
      for (const { e, mult } of labEntries) {
        const key = collapse(e.inputLabel);
        const unit = groupKey === "bouwpakket" ? "m³" : "u";
        const ex = agg.get(key);
        const addQty = e.totalHours * mult, addCost = e.cost * mult;
        if (ex) { ex.qty += addQty; ex.cost += addCost; }
        else agg.set(key, { qty: addQty, rate: 0, cost: addCost, unit });
      }
      // Recompute weighted rate zodat B*F == cost.
      for (const v of agg.values()) v.rate = v.qty > 0 ? v.cost / v.qty : 0;
      for (const [label, v] of Array.from(agg.entries()).sort(([, a], [, b]) => b.cost - a.cost)) {
        const rn = r2;
        ws2.getRow(rn).outlineLevel = 1;
        ws2.getRow(rn).hidden = true;
        // A=label, B=qty, C=eh, D-E leeg, F=rate, G leeg, H=bedrag
        setRow2(rn, [label, v.qty, v.unit, null, null, v.rate, null, null], { indent: 2 });
        ws2.getCell(`H${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws2.getCell(`B${rn}`).numFmt = NUM;
        ws2.getCell(`F${rn}`).numFmt = v.rate <= 10 && v.rate > 0 ? EUR2 : EUR;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        r2++;
      }
      // Project-niveau PM bij assemblagehal.
      if (groupKey === "assemblagehal" && calc.projectmgmtCost > 0
          && !isLabGroupOff(groupKey) && !isLabEntryOff(groupKey, "Projectmanagement")) {
        const rn = r2;
        ws2.getRow(rn).outlineLevel = 1;
        ws2.getRow(rn).hidden = true;
        setRow2(rn, ["Projectmanagement", calc.projectmgmtHours, "u", null, null, rates.projectmgmtHourlyRate, null, null], { indent: 2 });
        ws2.getCell(`H${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws2.getCell(`B${rn}`).numFmt = NUM;
        ws2.getCell(`F${rn}`).numFmt = EUR;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        r2++;
      }
      const lend = r2 - 1;
      const ltitle = groupKey === "bouwpakket" ? "Bouwpakket-bewerking" : "Arbeid";
      setRow2(lh, [ltitle, null, null, null, null, null, null, null], { bold: true, indent: 1, fill: COLOR.rowAlt });
      ws2.getCell(`H${lh}`).value = { formula: `SUBTOTAL(9,H${lstart}:H${lend})` };
      ws2.getCell(`H${lh}`).numFmt = EUR;
      ws2.getCell(`H${lh}`).font = { name: "Inter", size: 10, bold: true };
    }

    // Transport — auto Polen voor bouwpakket, manueel voor assemblagehal.
    if (groupKey === "bouwpakket" && (calc.autoTransport.inboundCost + calc.autoTransport.outboundCost) > 0 && !isTransportOff(groupKey)) {
      const th = r2;
      r2++;
      const tstart = r2;
      [
        { label: "→ VMG Polen — I-joists", trucks: calc.autoTransport.inboundTrucks, price: 700 },
        { label: "← Lodz → NL — bouwpakket", trucks: calc.autoTransport.outboundTrucks, price: 1600 },
      ].forEach(({ label, trucks, price }) => {
        const rn = r2;
        ws2.getRow(rn).outlineLevel = 1;
        ws2.getRow(rn).hidden = true;
        setRow2(rn, [label, trucks, "truck(s)", null, null, price, null, null], { indent: 2 });
        ws2.getCell(`H${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws2.getCell(`F${rn}`).numFmt = EUR;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        r2++;
      });
      const tend = r2 - 1;
      setRow2(th, ["Transport Polen", null, null, null, null, null, null, null], { bold: true, indent: 1, fill: COLOR.rowAlt });
      ws2.getCell(`H${th}`).value = { formula: `SUBTOTAL(9,H${tstart}:H${tend})` };
      ws2.getCell(`H${th}`).numFmt = EUR;
      ws2.getCell(`H${th}`).font = { name: "Inter", size: 10, bold: true };
    } else if (g.transportCost > 0 && !isTransportOff(groupKey)) {
      const rn = r2;
      // Tab 2: bedrag-kolom is H (index 7), niet G. Vorige versie zette de
      // waarde in G → H SUBTOTAL miste de transport-post (€182k voor x-ray).
      setRow2(rn, ["Transport", null, null, null, null, null, null, g.transportCost], { bold: true, indent: 1, fill: COLOR.rowAlt });
      ws2.getCell(`H${rn}`).numFmt = EUR;
      r2++;
    }

    // Handmatige posten.
    const groupExtras2 = extraLines.filter((x) => x.costGroup === groupKey && !isOff(`xl:${x.id}`));
    if (groupExtras2.length > 0) {
      const xh = r2;
      r2++;
      const xstart = r2;
      for (const x of groupExtras2) {
        const rn = r2;
        ws2.getRow(rn).outlineLevel = 1;
        ws2.getRow(rn).hidden = true;
        setRow2(rn, [x.description || "Handmatige post", x.quantity, x.unit, null, null, x.pricePerUnit, null, null], { indent: 2 });
        ws2.getCell(`H${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws2.getCell(`B${rn}`).numFmt = NUM;
        ws2.getCell(`F${rn}`).numFmt = EUR;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        r2++;
      }
      const xend = r2 - 1;
      setRow2(xh, ["Handmatige posten", null, null, null, null, null, null, null], { bold: true, indent: 1, fill: COLOR.rowAlt });
      ws2.getCell(`H${xh}`).value = { formula: `SUBTOTAL(9,H${xstart}:H${xend})` };
      ws2.getCell(`H${xh}`).numFmt = EUR;
      ws2.getCell(`H${xh}`).font = { name: "Inter", size: 10, bold: true };
    }

    const groupDataEnd = r2 - 1;

    // Direct subtotal (= som leaves) — gebruikt door markup-formules.
    const directSubRow = r2;
    setRow2(directSubRow, [`Subtotaal ${displayLabel.toLowerCase()} (direct)`, null, null, null, null, null, null, null], {
      bold: true, indent: 1,
    });
    ws2.getCell(`H${directSubRow}`).value = { formula: `SUBTOTAL(9,H${groupDataStart}:H${groupDataEnd})` };
    ws2.getCell(`H${directSubRow}`).numFmt = EUR;
    ws2.getCell(`H${directSubRow}`).font = { name: "Inter", size: 10, bold: true };
    ws2GroupDirectRef[groupKey] = `H${directSubRow}`;
    r2++;

    // Markups inline.
    const lastMk = ws2RenderMarkups(groupKey, `H${directSubRow}`);

    // Subtotaal incl. opslagen — SUBTOTAL(9, range) skipt de geneste subtotalen.
    if (lastMk > 0) {
      const inclRow = r2;
      setRow2(inclRow, [`Subtotaal ${displayLabel.toLowerCase()} (incl. opslagen)`, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.brandSoft,
      });
      ws2.getCell(`H${inclRow}`).value = { formula: `SUBTOTAL(9,H${groupDataStart}:H${lastMk})` };
      ws2.getCell(`H${inclRow}`).numFmt = EUR;
      ws2.getCell(`H${inclRow}`).font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.brand } };
      r2++;
    }
    r2++; // whitespace
  }

  // Hoofdaannemer markups (alleen markups, geen leaves).
  if (sortedMarkups.some((m) => m.costGroup === "hoofdaannemer") && !isGroupOff("hoofdaannemer")) {
    ws2.mergeCells(`A${r2}:H${r2}`);
    const hdr = ws2.getCell(`A${r2}`);
    hdr.value = COST_GROUP_LABELS.hoofdaannemer.toUpperCase();
    hdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
    hdr.alignment = { vertical: "middle", indent: 1 };
    hdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.staart } };
    ws2.getRow(r2).height = 22;
    r2++;
    ws2RenderMarkups("hoofdaannemer", "0");
    r2++;
  }

  // Pass B — fill TED / grand_total / bp+asm placeholders in ws2.
  const r2_bp  = ws2GroupDirectRef.bouwpakket   ?? "0";
  const r2_ins = ws2GroupDirectRef.installateur ?? "0";
  const r2_asm = ws2GroupDirectRef.assemblagehal ?? "0";
  const r2_der = ws2GroupDirectRef.derden       ?? "0";
  const ws2TedRowSet = new Set(ws2TedRows.map((t) => `H${t.rowNum}`));
  for (const { rowNum, group } of ws2TedRows) {
    const allMk = [...ws2MarkupCells.bouwpakket, ...ws2MarkupCells.installateur, ...ws2MarkupCells.assemblagehal];
    const nonTed = allMk.filter((c) => !ws2TedRowSet.has(c));
    const part = group === "hoofdaannemer" ? allMk : nonTed;
    const terms = [r2_bp, r2_ins, r2_asm, ...part].filter((t) => t && t !== "0");
    ws2.getCell(`H${rowNum}`).value = { formula: `(${terms.join("+")})*B${rowNum}/100` };
  }
  if (ws2BpAsmRows.length > 0) {
    const terms = [r2_bp, r2_asm, ...ws2MarkupCells.bouwpakket, ...ws2MarkupCells.assemblagehal].filter((t) => t && t !== "0");
    for (const rn of ws2BpAsmRows) {
      ws2.getCell(`H${rn}`).value = { formula: `(${terms.join("+")})*B${rn}/100` };
    }
  }
  if (ws2GrandTotalRows.length > 0) {
    const allMk = [
      ...ws2MarkupCells.bouwpakket, ...ws2MarkupCells.installateur,
      ...ws2MarkupCells.assemblagehal, ...ws2MarkupCells.derden,
    ];
    const terms = [r2_bp, r2_ins, r2_asm, r2_der, ...allMk].filter((t) => t && t !== "0");
    const baseExpr = terms.join("+");
    for (const rn of ws2GrandTotalRows) {
      ws2.getCell(`H${rn}`).value = { formula: `(${baseExpr})*B${rn}/100` };
    }
  }

  // Engineering sectie in ws2 (zelfde berekening als hoofd-tab).
  if (!isOff("grp:engineering")) {
    const engCells: number[] = [];
    let engHasData = false;
    for (const br of buildingResults) {
      const mods = modsByBuilding.get(br.building.id) ?? [];
      const bvo = gfaByBuildingId.get(br.building.id) ?? 0;
      const area = mods.reduce((s, m) => s + m.lengthM * m.widthM * m.count, 0);
      const bgg = br.effectiveInputs["_opp_begane_grond"] ?? 0;
      const floorsRaw = area > 0 && bgg > 0 ? area / bgg : 1;
      const floors = Math.abs(floorsRaw - Math.round(floorsRaw)) < 0.1 ? Math.round(floorsRaw) : floorsRaw;
      const eng = computeEngineering(mods, bvo, floors);
      const mult = br.building.count;
      if (eng.engineeringTotal * mult <= 0 && eng.constructieTotal * mult <= 0) continue;
      if (!engHasData) {
        ws2.mergeCells(`A${r2}:H${r2}`);
        const eHdr = ws2.getCell(`A${r2}`);
        eHdr.value = "ENGINEERING";
        eHdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
        eHdr.alignment = { vertical: "middle", indent: 1 };
        eHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.brandSoft } };
        ws2.getRow(r2).height = 22;
        r2++;
        engHasData = true;
      }
      if (eng.engineeringTotal > 0) {
        const rn = r2;
        setRow2(rn, [`Sustainer fee — ${br.building.name}`, eng.engineeringPerM2, "€/m²", null, null, bvo * mult, null, null], { indent: 2 });
        ws2.getCell(`H${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws2.getCell(`B${rn}`).numFmt = EUR;
        ws2.getCell(`F${rn}`).numFmt = NUM;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        engCells.push(rn);
        r2++;
      }
      if (eng.constructieTotal > 0) {
        const rn = r2;
        setRow2(rn, [`Constructieberekening — ${br.building.name}`, eng.constructiePerM2, "€/m²", null, null, bvo * mult, null, null], { indent: 2 });
        ws2.getCell(`H${rn}`).value = { formula: `B${rn}*F${rn}` };
        ws2.getCell(`B${rn}`).numFmt = EUR;
        ws2.getCell(`F${rn}`).numFmt = NUM;
        ws2.getCell(`H${rn}`).numFmt = EUR;
        engCells.push(rn);
        r2++;
      }
    }
    if (engHasData && engCells.length > 0) {
      setRow2(r2, ["Subtotaal engineering", null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.brandSoft,
      });
      const firstEng = engCells[0];
      const lastEng = engCells[engCells.length - 1];
      ws2.getCell(`H${r2}`).value = { formula: `SUBTOTAL(9,H${firstEng}:H${lastEng})` };
      ws2.getCell(`H${r2}`).numFmt = EUR;
      ws2.getCell(`H${r2}`).font = { name: "Inter", size: 10, bold: true };
      r2++;
    }
    r2++;
  }

  // Totaal-rij — som van alle "Subtotaal incl. opslagen" + engineering.
  // Eenvoudiger: SUBTOTAL(9, range) over alles dan engineering los optellen.
  const grandRowWs2 = r2;
  ws2.mergeCells(`A${grandRowWs2}:H${grandRowWs2}`);
  const gtHdr2 = ws2.getCell(`A${grandRowWs2}`);
  gtHdr2.value = "TOTAAL EXCL. BTW";
  gtHdr2.font = { name: "Inter", size: 14, bold: true, color: { argb: COLOR.white } };
  gtHdr2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalsDark } };
  gtHdr2.alignment = { vertical: "middle", indent: 1 };
  ws2.getRow(grandRowWs2).height = 26;
  r2++;
  const grandValueRow = r2;
  setRow2(grandValueRow, ["Totaal project", null, null, null, null, null, null, null], {
    bold: true, color: COLOR.brand, indent: 1, fill: COLOR.brandSoft,
  });
  ws2.getCell(`H${grandValueRow}`).value = { formula: `SUBTOTAL(9,H1:H${grandValueRow - 1})` };
  ws2.getCell(`H${grandValueRow}`).numFmt = EUR;
  ws2.getCell(`H${grandValueRow}`).font = { name: "Inter", size: 14, bold: true, color: { argb: COLOR.brand } };
  ws2.getRow(grandValueRow).height = 26;
  r2++;

  if (includeSanity) {
  // ── Sanity check (Tab 2) — per-component breakdown ─────────────
  r2++;
  const sHdr2Row = r2;
  ws2.mergeCells(`A${sHdr2Row}:H${sHdr2Row}`);
  const sHdr2 = ws2.getCell(`A${sHdr2Row}`);
  sHdr2.value = "SANITY CHECK — server-tracker per component (vergelijk met Subtotaal-direct per groep)";
  sHdr2.font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.muted } };
  sHdr2.alignment = { vertical: "middle", indent: 1 };
  sHdr2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.surface } };
  ws2.getRow(sHdr2Row).height = 18;
  r2++;

  const breakdown2: { label: string; value: number; excelRef?: string }[] = [
    { label: "Bouwpakket (direct, tracker)",   value: trackerDirects.bouwpakket,   excelRef: ws2GroupDirectRef.bouwpakket },
    { label: "Installateur (direct, tracker)", value: trackerDirects.installateur, excelRef: ws2GroupDirectRef.installateur },
    { label: "Assemblagehal (direct, tracker)", value: trackerDirects.assemblagehal, excelRef: ws2GroupDirectRef.assemblagehal },
    { label: "Inkoop derden (direct, tracker)", value: trackerDirects.derden,      excelRef: ws2GroupDirectRef.derden },
  ];
  for (const b of breakdown2) {
    setRow2(r2, [b.label, null, null, null, null, null, null, b.value], { italic: true, color: COLOR.muted, indent: 1 });
    ws2.getCell(`H${r2}`).numFmt = EUR;
    if (b.excelRef) {
      ws2.getCell(`G${r2}`).value = { formula: `${b.excelRef}` };
      ws2.getCell(`G${r2}`).numFmt = EUR;
      ws2.getCell(`G${r2}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
    }
    r2++;
  }
  setRow2(r2, ["Markups totaal (tracker)", null, null, null, null, null, null, trackerMarkupTotal], { italic: true, color: COLOR.muted, indent: 1 });
  ws2.getCell(`H${r2}`).numFmt = EUR;
  r2++;
  setRow2(r2, ["Engineering (tracker)", null, null, null, null, null, null, engTotal], { italic: true, color: COLOR.muted, indent: 1 });
  ws2.getCell(`H${r2}`).numFmt = EUR;
  r2++;
  setRow2(r2, ["Verwacht totaal (tracker som)", null, null, null, null, null, null, expectedAppTotal], {
    italic: true, color: COLOR.muted, indent: 1,
  });
  ws2.getCell(`H${r2}`).numFmt = EUR;
  const ws2ExpectedRow = r2;
  r2++;
  setRow2(r2, ["Excel grand total (formule)", null, null, null, null, null, null, null], { italic: true, color: COLOR.muted, indent: 1 });
  ws2.getCell(`H${r2}`).value = { formula: `H${grandValueRow}` };
  ws2.getCell(`H${r2}`).numFmt = EUR;
  const ws2ExcelRow = r2;
  r2++;
  setRow2(r2, ["Verschil (Excel − tracker)", null, null, null, null, null, null, null], { italic: true, color: COLOR.muted, indent: 1 });
  ws2.getCell(`H${r2}`).value = { formula: `H${ws2ExcelRow}-H${ws2ExpectedRow}` };
  ws2.getCell(`H${r2}`).numFmt = EUR;
  const ws2DiffRow = r2;
  r2++;
  setRow2(r2, ["Status", null, null, null, null, null, null, null], { bold: true, indent: 1 });
  ws2.getCell(`H${r2}`).value = { formula: `IF(ABS(H${ws2DiffRow})<0.5,"OK","MISMATCH")` };
  ws2.getCell(`H${r2}`).font = { name: "Inter", size: 10, bold: true };
  r2++;
  } // end if (includeSanity) — Tab 2

  ws2.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  ws2.properties = { ...ws2.properties, outlineProperties: { summaryBelow: false, summaryRight: false } };

  // ── Derde tab: "Invoer" ────────────────────────────────────────
  // Toont alle STANDARD_CATEGORIES (alle 33+ invoercategorieën) per gebouw met
  // de daadwerkelijk-gebruikte hoeveelheid. Ontvanger ziet in één blik welke
  // input is gebruikt voor de begroting; lege velden zijn 0.
  const ws3 = wb.addWorksheet("Invoer", {
    views: [{ state: "normal", showGridLines: false, zoomScale: 100 }],
    properties: { outlineLevelRow: 1 },
  });
  // Kolommen: A=label, B=eenheid, C+=per-gebouw qty.
  const buildingCols = projBuildings;
  ws3.columns = [
    { width: 36 },
    { width: 8 },
    ...buildingCols.map(() => ({ width: 14 })),
    { width: 10 }, // groep-kolom rechts
  ];

  const STD = STANDARD_CATEGORIES;
  const GRP_ORDER = CATEGORY_GROUP_ORDER;
  const GRP_LABEL = CATEGORY_GROUP_LABELS;

  let r3 = 1;
  ws3.mergeCells(`A${r3}:${String.fromCharCode(66 + buildingCols.length + 1)}${r3}`);
  const t3 = ws3.getCell(`A${r3}`);
  t3.value = "INVOER — alle invoercategorieën per gebouw";
  t3.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.white } };
  t3.alignment = { vertical: "middle", indent: 1 };
  t3.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalsDark } };
  ws3.getRow(r3).height = 22;
  r3++;
  r3++;

  // Header-rij.
  const headerRow = r3;
  ws3.getCell(`A${headerRow}`).value = "Invoercategorie";
  ws3.getCell(`B${headerRow}`).value = "Eh";
  buildingCols.forEach((b, i) => {
    const col = String.fromCharCode(67 + i); // C,D,E,...
    const cell = ws3.getCell(`${col}${headerRow}`);
    cell.value = `${b.name}${b.count > 1 ? ` (${b.count}×)` : ""}`;
    cell.font = { name: "Inter", size: 10, bold: true };
    cell.alignment = { horizontal: "right" };
  });
  const groupCol = String.fromCharCode(67 + buildingCols.length);
  ws3.getCell(`${groupCol}${headerRow}`).value = "Groep";
  ws3.getRow(headerRow).font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.muted } };
  ws3.getRow(headerRow).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.rowAlt } };
  r3++;

  // Group input-categories door de hoofdgroep.
  const stdByGroup = new Map<string, typeof STD>();
  for (const s of STD) {
    const list = stdByGroup.get(s.group) ?? [];
    list.push(s);
    stdByGroup.set(s.group, list);
  }

  for (const grp of GRP_ORDER) {
    const items = stdByGroup.get(grp);
    if (!items || items.length === 0) continue;
    // Group-header rij.
    ws3.mergeCells(`A${r3}:${groupCol}${r3}`);
    const gHdr = ws3.getCell(`A${r3}`);
    gHdr.value = GRP_LABEL[grp].toUpperCase();
    gHdr.font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.headerText } };
    gHdr.alignment = { vertical: "middle", indent: 1 };
    gHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.surface } };
    ws3.getRow(r3).height = 18;
    r3++;
    for (const cat of items) {
      const rn = r3;
      ws3.getCell(`A${rn}`).value = cat.label;
      ws3.getCell(`A${rn}`).font = { name: "Inter", size: 10 };
      ws3.getCell(`A${rn}`).alignment = { indent: 1 };
      ws3.getCell(`B${rn}`).value = cat.unit;
      ws3.getCell(`B${rn}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
      buildingCols.forEach((b, i) => {
        const col = String.fromCharCode(67 + i);
        const inputs = inputsByBuilding.get(b.id) ?? [];
        const direct = inputs.find((x) => x.inputLabel === cat.label);
        let qty: number = direct?.quantity ?? 0;
        // Voor module-derived labels: lees uit buildingResults effectiveInputs (incl. derivaties).
        if (qty === 0) {
          const br = buildingResults.find((x) => x.building.id === b.id);
          qty = br?.effectiveInputs[cat.label] ?? 0;
        }
        const cell = ws3.getCell(`${col}${rn}`);
        cell.value = qty;
        cell.numFmt = NUM;
        cell.font = { name: "Inter", size: 10 };
        cell.alignment = { horizontal: "right" };
      });
      ws3.getCell(`${groupCol}${rn}`).value = cat.subgroup;
      ws3.getCell(`${groupCol}${rn}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
      r3++;
    }
  }

  ws3.views = [{ state: "frozen", ySplit: headerRow, showGridLines: false }];
  ws3.properties = { ...ws3.properties, outlineProperties: { summaryBelow: false, summaryRight: false } };

  // ── Write + return ─────────────────────────────────────────────
  const buf = await wb.xlsx.writeBuffer();
  const safeName = project.name.replace(/[^\w\s\-]/g, "").replace(/\s+/g, "_").slice(0, 60);
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}_${safeName}_begroting.xlsx`;
  return new NextResponse(buf as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
