import type { InferSelectModel } from "drizzle-orm";
import type {
  organizations, users, materials, kengetalSets, kengetalRows, kengetalLabour,
  projects, buildings, buildingInputs, overrides,
  vehicleTypes, projectTransport, modules, markupRows, labourRates,
} from "@/lib/db/schema";

export type Organization = InferSelectModel<typeof organizations>;
export type User = InferSelectModel<typeof users>;
export type Material = InferSelectModel<typeof materials>;
export type KengetalSet = InferSelectModel<typeof kengetalSets>;
export type KengetalRow = InferSelectModel<typeof kengetalRows>;
export type KengetalLabour = InferSelectModel<typeof kengetalLabour>;
export type Project = InferSelectModel<typeof projects>;
export type Building = InferSelectModel<typeof buildings>;
export type BuildingInput = InferSelectModel<typeof buildingInputs>;
export type Override = InferSelectModel<typeof overrides>;
export type VehicleType = InferSelectModel<typeof vehicleTypes>;
export type ProjectTransport = InferSelectModel<typeof projectTransport>;
export type Module = InferSelectModel<typeof modules>;
export type MarkupRow = InferSelectModel<typeof markupRows>;
export type LabourRates = InferSelectModel<typeof labourRates>;

export type OrgRole = "owner" | "assembler" | "developer";
export type ProjectStatus = "draft" | "final" | "closed";
export type SourceType = "manual" | "api_architect" | "api_assembler" | "api_sustainer" | "csv";
export type CostGroup = "arbeid" | "bouwpakket" | "assemblagehal" | "installateur" | "derden" | "hoofdaannemer";
export type TransportGroup = "bouwpakket" | "assemblagehal";
export type MarkupType = "percentage" | "fixed" | "per_m2";
export type MarkupBasis = "group_direct" | "group_cumulative" | "totaal_ex_derden" | "inkoop_derden" | "grand_total" | "bouwpakket_plus_assemblage";

export interface MaterialCalcRow {
  material: Material;
  netto: number;
  nettoBron: string;
  loss: number;
  lossBron: string;
  bruto: number;
  price: number;
  priceBron: string;
  materialCost: number;
  laborHours: number;
  laborHoursBron: string;
  laborCost: number;
}

export interface CategoryLabourEntry {
  inputLabel: string;
  costGroup: CostGroup;
  hoursPerInput: number;
  inputQty: number;
  totalHours: number;
  cost: number;
}

export interface BuildingCalcResult {
  building: Building;
  rows: MaterialCalcRow[];
  subtotalMaterial: number;
  subtotalLabor: number;
  subtotalDirect: number;
  totalWithCount: number;
  /** Derived inputs from modules (e.g. Module oppervlak). */
  derivedInputs: Record<string, number>;
  /** Full set of effective input quantities keyed by label. */
  effectiveInputs: Record<string, number>;
  /** Labour entries per invoercategorie (los van materialen). */
  labourEntries: CategoryLabourEntry[];
  /** DeJong-leerfactor die is toegepast op assemblage-/installatie-arbeid.
   * 1,00 = geen effect. Lager = minder uren door leereffect. */
  learningFactor: number;
}

export interface MarkupCalcRow {
  id: string;
  name: string;
  type: MarkupType;
  value: number;
  basis: MarkupBasis;
  basisAmount: number;
  amount: number;
}

export interface GroupTotals {
  group: CostGroup;
  materialCost: number;
  laborCost: number;
  transportCost: number;
  /** materialCost + laborCost + transportCost */
  directCost: number;
  /** Markup rows for this group (computed amounts). */
  markups: MarkupCalcRow[];
  totalMarkups: number;
  /** directCost + totalMarkups */
  subtotal: number;
  /** Merged material rows belonging to this group (quantities already summed across buildings). */
  rows: MaterialCalcRow[];
}

export interface AutoTransportBreakdown {
  inboundM3: number;   // Naar VMG Polen — som van I-joist m³
  inboundTrucks: number;
  inboundCost: number;
  outboundM3: number;  // Polen → Raamsdonksveer — alle bouwpakket m³
  outboundTrucks: number;
  outboundCost: number;
}

export interface ProjectCalcResult {
  buildings: BuildingCalcResult[];

  groups: GroupTotals[];
  bouwpakket: GroupTotals;
  installateur: GroupTotals;
  assemblagehal: GroupTotals;
  arbeid: GroupTotals;
  derden: GroupTotals;
  hoofdaannemer: GroupTotals;

  /** Auto-berekende transport Polen (in + out), al opgeteld bij bouwpakket.transportCost. */
  autoTransport: AutoTransportBreakdown;
  /** Uren × tarief × modules voor arbeid buiten (al opgeteld bij arbeid.laborCost). */
  arbeidBuitenCost: number;
  projectmgmtCost: number;
  totalModules: number;

  totaalExDerden: number;  // bouwpakket + installateur + assemblagehal subtotals
  preProjectMarkups: number; // totaalExDerden + derden.subtotal + hoofdaannemer.subtotal
  projectMarkups: MarkupCalcRow[];
  totalProjectMarkups: number;

  totalDirect: number;
  totalMaterial: number;
  totalLabor: number;
  totalTransport: number;

  totalExVat: number;
  totalGFA: number;
  pricePerM2: number;
}

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  orgId: string;
  orgRole: OrgRole;
  orgName: string;
}

/** Special input labels that are auto-derived from modules when modules exist. */
export const MODULE_DERIVED_LABELS = {
  AREA: "Module oppervlak",   // Σ(L × W × count) m²
  COUNT: "Aantal modules",     // Σ(count) — interne totale telling; niet meer als standaard-categorie
  COUNT_BG: "Module Aantal BG",       // modules op begane grond
  COUNT_DAK: "Module Aantal Dak",     // modules met dakopbouw
  COUNT_TUSSEN: "Module Aantal Tussenvd", // modules op tussenverdiepingen
  WIDTH_TOTAL: "Module breedte totaal",   // Σ(W × count) m
  LENGTH_TOTAL: "Module lengte totaal",   // Σ(L × count) m
  HEIGHT_TOTAL: "Module hoogte totaal",   // Σ(H × count) m
} as const;
