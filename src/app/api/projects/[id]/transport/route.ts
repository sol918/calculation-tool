import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectTransport } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const all = await db.select().from(projectTransport)
    .where(eq(projectTransport.projectId, params.id))
    .orderBy(projectTransport.sortOrder);
  return NextResponse.json(all);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const existing = await db.select().from(projectTransport)
    .where(eq(projectTransport.projectId, params.id));

  const [created] = await db.insert(projectTransport).values({
    projectId: params.id,
    description: body.description || "Nieuw transport",
    distanceKm: body.distanceKm || 0,
    vehicleTypeId: body.vehicleTypeId,
    tripCount: body.tripCount || 1,
    costPerTripOverride: body.costPerTripOverride,
    sortOrder: existing.length,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}

export async function PUT(request: Request) {
  const body = await request.json();
  if (body.id) {
    const { id, ...updates } = body;
    const [updated] = await db.update(projectTransport)
      .set(updates)
      .where(eq(projectTransport.id, id))
      .returning();
    return NextResponse.json(updated);
  }
  return NextResponse.json({ error: "Missing id" }, { status: 400 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const rowId = searchParams.get("rowId");
  if (rowId) {
    await db.delete(projectTransport).where(eq(projectTransport.id, rowId));
  }
  return NextResponse.json({ ok: true });
}
