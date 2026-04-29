import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import {
  projects, buildings, modules as modulesTable, buildingInputs, overrides,
  materials, kengetalSets, kengetalRows, kengetalLabour,
  projectTransport, vehicleTypes, markupRows, labourRates,
} from "@/lib/db/schema";
import {
  calculateBuilding, calculateProject, computeLearningFactor, computeBvo, computeEngineering,
  DEFAULT_LABOUR_RATES, DEFAULT_EFFICIENCY, COST_GROUP_LABELS, BASIS_LABELS,
} from "@/lib/calculation";
import type { CostGroup } from "@/types";
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
  const disabledParam = new URL(_req.url).searchParams.get("disabled") ?? "";
  const disabled = new Set<string>(disabledParam.split(",").map((s) => decodeURIComponent(s.trim())).filter(Boolean));
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

  const calc = calculateProject(
    project, buildingResults, transport, mkRows, rates,
    "Module oppervlak", projLearn, gfaByBuildingId, autoAssemblageTransport,
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

      const collapse = (l: string) => l.replace(/^Modules (begane grond|dak|tussenverdieping)(\s—|$)/, "Modules$2");
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
          agg.set(key, { qty: addQty, rate: e.totalHours > 0 ? e.cost / e.totalHours : 0, cost: addCost, unit });
        }
      }
      if (groupKey === "bouwpakket") {
        const gez = { qty: 0, cost: 0 };
        const cnc = { qty: 0, cost: 0 };
        for (const [label, v] of agg) {
          if (label.endsWith("— gezaagd")) { gez.qty += v.qty; gez.cost += v.cost; }
          else if (label.endsWith("— CNC simpel") || label.endsWith("— CNC complex")) { cnc.qty += v.qty; cnc.cost += v.cost; }
        }
        agg.clear();
        if (gez.cost > 0) agg.set("Gezaagd", { qty: gez.qty, rate: gez.qty > 0 ? gez.cost / gez.qty : 0, cost: gez.cost, unit: "m³" });
        if (cnc.cost > 0) agg.set("CNC",     { qty: cnc.qty, rate: cnc.qty > 0 ? cnc.cost / cnc.qty : 0, cost: cnc.cost, unit: "m³" });
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
    if (lastMarkupRow > 0) {
      const inclRow = row;
      setRow(inclRow, [`Subtotaal ${displayLabel.toLowerCase()} (incl. opslagen)`, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.brandSoft,
      });
      const markupRefs = markupAmountCells[groupKey];
      ws.getCell(`G${inclRow}`).value = {
        formula: markupRefs.length > 0
          ? `${directRef}+${markupRefs.join("+")}`
          : directRef,
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
    if (engHasData) {
      const engSubRow = row;
      setRow(engSubRow, ["Subtotaal engineering", null, null, null, null, null, null, null], {
        bold: true, indent: 1, borderTop: true, fill: COLOR.brandSoft,
      });
      ws.getCell(`G${engSubRow}`).value = engineeringRows.length > 0
        ? { formula: engineeringRows.map((rr) => `G${rr}`).join("+") }
        : 0;
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
  const ws2RenderMarkups = (groupKey: CostGroup, directRef: string) => {
    const groupMarkups = sortedMarkups.filter((m) => m.costGroup === groupKey);
    if (groupMarkups.length === 0) return;
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
      r2++;
    }
  };

  for (const { key: groupKey, label: displayLabel, fill: fillColor } of orderedGroups) {
    const g = calc.groups.find((x) => x.group === groupKey);
    if (!g || g.rows.length === 0) continue;
    if (isGroupOff(groupKey)) continue;

    // Aggregaat: inputLabel → materialId → MatAgg. Filter materialen die uit staan.
    const byInput = new Map<string, Map<string, MatAgg>>();
    for (const matRow of g.rows) {
      if (isMatOff(groupKey, matRow.material.category, matRow.material.id)) continue;
      for (const c of matRow.contributions ?? []) {
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
    if (byInput.size === 0) continue;

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
      const mats = Array.from(matsByMat.values()).sort((a, b) => b.netto * (b.material.pricePerUnit ?? 0) - a.netto * (a.material.pricePerUnit ?? 0));

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
        const loss = m.material.lossPct ?? 0;
        setRow2(rn, [matName, m.inputQty, "", m.ratio, loss, null, m.material.pricePerUnit ?? 0, null], { indent: 2 });
        ws2.getCell(`F${rn}`).value = { formula: `B${rn}*D${rn}*(1+E${rn})` };
        ws2.getCell(`H${rn}`).value = { formula: `F${rn}*G${rn}` };
        ws2.getCell(`B${rn}`).numFmt = NUM;
        ws2.getCell(`D${rn}`).numFmt = NUM2;
        ws2.getCell(`E${rn}`).numFmt = PCT;
        ws2.getCell(`F${rn}`).numFmt = NUM;
        ws2.getCell(`G${rn}`).numFmt = (m.material.pricePerUnit ?? 0) <= 10 && (m.material.pricePerUnit ?? 0) > 0 ? EUR2 : EUR;
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
    ws2RenderMarkups(groupKey, `H${directSubRow}`);

    // Subtotaal incl. opslagen.
    if ((ws2MarkupCells[groupKey] ?? []).length > 0) {
      const inclRow = r2;
      setRow2(inclRow, [`Subtotaal ${displayLabel.toLowerCase()} (incl. opslagen)`, null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.brandSoft,
      });
      ws2.getCell(`H${inclRow}`).value = { formula: `H${directSubRow}+${ws2MarkupCells[groupKey].join("+")}` };
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
    if (engHasData) {
      setRow2(r2, ["Subtotaal engineering", null, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.brandSoft,
      });
      ws2.getCell(`H${r2}`).value = engCells.length > 0
        ? { formula: engCells.map((rr) => `H${rr}`).join("+") }
        : 0;
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

  ws2.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  ws2.properties = { ...ws2.properties, outlineProperties: { summaryBelow: false, summaryRight: false } };

  // ── Invoer-sectie (collapsed) — onder beide tabs ───────────────
  // Lijst alle building_inputs per gebouw, ingeklapt zodat het Excel-bestand
  // door de ontvanger snel gecheckt kan worden zonder dat het tabblad volstroomt.
  const renderInvoerSection = (sheet: ExcelJS.Worksheet, startRow: number, ctx: "begroting" | "categorie"): number => {
    let rr = startRow;
    rr++;
    sheet.mergeCells(`A${rr}:${ctx === "begroting" ? "H" : "H"}${rr}`);
    const ihdr = sheet.getCell(`A${rr}`);
    ihdr.value = "INVOER (collapsed — klik + om te tonen)";
    ihdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
    ihdr.alignment = { vertical: "middle", indent: 1 };
    ihdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.surface } };
    sheet.getRow(rr).height = 22;
    rr++;
    for (const b of projBuildings) {
      const inputs = (inputsByBuilding.get(b.id) ?? [])
        .filter((i) => !i.inputLabel.startsWith("_"))
        .sort((a, b) => a.inputLabel.localeCompare(b.inputLabel, "nl"));
      if (inputs.length === 0) continue;
      const blockHeaderRow = rr;
      sheet.getRow(rr).outlineLevel = 0;
      const c1 = sheet.getCell(`A${rr}`);
      c1.value = `Gebouw — ${b.name} (${b.count}×)`;
      c1.font = { name: "Inter", size: 10, bold: true, color: { argb: COLOR.muted } };
      c1.alignment = { indent: 1 };
      sheet.getCell(`B${rr}`).value = `${inputs.length} velden`;
      sheet.getCell(`B${rr}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
      rr++;
      for (const inp of inputs) {
        sheet.getRow(rr).outlineLevel = 1;
        sheet.getRow(rr).hidden = true;
        sheet.getCell(`A${rr}`).value = inp.inputLabel;
        sheet.getCell(`A${rr}`).font = { name: "Inter", size: 10 };
        sheet.getCell(`A${rr}`).alignment = { indent: 2 };
        sheet.getCell(`B${rr}`).value = inp.quantity;
        sheet.getCell(`B${rr}`).numFmt = NUM;
        sheet.getCell(`B${rr}`).font = { name: "Inter", size: 10 };
        sheet.getCell(`B${rr}`).alignment = { horizontal: "right" };
        rr++;
      }
    }
    return rr;
  };

  row = renderInvoerSection(ws, row, "begroting");
  r2 = renderInvoerSection(ws2, r2, "categorie");

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
