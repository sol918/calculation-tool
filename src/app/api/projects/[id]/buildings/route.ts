import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildings, buildingInputs, kengetalRows, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { MODULE_DERIVED_LABELS } from "@/types";

const DERIVED = new Set<string>(Object.values(MODULE_DERIVED_LABELS));

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const all = await db.select().from(buildings).where(eq(buildings.projectId, params.id)).orderBy(buildings.sortOrder);
  return NextResponse.json(all);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const existing = await db.select().from(buildings).where(eq(buildings.projectId, params.id));
  const project = await db.query.projects.findFirst({ where: eq(projects.id, params.id) });

  const setId: string | null | undefined = body.kengetalSetId ?? project?.defaultKengetalSetId ?? null;

  const [building] = await db.insert(buildings).values({
    projectId: params.id,
    name: body.name || `Gebouw ${existing.length + 1}`,
    count: body.count || 1,
    kengetalSetId: setId,
    sortOrder: existing.length,
  }).returning();

  // Auto-create building inputs from the chosen kengetal set — but skip module-derived labels.
  if (setId) {
    const kRows = await db.select().from(kengetalRows).where(eq(kengetalRows.setId, setId));
    const uniqueLabels = new Map<string, string>();
    for (const row of kRows) {
      if (DERIVED.has(row.inputLabel)) continue;
      if (!uniqueLabels.has(row.inputLabel)) uniqueLabels.set(row.inputLabel, row.inputUnit);
    }
    let sortIdx = 0;
    for (const [label] of uniqueLabels) {
      await db.insert(buildingInputs).values({
        buildingId: building.id, inputLabel: label, quantity: 0, sortOrder: sortIdx++,
      });
    }
  }
  return NextResponse.json(building, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const { id, ...rest } = body;
  const updates: Record<string, any> = {};
  for (const k of ["name", "count", "kengetalSetId", "sortOrder"]) {
    if (rest[k] !== undefined) updates[k] = rest[k];
  }
  const [updated] = await db.update(buildings).set(updates).where(eq(buildings.id, id)).returning();

  // If kengetalSetId changed, (re)create building inputs for new set's labels that don't yet exist.
  if (updates.kengetalSetId) {
    const kRows = await db.select().from(kengetalRows).where(eq(kengetalRows.setId, updates.kengetalSetId));
    const existingInputs = await db.select().from(buildingInputs).where(eq(buildingInputs.buildingId, id));
    const existingLabels = new Set(existingInputs.map((i) => i.inputLabel));
    const wantedLabels = new Map<string, string>();
    for (const row of kRows) {
      if (DERIVED.has(row.inputLabel)) continue;
      if (!wantedLabels.has(row.inputLabel)) wantedLabels.set(row.inputLabel, row.inputUnit);
    }
    let sortIdx = existingInputs.length;
    for (const [label] of wantedLabels) {
      if (!existingLabels.has(label)) {
        await db.insert(buildingInputs).values({ buildingId: id, inputLabel: label, quantity: 0, sortOrder: sortIdx++ });
      }
    }
  }
  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(buildings).where(eq(buildings.id, id));
  return NextResponse.json({ ok: true });
}
