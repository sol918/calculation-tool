import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vehicleTypes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  const all = await db.select().from(vehicleTypes);
  return NextResponse.json(all);
}

export async function POST(request: Request) {
  const body = await request.json();
  const [created] = await db.insert(vehicleTypes).values({
    name: body.name,
    costPerKm: body.costPerKm || 0,
    co2PerKm: body.co2PerKm,
    maxVolumeM3: body.maxVolumeM3,
    maxWeightKg: body.maxWeightKg,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}
