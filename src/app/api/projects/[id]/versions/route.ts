import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, or, sql } from "drizzle-orm";

/** Return all projects that share the same lineage (same rootProjectId family). */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const me = await db.query.projects.findFirst({ where: eq(projects.id, params.id) });
  if (!me) return NextResponse.json([], { status: 200 });
  const rootId = me.rootProjectId ?? me.id;

  const all = await db.select().from(projects).where(
    or(eq(projects.id, rootId), eq(projects.rootProjectId, rootId)),
  ).orderBy(sql`${projects.createdAt} ASC`);

  return NextResponse.json(all);
}
