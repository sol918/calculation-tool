import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { kengetalSets } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const all = await db.select().from(kengetalSets);
  return NextResponse.json(all);
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user || user.orgRole === "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json();
  const [created] = await db.insert(kengetalSets).values({
    name: body.name,
    description: body.description,
    orgId: user.orgId,
  }).returning();
  return NextResponse.json(created, { status: 201 });
}
