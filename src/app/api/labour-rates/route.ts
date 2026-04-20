import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { labourRates } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

const editableKeys = [
  "gezaagdPerM3", "cncSimpelPerM3", "cncComplexPerM3",
  "assemblageHourlyRate", "installatieHourlyRate",
  "arbeidBuitenHourlyRate", "arbeidBuitenHoursPerModule",
  "projectmgmtHourlyRate", "projectmgmtHoursPerModule",
] as const;

async function ensureRow(orgId: string) {
  const existing = await db.query.labourRates.findFirst({ where: eq(labourRates.orgId, orgId) });
  if (existing) return existing;
  const [created] = await db.insert(labourRates).values({ orgId }).returning();
  return created;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await ensureRow(user.orgId);
  return NextResponse.json(row);
}

export async function PUT(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.orgRole !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json();
  const row = await ensureRow(user.orgId);
  const updates: Record<string, any> = {};
  for (const k of editableKeys) {
    if (body[k] !== undefined) {
      const v = Number(body[k]);
      if (Number.isFinite(v) && v >= 0) updates[k] = v;
    }
  }
  if (Object.keys(updates).length === 0) return NextResponse.json(row);
  const [updated] = await db.update(labourRates).set(updates).where(eq(labourRates.id, row.id)).returning();
  return NextResponse.json(updated);
}
