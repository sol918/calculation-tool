import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ── Organizations ──
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  role: text("role", { enum: ["owner", "assembler", "developer"] }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

// ── Users ──
export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  orgId: text("org_id").notNull().references(() => organizations.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

// ── Materials Library ──
export const materials = sqliteTable("materials", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  category: text("category").notNull(),
  costGroup: text("cost_group", { enum: ["bouwpakket", "assemblagehal", "installateur", "derden", "hoofdaannemer"] }).notNull().default("assemblagehal"),
  pricePerUnit: real("price_per_unit").notNull().default(0),
  lossPct: real("loss_pct").notNull().default(0),
  laborHours: real("labor_hours").notNull().default(0),
  description: text("description"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  updatedBy: text("updated_by"),
});

// ── Labour Rates ──
// Eén singleton-rij per organisatie met alle configureerbare tarieven:
// bouwpakket-bewerking (€/m³), assemblage- en installatiearbeid (€/uur) en de
// module-gedreven arbeid-buiten + projectmanagement (uren/module + €/uur).
export const labourRates = sqliteTable("labour_rates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orgId: text("org_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  gezaagdPerM3: real("gezaagd_per_m3").notNull().default(100),
  cncSimpelPerM3: real("cnc_simpel_per_m3").notNull().default(200),
  cncComplexPerM3: real("cnc_complex_per_m3").notNull().default(400),
  steenachtigPerM3: real("steenachtig_per_m3").notNull().default(400),
  assemblageHourlyRate: real("assemblage_hourly_rate").notNull().default(48),
  installatieHourlyRate: real("installatie_hourly_rate").notNull().default(65),
  arbeidBuitenHourlyRate: real("arbeid_buiten_hourly_rate").notNull().default(66),
  arbeidBuitenHoursPerModule: real("arbeid_buiten_hours_per_module").notNull().default(0),
  arbeidBuitenHoursBase: real("arbeid_buiten_hours_base").notNull().default(0),
  projectmgmtHourlyRate: real("projectmgmt_hourly_rate").notNull().default(85),
  projectmgmtHoursPerModule: real("projectmgmt_hours_per_module").notNull().default(2),
  projectmgmtHoursBase: real("projectmgmt_hours_base").notNull().default(200),
});

// ── Kengetal Sets (= Bouwsystemen) ──
export const kengetalSets = sqliteTable("kengetal_sets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  orgId: text("org_id").notNull().references(() => organizations.id),
  themeColor: text("theme_color").notNull().default("#0ea5e9"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** Leercurve-parameters voor arbeidsuren-correctie (DeJong-model). */
  effVatHuidig: real("eff_vat_huidig").notNull().default(0.45),
  effVatMax: real("eff_vat_max").notNull().default(0.75),
  effLr: real("eff_lr").notNull().default(0.88),
  effNRef: real("eff_n_ref").notNull().default(10),
});

// ── Kengetal Labour ──
// Eén arbeids-getal per invoercategorie per bouwsysteem (kengetalSet).
// Komt los van materialen omdat dezelfde input vaak meerdere materialen aanstuurt
// maar de arbeid per input-eenheid (m², m¹, stuks…) één enkel kengetal is.
export const kengetalLabour = sqliteTable("kengetal_labour", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  setId: text("set_id").notNull().references(() => kengetalSets.id, { onDelete: "cascade" }),
  inputLabel: text("input_label").notNull(),
  costGroup: text("cost_group", { enum: ["arbeid", "bouwpakket", "assemblagehal", "installateur", "derden", "hoofdaannemer"] }).notNull().default("arbeid"),
  /** Assemblagearbeid — uren/eenheid. Valt altijd in de 'arbeid'-kostengroep. */
  hoursPerInput: real("hours_per_input").notNull().default(0),
  /** Installatiearbeid — uren/eenheid. Valt in de 'installateur'-kostengroep. */
  installatieHoursPerInput: real("installatie_hrs_per_input").notNull().default(0),
  // Bouwpakket-bewerking: m³ bewerkt bouwpakket per categorie-invoer-eenheid.
  // Som van gezaagd+cncSimpel+cncComplex hoort gelijk te zijn aan het totale
  // bouwpakket-m³/eenheid (gesommeerd uit de kengetal-rijen). Kramerijen is altijd
  // gelijk aan dat totaal → afgeleid in de calc, geen gebruikersveld meer.
  gezaagdM3PerInput: real("gezaagd_m3_per_input").notNull().default(0),
  cncSimpelM3PerInput: real("cnc_simpel_m3_per_input").notNull().default(0),
  cncComplexM3PerInput: real("cnc_complex_m3_per_input").notNull().default(0),
  steenachtigM3PerInput: real("steenachtig_m3_per_input").notNull().default(0),
  description: text("description"),
});

