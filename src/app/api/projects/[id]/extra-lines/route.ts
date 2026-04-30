import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExtraLines } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const rows = await db.select()
    .from(projectExtraLines)
    .where(eq(projectExtraLines.projectId, params.id))
    .orderBy(projectExtraLines.sortOrder);
  return NextResponse.json(rows);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({} as any));
  const existing = await db.select().from(projectExtraLines).where(eq(projectExtraLines.projectId, params.id));
  const sortOrder = existing.length;
  const [created] = await db.insert(projectExtraLines).values({
    projectId: params.id,
    costGroup: body.costGroup ?? "assemblagehal",
    description: body.description ?? "Nieuwe post",
    quantity: body.quantity ?? 1,
    unit: body.unit ?? "stuks",
    pricePerUnit: body.pricePerUnit ?? 0,
    sortOrder,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const updates: Record<string, any> = {};
  for (const k of ["description", "quantity", "unit", "pricePerUnit", "costGroup", "sortOrder"]) {
    if (body[k] !== undefined) updates[k] = body[k];
  }
  const [updated] = await db.update(projectExtraLines)
    .set(updates)
    .where(and(eq(projectExtraLines.id, body.id), eq(projectExtraLines.projectId, params.id)))
    .returning();
  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(projectExtraLines).where(
    and(eq(projectExtraLines.id, id), eq(projectExtraLines.projectId, params.id)),
  );
  return NextResponse.json({ ok: true });
}
