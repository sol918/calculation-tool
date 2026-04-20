import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import {
  projects, buildings, modules as modulesTable, buildingInputs, overrides,
  materials, kengetalSets, kengetalRows, kengetalLabour,
  projectTransport, vehicleTypes, markupRows, labourRates,
} from "@/lib/db/schema";
import {
  calculateBuilding, calculateProject, computeLearningFactor, computeBvo,
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

  // Column widths: A=omschrijving, B=hoeveelheid, C=eenheid, D=tarief/prijs, E=percentage/basis, F=totaal, G=notes
  ws.columns = [
    { width: 48 },  // A: Omschrijving
    { width: 14 },  // B: Hoeveelheid
    { width: 8 },   // C: Eenheid
    { width: 14 },  // D: Prijs/tarief
    { width: 18 },  // E: Basis (label/omschrijving)
    { width: 16 },  // F: Bedrag €
    { width: 28 },  // G: Toelichting
  ];

  let row = 1;

  // ── Header band ─────────────────────────────────────────────────
  ws.mergeCells(`A${row}:G${row}`);
  const titleCell = ws.getCell(`A${row}`);
  titleCell.value = "SUSTAINER CALCULATOR — BEGROTING";
  titleCell.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.white } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalsDark } };
  ws.getRow(row).height = 22;
  row++;

  ws.mergeCells(`A${row}:G${row}`);
  const nameCell = ws.getCell(`A${row}`);
  nameCell.value = project.name;
  nameCell.font = { name: "Inter", size: 20, bold: true };
  nameCell.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(row).height = 30;
  row++;

  ws.mergeCells(`A${row}:G${row}`);
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
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = "SAMENVATTING";
  ws.getCell(`A${row}`).font = { name: "Inter", size: 9, bold: true, color: { argb: COLOR.muted } };
  ws.getCell(`A${row}`).alignment = { indent: 1 };
  row++;
  for (const [label, value, unit] of kpis) {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { name: "Inter", size: 10 };
    ws.getCell(`A${row}`).alignment = { indent: 1 };
    ws.getCell(`F${row}`).value = value;
    ws.getCell(`F${row}`).font = { name: "Inter", size: 11, bold: typeof value === "number" };
    ws.getCell(`F${row}`).alignment = { horizontal: "right" };
    if (typeof value === "number") {
      ws.getCell(`F${row}`).numFmt = unit === "€" || unit === "€/m²" ? "€ #,##0" : "#,##0";
    }
    ws.getCell(`G${row}`).value = unit ?? "";
    ws.getCell(`G${row}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
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

  // ── Render een groep ────────────────────────────────────────────
  // Structuur: group-header → kolomkoppen → categorie-SUBTOTAL (met geneste leaves)
  //   → arbeid-SUBTOTAL (leaves) → transport-SUBTOTAL (leaves) → Subtotaal-groep.
  // De Subtotaal-rij is zelf SUBTOTAL(9, groupDataStart:groupDataEnd). Omdat SUBTOTAL
  // nested SUBTOTAL-cellen overslaat, telt dat alleen de leaf-cellen — precies wat we
  // willen voor de directe kosten van de groep.
  const renderGroup = (groupKey: CostGroup, displayLabel: string, fillColor: string) => {
    const g = calc.groups.find((x) => x.group === groupKey);
    if (!g || (g.rows.length === 0 && g.laborCost === 0 && g.transportCost === 0 && g.totalMarkups === 0)) return;

    // Group header bar.
    ws.mergeCells(`A${row}:G${row}`);
    const hdr = ws.getCell(`A${row}`);
    hdr.value = displayLabel.toUpperCase();
    hdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
    hdr.alignment = { vertical: "middle", indent: 1 };
    hdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
    ws.getRow(row).height = 22;
    row++;

    // Column headers.
    setRow(row, ["Post", "Hoeveelheid", "Eh.", "Prijs/eh", "Netto", "Bedrag", "Toelichting"], {
      bold: true, color: COLOR.muted, fill: COLOR.rowAlt,
      indent: 1, borderBottom: true,
    });
    ["B", "C", "D", "E", "F"].forEach((col) => {
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
      const catHeaderRow = row;
      row++;

      const detailStart = row;
      for (const r of matRows) {
        const name = r.material.description
          ? `${r.material.name} — ${r.material.description}`
          : r.material.name;
        const rowNum = row;
        ws.getRow(rowNum).outlineLevel = 1;
        ws.getRow(rowNum).hidden = true;
        setRow(rowNum, [name, r.bruto, r.material.unit, r.price, r.netto, null, null], { indent: 2 });
        ws.getCell(`F${rowNum}`).value = { formula: `B${rowNum}*D${rowNum}` };
        ws.getCell(`B${rowNum}`).numFmt = NUM;
        ws.getCell(`E${rowNum}`).numFmt = NUM;
        ws.getCell(`E${rowNum}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
        ws.getCell(`D${rowNum}`).numFmt = r.price <= 10 && r.price > 0 ? EUR2 : EUR;
        ws.getCell(`F${rowNum}`).numFmt = EUR;
        row++;
      }
      const detailEnd = row - 1;

      // Categorie-subtotaal via SUBTOTAL — slaat zichzelf automatisch over als
      // deze rij in een bovenliggende SUBTOTAL-range voorkomt.
      setRow(catHeaderRow, [cat, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`F${catHeaderRow}`).value = { formula: `SUBTOTAL(9,F${detailStart}:F${detailEnd})` };
      ws.getCell(`F${catHeaderRow}`).numFmt = EUR;
      ws.getCell(`F${catHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    }

    // Labour / bewerking entries.
    const labourEntries: { e: typeof calc.buildings[number]["labourEntries"][number]; mult: number }[] = [];
    for (const br of calc.buildings) {
      const mult = br.building.count;
      for (const e of br.labourEntries) {
        if (e.costGroup !== groupKey) continue;
        labourEntries.push({ e, mult });
      }
    }
    if (labourEntries.length > 0 || (groupKey === "assemblagehal" && (calc.arbeidBuitenCost + calc.projectmgmtCost) > 0)) {
      const labHeaderRow = row;
      row++;
      const labStart = row;

      const collapse = (l: string) => l.replace(/^Module Aantal (BG|Dak|Tussenvd)(\s—|$)/, "Module Aantal$2");
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
        setRow(rowNum, [label, v.qty, v.unit, v.rate, null, null, null], { indent: 2 });
        ws.getCell(`F${rowNum}`).value = { formula: `B${rowNum}*D${rowNum}` };
        ws.getCell(`B${rowNum}`).numFmt = NUM;
        ws.getCell(`D${rowNum}`).numFmt = v.rate <= 10 && v.rate > 0 ? EUR2 : EUR;
        ws.getCell(`F${rowNum}`).numFmt = EUR;
        row++;
      }

      // Module-gedreven arbeid (assemblagehal).
      if (groupKey === "assemblagehal") {
        if (calc.arbeidBuitenCost > 0) {
          const rowNum = row;
          ws.getRow(rowNum).outlineLevel = 1;
          ws.getRow(rowNum).hidden = true;
          const hoursPerMod = rates.arbeidBuitenHoursPerModule * projLearn;
          const totalHours = hoursPerMod * calc.totalModules;
          setRow(rowNum, ["Arbeid buiten (per module)", totalHours, "u", rates.arbeidBuitenHourlyRate, null, null, null], { indent: 2 });
          ws.getCell(`F${rowNum}`).value = { formula: `B${rowNum}*D${rowNum}` };
          ws.getCell(`B${rowNum}`).numFmt = NUM;
          ws.getCell(`D${rowNum}`).numFmt = EUR;
          ws.getCell(`F${rowNum}`).numFmt = EUR;
          row++;
        }
        if (calc.projectmgmtCost > 0) {
          const rowNum = row;
          ws.getRow(rowNum).outlineLevel = 1;
          ws.getRow(rowNum).hidden = true;
          const hoursPerMod = rates.projectmgmtHoursPerModule * projLearn;
          const totalHours = hoursPerMod * calc.totalModules;
          setRow(rowNum, ["Projectmanagement (per module)", totalHours, "u", rates.projectmgmtHourlyRate, null, null, null], { indent: 2 });
          ws.getCell(`F${rowNum}`).value = { formula: `B${rowNum}*D${rowNum}` };
          ws.getCell(`B${rowNum}`).numFmt = NUM;
          ws.getCell(`D${rowNum}`).numFmt = EUR;
          ws.getCell(`F${rowNum}`).numFmt = EUR;
          row++;
        }
      }

      const labEnd = row - 1;
      const title = groupKey === "bouwpakket" ? "Bouwpakket-bewerking" : "Arbeid";
      setRow(labHeaderRow, [title, null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`F${labHeaderRow}`).value = { formula: `SUBTOTAL(9,F${labStart}:F${labEnd})` };
      ws.getCell(`F${labHeaderRow}`).numFmt = EUR;
      ws.getCell(`F${labHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    }

    // Transport Polen (bouwpakket) of manueel transport.
    if (groupKey === "bouwpakket" && (calc.autoTransport.inboundCost + calc.autoTransport.outboundCost) > 0) {
      const tpHeaderRow = row;
      row++;
      const tpStart = row;

      const inbRow = row;
      ws.getRow(inbRow).outlineLevel = 1;
      ws.getRow(inbRow).hidden = true;
      setRow(inbRow, [
        "→ VMG Polen (Lodz) — I-joists",
        calc.autoTransport.inboundTrucks, "truck(s)", 700, calc.autoTransport.inboundM3, null,
        `${calc.autoTransport.inboundM3.toFixed(1)} m³ / 40 m³ per truck`,
      ], { indent: 2 });
      ws.getCell(`F${inbRow}`).value = { formula: `B${inbRow}*D${inbRow}` };
      ws.getCell(`D${inbRow}`).numFmt = EUR;
      ws.getCell(`F${inbRow}`).numFmt = EUR;
      ws.getCell(`E${inbRow}`).numFmt = NUM;
      row++;

      const outRow = row;
      ws.getRow(outRow).outlineLevel = 1;
      ws.getRow(outRow).hidden = true;
      setRow(outRow, [
        "← Lodz → Raamsdonksveer — bouwpakket",
        calc.autoTransport.outboundTrucks, "truck(s)", 1600, calc.autoTransport.outboundM3, null,
        `${calc.autoTransport.outboundM3.toFixed(1)} m³ / 30 m³ per truck`,
      ], { indent: 2 });
      ws.getCell(`F${outRow}`).value = { formula: `B${outRow}*D${outRow}` };
      ws.getCell(`D${outRow}`).numFmt = EUR;
      ws.getCell(`F${outRow}`).numFmt = EUR;
      ws.getCell(`E${outRow}`).numFmt = NUM;
      row++;

      const tpEnd = row - 1;
      setRow(tpHeaderRow, ["Transport Polen", null, null, null, null, null, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`F${tpHeaderRow}`).value = { formula: `SUBTOTAL(9,F${tpStart}:F${tpEnd})` };
      ws.getCell(`F${tpHeaderRow}`).numFmt = EUR;
      ws.getCell(`F${tpHeaderRow}`).font = { name: "Inter", size: 10, bold: true };
    } else if (g.transportCost > 0) {
      const trRow = row;
      setRow(trRow, ["Transport", null, null, null, null, g.transportCost, null], {
        bold: true, indent: 1, fill: COLOR.rowAlt,
      });
      ws.getCell(`F${trRow}`).numFmt = EUR;
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
    setRow(subtotalRow, [`Subtotaal ${displayLabel.toLowerCase()}`, null, null, null, null, null, null], {
      bold: true, indent: 1, borderTop: true,
    });
    ws.getCell(`F${subtotalRow}`).value = hasLeafData
      ? { formula: `SUBTOTAL(9,F${groupDataStart}:F${groupDataEnd})` }
      : 0;
    ws.getCell(`F${subtotalRow}`).numFmt = EUR;
    ws.getCell(`F${subtotalRow}`).font = { name: "Inter", size: 10, bold: true };
    groupCells[groupKey].directCellRef = `F${subtotalRow}`;
    row++;
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

  // ── Markups per groep (editable percentages, formules) ─────────
  // We plaatsen alle markups in één compacte sectie, met verwijzing naar de
  // directCellRef van de juiste groep. Bedrag = basisAmount × percentage.
  const mkStart = row;
  ws.mergeCells(`A${row}:G${row}`);
  const mkHdr = ws.getCell(`A${row}`);
  mkHdr.value = "OPSLAGEN & MARGES";
  mkHdr.font = { name: "Inter", size: 11, bold: true, color: { argb: COLOR.headerText } };
  mkHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.staart } };
  mkHdr.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(row).height = 22;
  row++;

  setRow(row, ["Naam", "Waarde", "", "Type", "Basis", "Bedrag", "Groep"], {
    bold: true, color: COLOR.muted, fill: COLOR.rowAlt, indent: 1, borderBottom: true,
  });
  row++;

  // Formule-strategie: 2-pass, gelijk aan `calculateProject` in calculation.ts.
  //   Pass A — plaats alle markup-cellen. Voor basis die van later-berekende groottes
  //            afhangt (totaal_ex_derden, grand_total) laten we een placeholder "0"
  //            staan. We houden rijnummers bij per basis.
  //   Pass B — vul de placeholders in nadat alle bedrag-cellen bekend zijn, met de
  //            juiste basis volgens calc.ts. Dat borgt dat:
  //              • TED-markups in bp/ins/asm zichzelf niet meetellen (provisional).
  //              • TED-markups in hoofdaannemer (Coördinatie) ALLE bp/ins/asm-markups
  //                zien, inclusief AK/W&R.
  //              • grand_total = totaalExDerden + derden.subtotal (vast tijdens
  //                hele hoofdaannemer-pass).
  //              • bouwpakket_plus_assemblage = bp.subtotal + asm.subtotal.
  const markupAmountCells: Record<string, string[]> = {
    bouwpakket: [], installateur: [], assemblagehal: [], arbeid: [], derden: [], hoofdaannemer: [], _project: [],
  };
  const tedRowNums: { rowNum: number; group: string }[] = [];
  const grandTotalRowNums: number[] = [];
  const bpPlusAsmRowNums: number[] = [];
  const sortedMarkups = [...mkRows].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const m of sortedMarkups) {
    const groupRef = m.costGroup ? groupCells[m.costGroup as CostGroup].directCellRef : null;
    const groupLabel = m.costGroup ? COST_GROUP_LABELS[m.costGroup as CostGroup] : "Staart";
    const typeLabel = m.type === "percentage" ? "%" : m.type === "per_m2" ? "€/m²" : "vast";
    const basisLabel = m.type === "percentage" ? BASIS_LABELS[m.basis] ?? "—" : "—";

    const rowNum = row;
    setRow(rowNum, [m.name, m.value, "", typeLabel, basisLabel, null, groupLabel], { indent: 1 });
    ws.getCell(`B${rowNum}`).numFmt = m.type === "percentage" ? "0.00" : m.type === "per_m2" ? EUR2 : EUR;
    ws.getCell(`D${rowNum}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
    ws.getCell(`E${rowNum}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };
    ws.getCell(`G${rowNum}`).font = { name: "Inter", size: 9, color: { argb: COLOR.muted } };

    const gfaRef = `$F$${kpiStart + 3}`;
    let amountFormula: string;
    if (m.type === "percentage") {
      if (m.basis === "group_direct") {
        amountFormula = `${groupRef ?? "0"}*B${rowNum}/100`;
      } else if (m.basis === "group_cumulative") {
        // Groep-subtotaal + voorgaande NIET-TED markups in dezelfde groep (TED komt later).
        const prev = [...(markupAmountCells[m.costGroup as string] ?? [])];
        amountFormula = `(${groupRef ?? "0"}${prev.length > 0 ? "+" + prev.join("+") : ""})*B${rowNum}/100`;
      } else if (m.basis === "inkoop_derden") {
        amountFormula = `(${groupCells.derden.directCellRef ?? "0"})*B${rowNum}/100`;
      } else if (m.basis === "totaal_ex_derden") {
        amountFormula = "0"; // fill in pass B
        tedRowNums.push({ rowNum, group: m.costGroup as string });
      } else if (m.basis === "bouwpakket_plus_assemblage") {
        amountFormula = "0"; // fill in pass B (nodig na TED — bp.subtotal omvat marge_bp)
        bpPlusAsmRowNums.push(rowNum);
      } else if (m.basis === "grand_total") {
        amountFormula = "0"; // fill in pass B
        grandTotalRowNums.push(rowNum);
      } else {
        amountFormula = "0";
      }
    } else if (m.type === "per_m2") {
      amountFormula = `B${rowNum}*${gfaRef}`;
    } else {
      amountFormula = `B${rowNum}`; // fixed
    }
    ws.getCell(`F${rowNum}`).value = { formula: amountFormula };
    ws.getCell(`F${rowNum}`).numFmt = EUR;
    ws.getCell(`F${rowNum}`).font = { name: "Inter", size: 10, bold: true };

    const bucket = m.costGroup ?? "_project";
    markupAmountCells[bucket].push(`F${rowNum}`);
    row++;
  }
  const mkEnd = row - 1;

  // ── Pass B: vul placeholder-formules in ─────────────────────────
  const bpRef  = groupCells.bouwpakket.directCellRef  ?? "0";
  const insRef = groupCells.installateur.directCellRef ?? "0";
  const asmRef = groupCells.assemblagehal.directCellRef ?? "0";
  const derRef = groupCells.derden.directCellRef       ?? "0";

  // TED-markups:
  //   in bp/ins/asm zelf: basis = bp + ins + asm + NON-TED markups in die 3 groepen
  //                      (niet zichzelf of andere TED — voorkomt circulariteit).
  //   in hoofdaannemer  : basis = bp + ins + asm + ALLE markups in die 3 groepen
  //                      (inclusief TED — die zijn inmiddels berekend).
  for (const { rowNum, group } of tedRowNums) {
    const allBpInsAsmMk = [
      ...markupAmountCells.bouwpakket,
      ...markupAmountCells.installateur,
      ...markupAmountCells.assemblagehal,
    ];
    const nonTedBpInsAsmMk = allBpInsAsmMk.filter(
      (cellRef) => !tedRowNums.some((t) => `F${t.rowNum}` === cellRef),
    );
    const markupsPart = group === "hoofdaannemer" ? allBpInsAsmMk : nonTedBpInsAsmMk;
    const terms = [bpRef, insRef, asmRef, ...markupsPart].filter((t) => t && t !== "0");
    ws.getCell(`F${rowNum}`).value = { formula: `(${terms.join("+")})*B${rowNum}/100` };
  }

  // bouwpakket_plus_assemblage (Onvoorzien): bp.subtotal + asm.subtotal
  // = bp_direct + asm_direct + alle markups in bp + alle markups in asm.
  if (bpPlusAsmRowNums.length > 0) {
    const terms = [
      bpRef, asmRef,
      ...markupAmountCells.bouwpakket,
      ...markupAmountCells.assemblagehal,
    ].filter((t) => t && t !== "0");
    for (const rn of bpPlusAsmRowNums) {
      ws.getCell(`F${rn}`).value = { formula: `(${terms.join("+")})*B${rn}/100` };
    }
  }

  // grand_total (ABK, CAR): basis = totaalExDerden + derden.subtotal
  // = bp + ins + asm + der + alle markups in die 4 groepen.
  if (grandTotalRowNums.length > 0) {
    const markupParts = [
      ...markupAmountCells.bouwpakket,
      ...markupAmountCells.installateur,
      ...markupAmountCells.assemblagehal,
      ...markupAmountCells.derden,
    ];
    const terms = [bpRef, insRef, asmRef, derRef, ...markupParts].filter((t) => t && t !== "0");
    const baseExpr = terms.join("+");
    for (const rn of grandTotalRowNums) {
      ws.getCell(`F${rn}`).value = { formula: `(${baseExpr})*B${rn}/100` };
    }
  }

  row++;
  // ── Grand total ────────────────────────────────────────────────
  ws.mergeCells(`A${row}:G${row}`);
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
  const grandFormula = `SUBTOTAL(9,F${grandStart}:F${grandEnd})`;
  setRow(grandTotalRow, ["Totaal project", null, null, null, null, null, null], {
    bold: true, color: COLOR.brand, indent: 1, fill: COLOR.brandSoft,
  });
  ws.getCell(`F${grandTotalRow}`).value = { formula: grandFormula };
  ws.getCell(`F${grandTotalRow}`).numFmt = EUR;
  ws.getCell(`F${grandTotalRow}`).font = { name: "Inter", size: 14, bold: true, color: { argb: COLOR.brand } };
  ws.getCell(`F${grandTotalRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.brandSoft } };
  ws.getRow(grandTotalRow).height = 26;
  row++;

  // Overschrijf KPI's (bovenaan) met formules zodat ze meebewegen met bewerkingen.
  //   kpiStart+1 = Totaal excl. BTW, kpiStart+2 = Prijs per m² BVO, kpiStart+3 = BVO totaal.
  ws.getCell(`F${kpiStart + 1}`).value = { formula: `F${grandTotalRow}` };
  ws.getCell(`F${kpiStart + 1}`).numFmt = EUR;
  ws.getCell(`F${kpiStart + 2}`).value = { formula: `IFERROR(F${grandTotalRow}/F${kpiStart + 3},0)` };
  ws.getCell(`F${kpiStart + 2}`).numFmt = EUR;

  // Prijs per m² BVO als afgeleide
  const pricePerM2Row = row;
  const gfaRefBvo = `$F$${kpiStart + 3}`;
  setRow(pricePerM2Row, ["Prijs per m² BVO", null, null, null, null, null, null], {
    italic: true, color: COLOR.muted, indent: 1,
  });
  ws.getCell(`F${pricePerM2Row}`).value = { formula: `IFERROR(F${grandTotalRow}/${gfaRefBvo},0)` };
  ws.getCell(`F${pricePerM2Row}`).numFmt = EUR;
  row++;

  // Freeze top header rows.
  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];

  // Ingebouwde outline-properties: default dicht.
  ws.properties = { ...ws.properties, outlineProperties: { summaryBelow: false, summaryRight: false } };

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
