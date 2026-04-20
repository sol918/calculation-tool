import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { overrides } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth/session";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const all = await db.select().from(overrides)
    .where(eq(overrides.buildingId, params.id));
  return NextResponse.json(all);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  const body = await request.json();

  // Upsert: remove existing override for same material + source type, then insert
  if (body.materialId) {
    await db.delete(overrides).where(
      and(
        eq(overrides.buildingId, params.id),
        eq(overrides.materialId, body.materialId),
        eq(overrides.source, body.source || "manual"),
      ),
    );
  }

  const [created] = await db.insert(overrides).values({
    buildingId: params.id,
    materialId: body.materialId,
    quantity: body.quantity ?? null,
    pricePerUnit: body.pricePerUnit ?? null,
    lossPct: body.lossPct ?? null,
    laborHours: body.laborHours ?? null,
    source: body.source || "manual",
    note: body.note,
    createdBy: user?.id,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const { searchParams } = new URL(request.url);
  const overrideId = searchParams.get("overrideId");

  if (overrideId) {
    await db.delete(overrides).where(eq(overrides.id, overrideId));
  }
  return NextResponse.json({ ok: true });
}
