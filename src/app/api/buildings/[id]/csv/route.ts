import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildingCsvData, csvMaterialOverrides, materials } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { parseAndAggregateCsv, CSV_CODE_MAP } from "@/lib/calculation";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";

// GET — huidige CSV-aggregates + per-material overrides voor dit gebouw.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agg = await db.select().from(buildingCsvData).where(eq(buildingCsvData.buildingId, params.id));
  const ovr = await db.select().from(csvMaterialOverrides).where(eq(csvMaterialOverrides.buildingId, params.id));
  const fileName = agg[0]?.fileName ?? null;
  const uploadedAt = agg[0]?.uploadedAt ?? null;
  return NextResponse.json({
    aggregates: agg.map((a) => ({
      csvCode: a.csvCode, unit: a.unit, totalCount: a.totalCount,
      totalVolumeM3: a.totalVolumeM3, totalLengthM1: a.totalLengthM1, totalAreaM2: a.totalAreaM2,
    })),
    overrides: ovr,
    fileName, uploadedAt,
  });
}

// POST — upload CSV (als rauwe tekst in body), parse + vervang alle aggregates voor
// dit gebouw. Behoudt bestaande overrides.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const text: string = body.text ?? "";
  const fileName: string = body.fileName ?? "upload.csv";
  if (!text) return NextResponse.json({ error: "Geen CSV-tekst meegestuurd" }, { status: 400 });

  const aggs = parseAndAggregateCsv(text);
  if (aggs.length === 0) return NextResponse.json({ error: "CSV kon niet worden gelezen (header of data ontbreekt)" }, { status: 400 });

  // Wis bestaande aggregates, insert nieuwe.
  await db.delete(buildingCsvData).where(eq(buildingCsvData.buildingId, params.id));
  const now = new Date().toISOString();
  for (const a of aggs) {
    await db.insert(buildingCsvData).values({
      id: crypto.randomUUID(),
      buildingId: params.id,
      csvCode: a.csvCode,
      unit: a.unit,
      totalCount: a.totalCount,
      totalVolumeM3: a.totalVolumeM3,
      totalLengthM1: a.totalLengthM1,
      totalAreaM2: a.totalAreaM2,
      uploadedAt: now,
      fileName,
    });
  }

  // Auto-mapping voor bekende codes (zonder useCsv default = false).
  const allMats = await db.select().from(materials);
  const byCode = new Map(allMats.map((m) => [m.code, m]));
  for (const a of aggs) {
    const mappedCode = CSV_CODE_MAP[a.csvCode] ?? null;
    if (!mappedCode) continue;
    const mat = byCode.get(mappedCode);
    if (!mat) continue;
    const existing = await db.select().from(csvMaterialOverrides)
      .where(and(eq(csvMaterialOverrides.buildingId, params.id), eq(csvMaterialOverrides.materialId, mat.id)));
    if (existing.length > 0) {
      // Update csvCode/unit koppeling; useCsv blijft op de huidige waarde.
      await db.update(csvMaterialOverrides)
        .set({ csvCode: a.csvCode, csvUnit: a.unit })
        .where(and(eq(csvMaterialOverrides.buildingId, params.id), eq(csvMaterialOverrides.materialId, mat.id)));
    } else {
      await db.insert(csvMaterialOverrides).values({
        buildingId: params.id,
        materialId: mat.id,
        csvCode: a.csvCode,
        csvUnit: a.unit,
        useCsv: false,
      });
    }
  }

  return NextResponse.json({ ok: true, aggregateCount: aggs.length });
}

// PATCH — bulk update per-materiaal toggles.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const updates: { materialId: string; csvCode?: string; csvUnit?: string; useCsv?: boolean }[] = body.overrides ?? [];
  for (const u of updates) {
    const existing = await db.select().from(csvMaterialOverrides)
      .where(and(eq(csvMaterialOverrides.buildingId, params.id), eq(csvMaterialOverrides.materialId, u.materialId)));
    if (existing.length > 0) {
      await db.update(csvMaterialOverrides)
        .set({
          csvCode: u.csvCode ?? existing[0].csvCode,
          csvUnit: u.csvUnit ?? existing[0].csvUnit,
          useCsv: u.useCsv ?? existing[0].useCsv,
        })
        .where(and(eq(csvMaterialOverrides.buildingId, params.id), eq(csvMaterialOverrides.materialId, u.materialId)));
    } else if (u.csvCode && u.csvUnit) {
      await db.insert(csvMaterialOverrides).values({
        buildingId: params.id,
        materialId: u.materialId,
        csvCode: u.csvCode,
        csvUnit: u.csvUnit,
        useCsv: u.useCsv ?? false,
      });
    }
  }
  return NextResponse.json({ ok: true });
}

// DELETE — wis alle CSV-data + overrides voor dit gebouw.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await db.delete(buildingCsvData).where(eq(buildingCsvData.buildingId, params.id));
  await db.delete(csvMaterialOverrides).where(eq(csvMaterialOverrides.buildingId, params.id));
  return NextResponse.json({ ok: true });
}
