import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { kengetalSets } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const set = await db.query.kengetalSets.findFirst({
    where: eq(kengetalSets.id, params.id),
  });
  if (!set) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(set);
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const [updated] = await db.update(kengetalSets)
    .set(body)
    .where(eq(kengetalSets.id, params.id))
    .returning();
  return NextResponse.json(updated);
}