// ── Kengetal Rows ──
export const kengetalRows = sqliteTable("kengetal_rows", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  setId: text("set_id").notNull().references(() => kengetalSets.id, { onDelete: "cascade" }),
  inputLabel: text("input_label").notNull(),
  inputUnit: text("input_unit").notNull(),
  materialId: text("material_id").notNull().references(() => materials.id),
  ratio: real("ratio").notNull(),
  // Optional: arbeids-uren per input-eenheid (los van het materiaal). Belangrijkste plek
  // voor labour-input volgens Sustainer; materialen hebben optioneel hun eigen `laborHours`
  // als extra ("intrinsiek").
  laborHoursPerInput: real("labor_hours_per_input").notNull().default(0),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── Projects ──
// Phases follow SO → VO → DO → UO. Versions of the same project share a rootProjectId
// (the root project itself has rootProjectId = NULL).
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  client: text("client"), // Timberfy | Vink | Cordeel (free text; UI constrains)
  assemblyParty: text("assembly_party"), // Stamhuis (free text; UI constrains)
  ownerOrgId: text("owner_org_id").notNull().references(() => organizations.id),
  defaultKengetalSetId: text("default_kengetal_set_id").references(() => kengetalSets.id),
  rootProjectId: text("root_project_id"), // self-FK by convention; null for roots
  hourlyRate: real("hourly_rate").notNull().default(65),
  status: text("status", { enum: ["SO", "VO", "DO", "UO"] }).notNull().default("SO"),
  // Transport calculator inputs:
  destinationAddress: text("destination_address"),
  waypointAddress: text("waypoint_address"),
  returnToStart: integer("return_to_start", { mode: "boolean" }).notNull().default(false),
  loadTimeMinutes: integer("load_time_minutes").notNull().default(120),
  workdayHours: integer("workday_hours").notNull().default(8),
  extraTripsCount: integer("extra_trips_count").notNull().default(0),
  extraTripCost: real("extra_trip_cost").notNull().default(0),
  // Als true: aantal extra transporten = floor(totalTrucks × 0.05). Als false: gebruik extraTripsCount.
  extraTripsAuto: integer("extra_trips_auto", { mode: "boolean" }).notNull().default(true),
  notes: text("notes"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

// ── Caches for transport calculator ────────────────────────────────
export const geocodeCache = sqliteTable("geocode_cache", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  address: text("address").notNull().unique(),
  lat: real("lat").notNull(),
  lon: real("lon").notNull(),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export const routeCache = sqliteTable("route_cache", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  cacheKey: text("cache_key").notNull().unique(),
  distanceM: real("distance_m").notNull(),
  durationS: real("duration_s").notNull(),
  source: text("source").notNull().default("haversine"), // ors | haversine
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

// ── Buildings — each building belongs to exactly one kengetal set (bouwsysteem). ──
export const buildings = sqliteTable("buildings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  count: integer("count").notNull().default(1),
  kengetalSetId: text("kengetal_set_id").references(() => kengetalSets.id),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── Modules — per building, dimensional definition ──
export const modules = sqliteTable("modules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  buildingId: text("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Module"),
  lengthM: real("length_m").notNull().default(0),  // m
  widthM: real("width_m").notNull().default(0),    // m
  heightM: real("height_m").notNull().default(0),  // m
  count: integer("count").notNull().default(1),
  // Dakmodule = module met dakopbouw. Transport-hoogte = heightM + 0.50 m.
  isRoof: integer("is_roof", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── Building Inputs (non-derived inputs) ──
export const buildingInputs = sqliteTable("building_inputs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  buildingId: text("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
  inputLabel: text("input_label").notNull(),
  quantity: real("quantity").notNull().default(0),
  source: text("source", { enum: ["manual", "api_architect", "api_assembler", "api_sustainer", "csv"] }).notNull().default("manual"),
  sourceRef: text("source_ref"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── Overrides ──
export const overrides = sqliteTable("overrides", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  buildingId: text("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
  materialId: text("material_id").notNull().references(() => materials.id),
  quantity: real("quantity"),
  pricePerUnit: real("price_per_unit"),
  lossPct: real("loss_pct"),
  laborHours: real("labor_hours"),
  source: text("source", { enum: ["csv", "manual"] }).notNull().default("manual"),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

// ── Vehicle Types ──
export const vehicleTypes = sqliteTable("vehicle_types", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  costPerKm: real("cost_per_km").notNull().default(0),
  co2PerKm: real("co2_per_km"),
  maxVolumeM3: real("max_volume_m3"),
  maxWeightKg: real("max_weight_kg"),
});

// ── Project Transport ──
export const projectTransport = sqliteTable("project_transport", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  costGroup: text("cost_group", { enum: ["bouwpakket", "assemblagehal"] }).notNull().default("bouwpakket"),
  distanceKm: real("distance_km").notNull().default(0),
  vehicleTypeId: text("vehicle_type_id").notNull().references(() => vehicleTypes.id),
  tripCount: integer("trip_count").notNull().default(1),
  costPerTripOverride: real("cost_per_trip_override"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── Markup Rows (replaces tailRows + per-group margins) ──
// costGroup null → project-level markup (hoofdaannemer staart).
// costGroup set → markup applied inside that group's subtotal.
export const markupRows = sqliteTable("markup_rows", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  costGroup: text("cost_group", { enum: ["bouwpakket", "assemblagehal", "installateur", "derden", "hoofdaannemer"] }),
  name: text("name").notNull(),
  type: text("type", { enum: ["percentage", "fixed", "per_m2"] }).notNull().default("percentage"),
  value: real("value").notNull().default(0),
  // For percentage rows: which running sub-total to multiply against.
  basis: text("basis", { enum: [
    "group_direct",              // this group's materiaal+arbeid+transport
    "group_cumulative",          // this group's running subtotal (direct + preceding markups in same group)
    "totaal_ex_derden",          // bouwpakket + installateur + assemblagehal subtotals
    "inkoop_derden",             // derden subtotal
    "grand_total",               // running cumulative incl. derden
    "bouwpakket_plus_assemblage",// bouwpakket + assemblagehal subtotals (voor onvoorzien)
  ] }).notNull().default("group_direct"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── CSV-data uit externe stuklijst (per gebouw) ──
// Geaggregeerde totalen per (building, csv_code, unit). Eén CSV-upload per gebouw
// — uploads overschrijven alle rijen voor dat gebouw.
export const buildingCsvData = sqliteTable("building_csv_data", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  buildingId: text("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
  csvCode: text("csv_code").notNull(),
  unit: text("unit").notNull(),                     // "Unit", "M1", "M2", "M3"
  totalCount: real("total_count").notNull().default(0),
  totalVolumeM3: real("total_volume_m3").notNull().default(0),
  totalLengthM1: real("total_length_m1").notNull().default(0),
  totalAreaM2: real("total_area_m2").notNull().default(0),
  uploadedAt: text("uploaded_at").$defaultFn(() => new Date().toISOString()),
  fileName: text("file_name"),
});

// ── Per-materiaal toggle: gebruik CSV-data of kengetallen. ──
// csvCode+unit koppelt aan een rij in buildingCsvData; useCsv bepaalt de waarde
// die in de begroting landt. Gebruikt de material.lossPct voor bruto.
export const csvMaterialOverrides = sqliteTable("csv_material_overrides", {
  buildingId: text("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
  materialId: text("material_id").notNull().references(() => materials.id, { onDelete: "cascade" }),
  csvCode: text("csv_code").notNull(),
  csvUnit: text("csv_unit").notNull(),
  useCsv: integer("use_csv", { mode: "boolean" }).notNull().default(false),
}, (t) => ({ pk: primaryKey({ columns: [t.buildingId, t.materialId] }) }));

// ── Relations ──
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users), kengetalSets: many(kengetalSets),
}));
export const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, { fields: [users.orgId], references: [organizations.id] }),
}));
export const kengetalSetsRelations = relations(kengetalSets, ({ one, many }) => ({
  organization: one(organizations, { fields: [kengetalSets.orgId], references: [organizations.id] }),
  rows: many(kengetalRows),
}));
export const kengetalRowsRelations = relations(kengetalRows, ({ one }) => ({
  set: one(kengetalSets, { fields: [kengetalRows.setId], references: [kengetalSets.id] }),
  material: one(materials, { fields: [kengetalRows.materialId], references: [materials.id] }),
}));
export const projectsRelations = relations(projects, ({ one, many }) => ({
  ownerOrg: one(organizations, { fields: [projects.ownerOrgId], references: [organizations.id] }),
  defaultKengetalSet: one(kengetalSets, { fields: [projects.defaultKengetalSetId], references: [kengetalSets.id] }),
  buildings: many(buildings),
  transport: many(projectTransport),
  markupRows: many(markupRows),
}));
export const buildingsRelations = relations(buildings, ({ one, many }) => ({
  project: one(projects, { fields: [buildings.projectId], references: [projects.id] }),
  kengetalSet: one(kengetalSets, { fields: [buildings.kengetalSetId], references: [kengetalSets.id] }),
  modules: many(modules),
  inputs: many(buildingInputs),
  overrides: many(overrides),
}));
export const modulesRelations = relations(modules, ({ one }) => ({
  building: one(buildings, { fields: [modules.buildingId], references: [buildings.id] }),
}));
export const buildingInputsRelations = relations(buildingInputs, ({ one }) => ({
  building: one(buildings, { fields: [buildingInputs.buildingId], references: [buildings.id] }),
}));
export const overridesRelations = relations(overrides, ({ one }) => ({
  building: one(buildings, { fields: [overrides.buildingId], references: [buildings.id] }),
  material: one(materials, { fields: [overrides.materialId], references: [materials.id] }),
}));
export const projectTransportRelations = relations(projectTransport, ({ one }) => ({
  project: one(projects, { fields: [projectTransport.projectId], references: [projects.id] }),
  vehicleType: one(vehicleTypes, { fields: [projectTransport.vehicleTypeId], references: [vehicleTypes.id] }),
}));
export const markupRowsRelations = relations(markupRows, ({ one }) => ({
  project: one(projects, { fields: [markupRows.projectId], references: [projects.id] }),
}));
