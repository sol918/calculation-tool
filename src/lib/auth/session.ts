import { auth } from "./index";
import { db } from "@/lib/db";
import { users, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { SessionUser } from "@/types";

/**
 * Resolves the current session user against the *live* DB by email, so a stale JWT
 * (e.g. after a dev re-seed where IDs changed) still returns the correct current
 * record. Returns null if the session is missing or the email no longer exists.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.email) return null;
  const email = session.user.email;

  const u = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!u) return null;
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, u.orgId) });
  if (!org) return null;

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    orgId: u.orgId,
    orgRole: org.role,
    orgName: org.name,
  };
}
