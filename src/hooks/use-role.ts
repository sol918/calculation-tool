"use client";

import { useSession } from "next-auth/react";
import type { OrgRole, SessionUser } from "@/types";

export function useRole(): { user: SessionUser | null; role: OrgRole | null; loading: boolean } {
  const { data: session, status } = useSession();

  if (status === "loading") return { user: null, role: null, loading: true };
  if (!session?.user) return { user: null, role: null, loading: false };

  const u = session.user as any;
  return {
    user: {
      id: u.id,
      email: u.email!,
      name: u.name,
      orgId: u.orgId,
      orgRole: u.orgRole,
      orgName: u.orgName,
    },
    role: u.orgRole,
    loading: false,
  };
}
