import type { SessionUser, OrgRole } from "@/types";

type Resource =
  | "materials_read" | "materials_write"
  | "kengetallen_read" | "kengetallen_write"
  | "labor_read" | "labor_write"
  | "transport_read" | "transport_write"
  | "prices_read" | "prices_write"
  | "projects_read" | "projects_write"
  | "tail_read" | "tail_write"
  | "inputs_read" | "inputs_write"
  | "admin";

const permissionMap: Record<Resource, OrgRole[]> = {
  materials_read: ["owner", "assembler", "developer"],
  materials_write: ["owner"],
  kengetallen_read: ["owner", "assembler"],
  kengetallen_write: ["owner", "assembler"],
  labor_read: ["owner", "assembler"],
  labor_write: ["owner", "assembler"],
  transport_read: ["owner", "assembler", "developer"],
  transport_write: ["owner", "assembler"],
  prices_read: ["owner", "assembler", "developer"],
  prices_write: ["owner", "assembler"],
  projects_read: ["owner", "assembler", "developer"],
  projects_write: ["owner", "assembler", "developer"],
  tail_read: ["owner", "assembler", "developer"],
  tail_write: ["owner", "assembler", "developer"],
  inputs_read: ["owner", "assembler", "developer"],
  inputs_write: ["owner", "assembler", "developer"],
  admin: ["owner"],
};

export function can(user: SessionUser | null, resource: Resource): boolean {
  if (!user) return false;
  return permissionMap[resource]?.includes(user.orgRole) ?? false;
}

export function canAccessProject(user: SessionUser, projectOrgId: string): boolean {
  if (user.orgRole === "owner") return true;
  return user.orgId === projectOrgId;
}

export function canAccessKengetalSet(user: SessionUser, setOrgId: string): boolean {
  if (user.orgRole === "owner") return true;
  if (user.orgRole === "assembler") return user.orgId === setOrgId;
  return false; // developer can never see kengetallen
}
