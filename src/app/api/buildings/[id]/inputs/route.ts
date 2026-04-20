import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildingInputs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const all = await db.select().from(buildingInputs)
    .where(eq(buildingInputs.buildingId, params.id))
    .orderBy(buildingInputs.sortOrder);
  return NextResponse.json(all);
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const body: { inputs: { id: string; quantity: number }[] } = await request.json();

  for (const input of body.inputs) {
    await db.update(buildingInputs)
      .set({ quantity: input.quantity })
      .where(and(eq(buildingInputs.id, input.id), eq(buildingInputs.buildingId, params.id)));
  }

  const all = await db.select().from(buildingInputs)
    .where(eq(buildingInputs.buildingId, params.id))
    .orderBy(buildingInputs.sortOrder);
  return NextResponse.json(all);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const existing = await db.select().from(buildingInputs)
    .where(eq(buildingInputs.buildingId, params.id));

  const [created] = await db.insert(buildingInputs).values({
    buildingId: params.id,
    inputLabel: body.inputLabel || "Nieuw veld",
    quantity: body.quantity || 0,
    source: body.source || "manual",
    sortOrder: existing.length,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}
