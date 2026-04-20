import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { modules } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const rows = await db.select().from(modules).where(eq(modules.buildingId, params.id)).orderBy(modules.sortOrder);
  return NextResponse.json(rows);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const existing = await db.select().from(modules).where(eq(modules.buildingId, params.id));
  const [created] = await db.insert(modules).values({
    buildingId: params.id,
    name: body.name || `Type ${existing.length + 1}`,
    lengthM: body.lengthM ?? 0,
    widthM: body.widthM ?? 0,
    heightM: body.heightM ?? 0,
    count: body.count ?? 1,
    isRoof: !!body.isRoof,
    sortOrder: existing.length,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const { id, ...rest } = body;
  const updates: Record<string, any> = {};
  for (const k of ["name", "lengthM", "widthM", "heightM", "count", "isRoof", "sortOrder"]) {
    if (rest[k] !== undefined) updates[k] = rest[k];
  }
  const [updated] = await db.update(modules).set(updates).where(eq(modules.id, id)).returning();
  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(modules).where(eq(modules.id, id));
  return NextResponse.json({ ok: true });
}
