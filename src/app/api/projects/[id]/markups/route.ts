import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { markupRows } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const rows = await db.select().from(markupRows).where(eq(markupRows.projectId, params.id)).orderBy(markupRows.sortOrder);
  return NextResponse.json(rows);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const existing = await db.select().from(markupRows)
    .where(eq(markupRows.projectId, params.id));
  const inGroup = existing.filter((r) => r.costGroup === (body.costGroup ?? null));

  const [created] = await db.insert(markupRows).values({
    projectId: params.id,
    costGroup: body.costGroup ?? null,
    name: body.name || "Nieuwe opslag",
    type: body.type || "percentage",
    value: body.value ?? 0,
    basis: body.basis || (body.costGroup ? "group_direct" : "grand_total"),
    sortOrder: inGroup.length,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const { id, ...rest } = body;
  const updates: Record<string, any> = {};
  for (const k of ["name", "type", "value", "basis", "sortOrder", "costGroup"]) {
    if (rest[k] !== undefined) updates[k] = rest[k];
  }
  const [updated] = await db.update(markupRows).set(updates).where(eq(markupRows.id, id)).returning();
  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(markupRows).where(eq(markupRows.id, id));
  return NextResponse.json({ ok: true });
}
