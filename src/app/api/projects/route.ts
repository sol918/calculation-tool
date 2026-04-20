import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, markupRows } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const all = user.orgRole === "owner"
    ? await db.select().from(projects).orderBy(projects.createdAt)
    : await db.select().from(projects).where(eq(projects.ownerOrgId, user.orgId)).orderBy(projects.createdAt);
  return NextResponse.json(all);
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const [created] = await db.insert(projects).values({
    name: body.name || "Nieuw project",
    client: body.client ?? "Timberfy",
    assemblyParty: body.assemblyParty ?? "Stamhuis",
    ownerOrgId: user.orgId,
    status: "SO",
    notes: body.notes,
    // Default-bestemming zodat het assemblagehal-transport direct wordt berekend
    // (anders skipt de auto-fetch en blijft die post leeg in de begroting).
    destinationAddress: body.destinationAddress ?? "Amsterdam, Nederland",
  }).returning();

  // Seed sensible default markup rows (mirroring the reference Excel) so a fresh project
  // isn't a blank slate. User can edit/delete in the begroting.
  const defaults: { costGroup: any; name: string; type: any; value: number; basis: any; sort: number }[] = [
    { costGroup: "bouwpakket",    name: "Marge bouwpakket",         type: "percentage", value: 0,    basis: "group_cumulative", sort: 0 },
    { costGroup: "installateur",  name: "Marge installateur",       type: "percentage", value: 0,    basis: "group_cumulative", sort: 0 },
    // "Correctiefactor inefficiëntie" — opslag die productieverliezen/inefficiëntie
    // afvangt. Apart zichtbaar (niet verstopt in de DeJong-leercurve) zodat de
    // gebruiker direct ziet waar dit getal vandaan komt.
    { costGroup: "assemblagehal", name: "Correctiefactor inefficiëntie", type: "percentage", value: 5,    basis: "group_cumulative", sort: 0 },
    { costGroup: "assemblagehal", name: "AK Assemblagehal",         type: "percentage", value: 12.5, basis: "totaal_ex_derden", sort: 1 },
    { costGroup: "assemblagehal", name: "W&R Assemblagehal",        type: "percentage", value: 3.0,  basis: "totaal_ex_derden", sort: 2 },
    { costGroup: "derden",        name: "AK + W&R",                 type: "percentage", value: 14,   basis: "inkoop_derden",    sort: 1 },
    { costGroup: "hoofdaannemer", name: "Coördinatie",              type: "percentage", value: 5,    basis: "totaal_ex_derden", sort: 1 },
    { costGroup: "hoofdaannemer", name: "ABK",                      type: "percentage", value: 7,    basis: "grand_total",      sort: 2 },
    { costGroup: "hoofdaannemer", name: "CAR",                      type: "percentage", value: 0.3,  basis: "grand_total",      sort: 3 },
    { costGroup: "hoofdaannemer", name: "Onvoorzien",               type: "percentage", value: 8,    basis: "bouwpakket_plus_assemblage", sort: 4 },
  ];
  for (const d of defaults) {
    await db.insert(markupRows).values({
      projectId: created.id,
      costGroup: d.costGroup, name: d.name, type: d.type, value: d.value, basis: d.basis, sortOrder: d.sort,
    });
  }

  return NextResponse.json(created, { status: 201 });
}
