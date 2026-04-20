import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { kengetalLabour } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const rows = await db.select().from(kengetalLabour).where(eq(kengetalLabour.setId, params.id));
  return NextResponse.json(rows);
}

/**
 * Upsert by (setId, inputLabel). Body: { inputLabel, costGroup?, hoursPerInput, description? }.
 * Sending `hoursPerInput=0` keeps the row (zo blijft de costGroup-keuze bewaard).
 */
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  if (!body.inputLabel) return NextResponse.json({ error: "Missing inputLabel" }, { status: 400 });
  const existing = await db.query.kengetalLabour.findFirst({
    where: and(eq(kengetalLabour.setId, params.id), eq(kengetalLabour.inputLabel, body.inputLabel)),
  });
  const editableKeys = [
    "costGroup", "hoursPerInput", "installatieHoursPerInput", "description",
    "gezaagdM3PerInput", "cncSimpelM3PerInput", "cncComplexM3PerInput",
  ];
  if (existing) {
    const updates: Record<string, any> = {};
    for (const k of editableKeys) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    const [updated] = await db.update(kengetalLabour).set(updates).where(eq(kengetalLabour.id, existing.id)).returning();
    return NextResponse.json(updated);
  }
  const [created] = await db.insert(kengetalLabour).values({
    setId: params.id,
    inputLabel: body.inputLabel,
    costGroup: body.costGroup ?? "arbeid",
    hoursPerInput: body.hoursPerInput ?? 0,
    installatieHoursPerInput: body.installatieHoursPerInput ?? 0,
    gezaagdM3PerInput: body.gezaagdM3PerInput ?? 0,
    cncSimpelM3PerInput: body.cncSimpelM3PerInput ?? 0,
    cncComplexM3PerInput: body.cncComplexM3PerInput ?? 0,
    description: body.description ?? null,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const url = new URL(request.url);
  const inputLabel = url.searchParams.get("inputLabel");
  if (!inputLabel) return NextResponse.json({ error: "Missing inputLabel" }, { status: 400 });
  await db.delete(kengetalLabour).where(
    and(eq(kengetalLabour.setId, params.id), eq(kengetalLabour.inputLabel, inputLabel)),
  );
  return NextResponse.json({ ok: true });
}
