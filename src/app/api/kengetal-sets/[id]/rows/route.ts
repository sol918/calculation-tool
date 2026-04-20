import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { kengetalRows } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const rows = await db.select().from(kengetalRows)
    .where(eq(kengetalRows.setId, params.id))
    .orderBy(kengetalRows.sortOrder);
  return NextResponse.json(rows);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const existing = await db.select().from(kengetalRows)
    .where(eq(kengetalRows.setId, params.id));

  const [created] = await db.insert(kengetalRows).values({
    setId: params.id,
    inputLabel: body.inputLabel,
    inputUnit: body.inputUnit || "m2",
    materialId: body.materialId,
    ratio: body.ratio || 0,
    laborHoursPerInput: body.laborHoursPerInput ?? 0,
    description: body.description,
    sortOrder: existing.length,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const { id, ...rest } = body;
  const updates: Record<string, any> = {};
  for (const k of ["inputLabel", "inputUnit", "materialId", "ratio", "laborHoursPerInput", "description", "sortOrder"]) {
    if (rest[k] !== undefined) updates[k] = rest[k];
  }
  const [updated] = await db.update(kengetalRows).set(updates).where(eq(kengetalRows.id, id)).returning();
  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const rowId = searchParams.get("rowId");
  if (rowId) {
    await db.delete(kengetalRows).where(eq(kengetalRows.id, rowId));
  }
  return NextResponse.json({ ok: true });
}
