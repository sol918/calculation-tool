import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects, buildings, modules, buildingInputs, overrides,
  projectTransport, markupRows,
} from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const src = await db.query.projects.findFirst({ where: eq(projects.id, params.id) });
  if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [cloneProj] = await db.insert(projects).values({
    name: `${src.name} (kopie)`,
    client: src.client,
    assemblyParty: src.assemblyParty,
    ownerOrgId: src.ownerOrgId,
    defaultKengetalSetId: src.defaultKengetalSetId,
    rootProjectId: src.rootProjectId ?? src.id, // keep the lineage
    hourlyRate: src.hourlyRate,
    status: src.status,
    notes: src.notes,
  }).returning();

  // Clone buildings (keep mapping old → new id so we can clone children)
  const srcBuildings = await db.select().from(buildings).where(eq(buildings.projectId, src.id));
  const bMap = new Map<string, string>();
  for (const b of srcBuildings) {
    const [nb] = await db.insert(buildings).values({
      projectId: cloneProj.id,
      name: b.name, count: b.count, kengetalSetId: b.kengetalSetId, sortOrder: b.sortOrder,
    }).returning();
    bMap.set(b.id, nb.id);
  }

  // Clone modules, inputs, overrides per building
  for (const [oldBid, newBid] of bMap) {
    const srcMods = await db.select().from(modules).where(eq(modules.buildingId, oldBid));
    for (const m of srcMods) {
      await db.insert(modules).values({
        buildingId: newBid, name: m.name, lengthM: m.lengthM, widthM: m.widthM,
        heightM: m.heightM, count: m.count, sortOrder: m.sortOrder,
      });
    }
    const srcInputs = await db.select().from(buildingInputs).where(eq(buildingInputs.buildingId, oldBid));
    for (const i of srcInputs) {
      await db.insert(buildingInputs).values({
        buildingId: newBid, inputLabel: i.inputLabel, quantity: i.quantity,
        source: i.source, sourceRef: i.sourceRef, sortOrder: i.sortOrder,
      });
    }
    const srcOv = await db.select().from(overrides).where(eq(overrides.buildingId, oldBid));
    for (const o of srcOv) {
      await db.insert(overrides).values({
        buildingId: newBid, materialId: o.materialId,
        quantity: o.quantity, pricePerUnit: o.pricePerUnit, lossPct: o.lossPct, laborHours: o.laborHours,
        source: o.source, note: o.note, createdBy: o.createdBy,
      });
    }
  }

  // Transport
  const srcTr = await db.select().from(projectTransport).where(eq(projectTransport.projectId, src.id));
  for (const t of srcTr) {
    await db.insert(projectTransport).values({
      projectId: cloneProj.id, description: t.description, costGroup: t.costGroup,
      distanceKm: t.distanceKm, vehicleTypeId: t.vehicleTypeId, tripCount: t.tripCount,
      costPerTripOverride: t.costPerTripOverride, sortOrder: t.sortOrder,
    });
  }

  // Markup rows
  const srcMk = await db.select().from(markupRows).where(eq(markupRows.projectId, src.id));
  for (const m of srcMk) {
    await db.insert(markupRows).values({
      projectId: cloneProj.id, costGroup: m.costGroup, name: m.name,
      type: m.type, value: m.value, basis: m.basis, sortOrder: m.sortOrder,
    });
  }

  return NextResponse.json(cloneProj, { status: 201 });
}
