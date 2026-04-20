import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { materials } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { eq } from "drizzle-orm";

export async function GET() {
  const all = await db.select().from(materials).orderBy(materials.costGroup, materials.category, materials.code);
  return NextResponse.json(all);
}

async function uniqueCode(base: string): Promise<string> {
  const existing = await db.select({ code: materials.code }).from(materials);
  const taken = new Set(existing.map((r) => r.code));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!can(user, "materials_write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json();
  const code = body.code ? await uniqueCode(body.code) : await uniqueCode("NIEUW");
  const [created] = await db.insert(materials).values({
    code,
    name: body.name || "Nieuw materiaal",
    unit: body.unit || "m3",
    category: body.category || "Overig",
    costGroup: body.costGroup || "assemblagehal",
    pricePerUnit: body.pricePerUnit ?? 0,
    lossPct: body.lossPct ?? 0,
    laborHours: body.laborHours ?? 0,
    description: body.description,
    updatedBy: user!.id,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await getSessionUser();
  if (!can(user, "materials_write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json();
  const { id, ...updates } = body;
  const [updated] = await db.update(materials)
    .set({ ...updates, updatedAt: new Date().toISOString(), updatedBy: user!.id })
    .where(eq(materials.id, id))
    .returning();
  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  const user = await getSessionUser();
  if (!can(user, "materials_write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(materials).where(eq(materials.id, id));
  return NextResponse.json({ ok: true });
}
