import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { hash } from "bcryptjs";
import * as schema from "../src/lib/db/schema";
import * as fs from "fs";
import * as path from "path";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const client = createClient({ url: "file:./data/sustainer.db" });
const db = drizzle(client, { schema });

const RESET = process.env.RESET_DB === "1";

async function seed() {
  console.log(RESET ? "⚠️  Seeding with RESET_DB=1 (all data dropped)..." : "Seeding database (additive; existing data preserved)...");

  if (RESET) {
    await client.executeMultiple(`
      DROP TABLE IF EXISTS markup_rows;
      DROP TABLE IF EXISTS tail_rows;
      DROP TABLE IF EXISTS tail_templates;
      DROP TABLE IF EXISTS project_transport;
      DROP TABLE IF EXISTS vehicle_types;
      DROP TABLE IF EXISTS overrides;
      DROP TABLE IF EXISTS building_inputs;
      DROP TABLE IF EXISTS modules;
      DROP TABLE IF EXISTS buildings;
      DROP TABLE IF EXISTS route_cache;
      DROP TABLE IF EXISTS geocode_cache;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS kengetal_rows;
      DROP TABLE IF EXISTS kengetal_sets;
      DROP TABLE IF EXISTS materials;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS organizations;
    `);
  }

  // One-time migration: if kengetal_labour exists with the old CHECK (no 'arbeid'),
  // rebuild it. SQLite can't ALTER a CHECK constraint in place. Any existing labour
  // rows are migrated and their cost_group is flipped to 'arbeid'.
  try {
    const existing = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='kengetal_labour'",
    );
    const sql = existing.rows[0]?.sql as string | undefined;
    if (sql && !sql.includes("'arbeid'")) {
      console.log("  Migrating kengetal_labour to support 'arbeid' cost-group...");
      await client.executeMultiple(`
        CREATE TABLE kengetal_labour_new (
          id TEXT PRIMARY KEY,
          set_id TEXT NOT NULL REFERENCES kengetal_sets(id) ON DELETE CASCADE,
          input_label TEXT NOT NULL,
          cost_group TEXT NOT NULL DEFAULT 'arbeid' CHECK(cost_group IN ('arbeid','bouwpakket','assemblagehal','installateur','derden')),
          hours_per_input REAL NOT NULL DEFAULT 0,
          description TEXT
        );
        INSERT INTO kengetal_labour_new (id, set_id, input_label, cost_group, hours_per_input, description)
          SELECT id, set_id, input_label, 'arbeid', hours_per_input, description FROM kengetal_labour;
        DROP TABLE kengetal_labour;
        ALTER TABLE kengetal_labour_new RENAME TO kengetal_labour;
        CREATE UNIQUE INDEX IF NOT EXISTS kengetal_labour_set_label_uniq ON kengetal_labour(set_id, input_label);
      `);
    }
  } catch (e) { /* table doesn't exist yet — CREATE below handles it */ }

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','assembler','developer')),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      name TEXT, org_id TEXT NOT NULL REFERENCES organizations(id),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      unit TEXT NOT NULL, category TEXT NOT NULL,
      cost_group TEXT NOT NULL DEFAULT 'assemblagehal' CHECK(cost_group IN ('bouwpakket','assemblagehal','installateur','derden')),
      price_per_unit REAL NOT NULL DEFAULT 0, loss_pct REAL NOT NULL DEFAULT 0,
      labor_hours REAL NOT NULL DEFAULT 0, description TEXT,
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS labour_rates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      gezaagd_per_m3 REAL NOT NULL DEFAULT 100,
      cnc_simpel_per_m3 REAL NOT NULL DEFAULT 200,
      cnc_complex_per_m3 REAL NOT NULL DEFAULT 400,
      assemblage_hourly_rate REAL NOT NULL DEFAULT 48,
      installatie_hourly_rate REAL NOT NULL DEFAULT 65,
      arbeid_buiten_hourly_rate REAL NOT NULL DEFAULT 66,
      arbeid_buiten_hours_per_module REAL NOT NULL DEFAULT 0,
      arbeid_buiten_hours_base REAL NOT NULL DEFAULT 0,
      projectmgmt_hourly_rate REAL NOT NULL DEFAULT 85,
      projectmgmt_hours_per_module REAL NOT NULL DEFAULT 2,
      projectmgmt_hours_base REAL NOT NULL DEFAULT 200
    );
    CREATE TABLE IF NOT EXISTS kengetal_sets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      org_id TEXT NOT NULL REFERENCES organizations(id),
      theme_color TEXT NOT NULL DEFAULT '#0ea5e9',
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS kengetal_labour (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES kengetal_sets(id) ON DELETE CASCADE,
      input_label TEXT NOT NULL,
      cost_group TEXT NOT NULL DEFAULT 'arbeid' CHECK(cost_group IN ('arbeid','bouwpakket','assemblagehal','installateur','derden')),
      hours_per_input REAL NOT NULL DEFAULT 0,
      installatie_hrs_per_input REAL NOT NULL DEFAULT 0,
      gezaagd_m3_per_input REAL NOT NULL DEFAULT 0,
      cnc_simpel_m3_per_input REAL NOT NULL DEFAULT 0,
      cnc_complex_m3_per_input REAL NOT NULL DEFAULT 0,
      description TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS kengetal_labour_set_label_uniq ON kengetal_labour(set_id, input_label);
    CREATE TABLE IF NOT EXISTS kengetal_rows (
      id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES kengetal_sets(id) ON DELETE CASCADE,
      input_label TEXT NOT NULL, input_unit TEXT NOT NULL,
      material_id TEXT NOT NULL REFERENCES materials(id),
      ratio REAL NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, client TEXT, assembly_party TEXT,
      owner_org_id TEXT NOT NULL REFERENCES organizations(id),
      default_kengetal_set_id TEXT REFERENCES kengetal_sets(id),
      root_project_id TEXT,
      hourly_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'SO' CHECK(status IN ('SO','VO','DO','UO')),
      destination_address TEXT,
      waypoint_address TEXT,
      return_to_start INTEGER NOT NULL DEFAULT 1,
      load_time_minutes INTEGER NOT NULL DEFAULT 60,
      workday_hours INTEGER NOT NULL DEFAULT 8,
      notes TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS geocode_cache (
      id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE,
      lat REAL NOT NULL, lon REAL NOT NULL, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS route_cache (
      id TEXT PRIMARY KEY, cache_key TEXT NOT NULL UNIQUE,
      distance_m REAL NOT NULL, duration_s REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'haversine', created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS buildings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
      kengetal_set_id TEXT REFERENCES kengetal_sets(id),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY, building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Module',
      length_m REAL NOT NULL DEFAULT 0, width_m REAL NOT NULL DEFAULT 0, height_m REAL NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS building_inputs (
      id TEXT PRIMARY KEY, building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      input_label TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','api_architect','api_assembler','api_sustainer','csv')),
      source_ref TEXT, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS overrides (
      id TEXT PRIMARY KEY, building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES materials(id),
      quantity REAL, price_per_unit REAL, loss_pct REAL, labor_hours REAL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('csv','manual')),
      note TEXT, created_by TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS vehicle_types (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      cost_per_km REAL NOT NULL DEFAULT 0, co2_per_km REAL,
      max_volume_m3 REAL, max_weight_kg REAL
    );
    CREATE TABLE IF NOT EXISTS project_transport (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      cost_group TEXT NOT NULL DEFAULT 'bouwpakket' CHECK(cost_group IN ('bouwpakket','assemblagehal')),
      distance_km REAL NOT NULL DEFAULT 0,
      vehicle_type_id TEXT NOT NULL REFERENCES vehicle_types(id),
      trip_count INTEGER NOT NULL DEFAULT 1,
      cost_per_trip_override REAL, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS markup_rows (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cost_group TEXT CHECK(cost_group IN ('bouwpakket','assemblagehal','installateur','derden')),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'percentage' CHECK(type IN ('percentage','fixed','per_m2')),
      value REAL NOT NULL DEFAULT 0,
      basis TEXT NOT NULL DEFAULT 'group_direct' CHECK(basis IN ('group_direct','group_cumulative','totaal_ex_derden','inkoop_derden','grand_total')),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS building_csv_data (
      id TEXT PRIMARY KEY,
      building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      csv_code TEXT NOT NULL,
      unit TEXT NOT NULL,
      total_count REAL NOT NULL DEFAULT 0,
      total_volume_m3 REAL NOT NULL DEFAULT 0,
      total_length_m1 REAL NOT NULL DEFAULT 0,
      total_area_m2 REAL NOT NULL DEFAULT 0,
      uploaded_at TEXT,
      file_name TEXT
    );
    CREATE TABLE IF NOT EXISTS csv_material_overrides (
      building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      csv_code TEXT NOT NULL,
      csv_unit TEXT NOT NULL,
      use_csv INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (building_id, material_id)
    );
  `);

  // Additive migrations — safe to run repeatedly. ALTER TABLE ADD COLUMN errors on
  // duplicate columns; we catch and ignore so older DBs get upgraded without data loss.
  const addColumns: { table: string; col: string; def: string }[] = [
    { table: "projects", col: "assembly_party", def: "TEXT" },
    { table: "projects", col: "root_project_id", def: "TEXT" },
    { table: "projects", col: "destination_address", def: "TEXT" },
    { table: "projects", col: "waypoint_address", def: "TEXT" },
    { table: "projects", col: "return_to_start", def: "INTEGER NOT NULL DEFAULT 0" },
    { table: "projects", col: "load_time_minutes", def: "INTEGER NOT NULL DEFAULT 120" },
    { table: "projects", col: "workday_hours", def: "INTEGER NOT NULL DEFAULT 8" },
    { table: "projects", col: "extra_trips_count", def: "INTEGER NOT NULL DEFAULT 0" },
    { table: "projects", col: "extra_trip_cost", def: "REAL NOT NULL DEFAULT 0" },
    { table: "projects", col: "extra_trips_auto", def: "INTEGER NOT NULL DEFAULT 1" },
    { table: "modules", col: "is_roof", def: "INTEGER NOT NULL DEFAULT 0" },
    { table: "kengetal_rows", col: "labor_hours_per_input", def: "REAL NOT NULL DEFAULT 0" },
    { table: "buildings", col: "kengetal_set_id", def: "TEXT" },
    { table: "materials", col: "cost_group", def: "TEXT NOT NULL DEFAULT 'assemblagehal'" },
    { table: "kengetal_sets", col: "theme_color", def: "TEXT NOT NULL DEFAULT '#0ea5e9'" },
    { table: "project_transport", col: "cost_group", def: "TEXT NOT NULL DEFAULT 'bouwpakket'" },
    { table: "kengetal_labour", col: "gezaagd_m3_per_input", def: "REAL NOT NULL DEFAULT 0" },
    { table: "kengetal_labour", col: "cnc_simpel_m3_per_input", def: "REAL NOT NULL DEFAULT 0" },
    { table: "kengetal_labour", col: "cnc_complex_m3_per_input", def: "REAL NOT NULL DEFAULT 0" },
    { table: "kengetal_labour", col: "steenachtig_m3_per_input", def: "REAL NOT NULL DEFAULT 0" },
    { table: "kengetal_labour", col: "installatie_hrs_per_input", def: "REAL NOT NULL DEFAULT 0" },
    { table: "labour_rates",    col: "steenachtig_per_m3",        def: "REAL NOT NULL DEFAULT 250" },
    { table: "kengetal_sets", col: "eff_vat_huidig", def: "REAL NOT NULL DEFAULT 0.45" },
    { table: "kengetal_sets", col: "eff_vat_max", def: "REAL NOT NULL DEFAULT 0.75" },
    { table: "kengetal_sets", col: "eff_lr", def: "REAL NOT NULL DEFAULT 0.88" },
    { table: "kengetal_sets", col: "eff_n_ref", def: "REAL NOT NULL DEFAULT 10" },
    { table: "labour_rates", col: "arbeid_buiten_hours_base", def: "REAL NOT NULL DEFAULT 0" },
    { table: "labour_rates", col: "projectmgmt_hours_base",   def: "REAL NOT NULL DEFAULT 200" },
  ];
  // Rename verouderde _hrs_per_input bewerkings-kolommen → _m3_per_input (idempotent).
  // Voer VÓÓR ADD COLUMN uit: anders maken we nieuwe kolommen terwijl de oude blijven.
  const labourRenames: { from: string; to: string }[] = [
    { from: "gezaagd_hrs_per_input",      to: "gezaagd_m3_per_input" },
    { from: "cnc_simpel_hrs_per_input",   to: "cnc_simpel_m3_per_input" },
    { from: "cnc_complex_hrs_per_input",  to: "cnc_complex_m3_per_input" },
  ];
  for (const { from, to } of labourRenames) {
    try { await client.execute(`ALTER TABLE kengetal_labour RENAME COLUMN ${from} TO ${to}`); } catch {}
  }

  for (const { table, col, def } of addColumns) {
    try { await client.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* column exists — ignore */ }
  }

  // ── Label renames (idempotent) ──────────────────────────────────
  // Breng bestaande kengetal- en buildingInput-rijen op de nieuwe canonieke labels.
  const labelRenames: { from: string; to: string }[] = [
    { from: "Plat dak",              to: "Dakoppervlak" },
    { from: "Aantal woningen",       to: "Aantal appartementen" },
    { from: "Module breedte totaal", to: "Breedte totaal" },
    { from: "Module lengte totaal",  to: "Lengte totaal" },
    { from: "Module hoogte totaal",  to: "Hoogte totaal" },
    { from: "Badkamers",             to: "Badkamers midden" },
    // "Module oppervlak" → "Module Opp Plafond": materialen die bij elk modulevloer-opp
    // hoorden (totaal-footprint) passen het best onder Plafond (totaal = Σ plafonds).
    // Gebruiker kan per rij zelf verplaatsen naar Vloer BG / Vloer Overig / Dak.
    { from: "Module oppervlak",      to: "Module Opp Plafond" },
    // Consistentie: module-aantal splits volgen het "Module ..." pad van Opp.
    { from: "Aantal modules BG",        to: "Module Aantal BG" },
    { from: "Aantal modules dak",       to: "Module Aantal Dak" },
    { from: "Aantal modules tussenvd",  to: "Module Aantal Tussenvd" },
    // Module-afmetingen: verduidelijk dat het gaat om de modules (niet de gevel/…).
    { from: "Lengte totaal",            to: "Module lengte totaal" },
    { from: "Breedte totaal",           to: "Module breedte totaal" },
    { from: "Hoogte totaal",            to: "Module hoogte totaal" },
  ];
  for (const { from, to } of labelRenames) {
    try { await client.execute({ sql: "UPDATE kengetal_rows SET input_label = ? WHERE input_label = ?", args: [to, from] }); } catch {}
    try { await client.execute({ sql: "UPDATE building_inputs SET input_label = ? WHERE input_label = ?", args: [to, from] }); } catch {}
    try { await client.execute({ sql: "UPDATE kengetal_labour SET input_label = ? WHERE input_label = ?", args: [to, from] }); } catch {}
  }
  // Verwijder het oude "Opp begane grond" kengetal-label uit building_inputs
  // (de UI-waarde wordt nu alleen in de composite `_opp_begane_grond` bewaard).
  try { await client.execute("DELETE FROM building_inputs WHERE input_label = 'Opp begane grond'"); } catch {}

  // Voordeuren en binnendeuren: verplaats de bestaande kengetal-regels van
  // "Aantal modules × ratio" naar de juiste telling-input ("Aantal voordeuren"
  // resp. "Aantal binnendeuren") met ratio 1. Idempotent.
  try {
    await client.execute(`
      UPDATE kengetal_rows SET input_label = 'Aantal voordeuren', input_unit = 'stuks', ratio = 1.0
      WHERE input_label = 'Aantal modules'
        AND material_id IN (SELECT id FROM materials WHERE code = 'VRDR')
    `);
  } catch {}
  try {
    await client.execute(`
      UPDATE kengetal_rows SET input_label = 'Aantal binnendeuren', input_unit = 'stuks', ratio = 1.0
      WHERE input_label = 'Aantal modules'
        AND material_id IN (SELECT id FROM materials WHERE code = 'BIDR')
    `);
  } catch {}

  // Normaliseer eenheden naar superscript-vorm zodat dropdowns matchen.
  const unitFixes: { from: string; to: string }[] = [
    { from: "m3", to: "m³" }, { from: "m2", to: "m²" }, { from: "m1", to: "m¹" },
  ];
  for (const { from, to } of unitFixes) {
    try { await client.execute({ sql: "UPDATE materials SET unit = ? WHERE unit = ?", args: [to, from] }); } catch {}
    try { await client.execute({ sql: "UPDATE kengetal_rows SET input_unit = ? WHERE input_unit = ?", args: [to, from] }); } catch {}
  }

  // Idempotent I-joist catalog insert (additieve materialen voor Bouwpakket).
  const iJoists: { code: string; width: number; height: number; price: number }[] = [
    { code: "IJ45x160", width: 45, height: 160, price: 3.67 },
    { code: "IJ45x200", width: 45, height: 200, price: 3.82 },
    { code: "IJ45x220", width: 45, height: 220, price: 3.89 },
    { code: "IJ45x240", width: 45, height: 240, price: 3.96 },
    { code: "IJ45x250", width: 45, height: 250, price: 4.00 },
    { code: "IJ45x300", width: 45, height: 300, price: 4.18 },
    { code: "IJ45x360", width: 45, height: 360, price: 4.40 },
    { code: "IJ45x400", width: 45, height: 400, price: 4.55 },
    { code: "IJ60x160", width: 60, height: 160, price: 4.28 },
    { code: "IJ60x200", width: 60, height: 200, price: 4.43 },
    { code: "IJ60x220", width: 60, height: 220, price: 4.50 },
    { code: "IJ60x240", width: 60, height: 240, price: 4.57 },
    { code: "IJ60x250", width: 60, height: 250, price: 4.61 },
    { code: "IJ60x300", width: 60, height: 300, price: 4.79 },
    { code: "IJ60x360", width: 60, height: 360, price: 5.01 },
    { code: "IJ60x400", width: 60, height: 400, price: 5.16 },
    { code: "IJ90x220", width: 90, height: 220, price: 5.72 },
    { code: "IJ90x240", width: 90, height: 240, price: 5.79 },
    { code: "IJ90x250", width: 90, height: 250, price: 5.83 },
    { code: "IJ90x300", width: 90, height: 300, price: 6.01 },
    { code: "IJ90x360", width: 90, height: 360, price: 6.22 },
    { code: "IJ90x400", width: 90, height: 400, price: 6.38 },
  ];
  const existingCodes = new Set(
    (await db.select().from(schema.materials)).map((m) => m.code),
  );
  let inserted = 0;
  for (const ij of iJoists) {
    if (existingCodes.has(ij.code)) continue;
    await db.insert(schema.materials).values({
      code: ij.code,
      name: `I-Joist ${ij.width}x${ij.height}`,
      description: "Efficient lightweight wooden I-joists for large spans in floors and roofs",
      unit: "m1",
      category: "I-Joist",
      costGroup: "bouwpakket",
      pricePerUnit: ij.price,
      lossPct: 0.05,
      laborHours: 0,
    });
    inserted++;
  }
  if (inserted > 0) console.log(`  Added ${inserted} I-joist materials.`);

  // Zorg dat elk project de standaard opslagen heeft (idempotent per (project, costGroup, name)).
  const projectsRes = await client.execute("SELECT id FROM projects");
  const projectDefaults: { costGroup: string | null; name: string; type: string; value: number; basis: string; sort: number }[] = [
    { costGroup: "bouwpakket",    name: "Marge bouwpakket",       type: "percentage", value: 0,    basis: "group_cumulative", sort: 0 },
    { costGroup: "installateur",  name: "Marge installateur",     type: "percentage", value: 0,    basis: "group_cumulative", sort: 0 },
    { costGroup: "assemblagehal", name: "AK Assemblagehal",       type: "percentage", value: 12.5, basis: "totaal_ex_derden", sort: 1 },
    { costGroup: "assemblagehal", name: "W&R Assemblagehal",      type: "percentage", value: 3,    basis: "totaal_ex_derden", sort: 2 },
    // AK + W&R valt onder Inkoop derden; Coördinatie/ABK/CAR onder Bijkomend (hoofdaannemer).
    { costGroup: "derden",        name: "AK + W&R",               type: "percentage", value: 14,   basis: "inkoop_derden",    sort: 1 },
    { costGroup: "hoofdaannemer", name: "Coördinatie",            type: "percentage", value: 5,    basis: "totaal_ex_derden", sort: 1 },
    { costGroup: "hoofdaannemer", name: "ABK",                    type: "percentage", value: 7,    basis: "grand_total",      sort: 2 },
    { costGroup: "hoofdaannemer", name: "CAR",                    type: "percentage", value: 0.30, basis: "grand_total",      sort: 3 },
  ];
  for (const row of projectsRes.rows) {
    const pid = row.id as string;
    for (const d of projectDefaults) {
      const cgClause = d.costGroup == null ? "cost_group IS NULL" : "cost_group = ?";
      const args: any[] = [pid];
      if (d.costGroup != null) args.push(d.costGroup);
      args.push(d.name);
      const existing = await client.execute({
        sql: `SELECT id FROM markup_rows WHERE project_id = ? AND ${cgClause} AND name = ?`,
        args,
      });
      if (existing.rows.length > 0) continue;
      await client.execute({
        sql: "INSERT INTO markup_rows (id, project_id, cost_group, name, type, value, basis, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [crypto.randomUUID(), pid, d.costGroup, d.name, d.type, d.value, d.basis, d.sort],
      });
      console.log(`  Added "${d.name}" to project ${pid.slice(0, 8)}…`);
    }
  }

  // Zorg dat elke organisatie een default labour_rates-rij heeft (idempotent).
  const orgsRes = await client.execute("SELECT id FROM organizations");
  for (const row of orgsRes.rows) {
    const orgId = row.id as string;
    const ex = await client.execute({ sql: "SELECT id FROM labour_rates WHERE org_id = ?", args: [orgId] });
    if (ex.rows.length > 0) continue;
    await db.insert(schema.labourRates).values({ orgId });
    console.log(`  Added default labour_rates for org ${orgId.slice(0, 8)}…`);
  }
  // One-time bump: eerder waren projectmgmt-uren 0 (niet geconfigureerd). Zet ze op de
  // beoogde defaults (200u basis + 2u/module) als ze nog op de oude 0-waarde staan.
  await client.execute(`UPDATE labour_rates SET projectmgmt_hours_per_module = 2 WHERE projectmgmt_hours_per_module = 0`);
  await client.execute(`UPDATE labour_rates SET projectmgmt_hours_base = 200     WHERE projectmgmt_hours_base = 0`);

  // Projects: default laad-/lostijd is verhoogd van 60 → 120 min; upgrade oude rijen.
  await client.execute(`UPDATE projects SET load_time_minutes = 120 WHERE load_time_minutes = 60`);

  // One-time migration: herbouw CHECK-constraints op cost_group zodat de nieuwe
  // "hoofdaannemer"-waarde is toegestaan. SQLite kan geen CHECK in-place wijzigen.
  async function rebuildTable(table: string, createNewSql: string, copySelect: string) {
    const existing = await client.execute(
      { sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", args: [table] },
    );
    const sql = existing.rows[0]?.sql as string | undefined;
    if (!sql || sql.includes("'hoofdaannemer'")) return;
    console.log(`  Rebuilding ${table} (CHECK cost_group incl. hoofdaannemer)...`);
    // Disable FK enforcement tijdens de rebuild; alle FKs blijven op data-niveau consistent.
    await client.execute("PRAGMA foreign_keys = OFF");
    try {
      await client.executeMultiple(`
        ${createNewSql}
        INSERT INTO ${table}_new SELECT ${copySelect} FROM ${table};
        DROP TABLE ${table};
        ALTER TABLE ${table}_new RENAME TO ${table};
      `);
    } finally {
      await client.execute("PRAGMA foreign_keys = ON");
    }
  }

  await rebuildTable("materials", `
    CREATE TABLE materials_new (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      unit TEXT NOT NULL, category TEXT NOT NULL,
      cost_group TEXT NOT NULL DEFAULT 'assemblagehal' CHECK(cost_group IN ('bouwpakket','assemblagehal','installateur','derden','hoofdaannemer')),
      price_per_unit REAL NOT NULL DEFAULT 0, loss_pct REAL NOT NULL DEFAULT 0,
      labor_hours REAL NOT NULL DEFAULT 0, description TEXT,
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT
    );
  `, "id, code, name, unit, category, cost_group, price_per_unit, loss_pct, labor_hours, description, active, updated_at, updated_by");

  await rebuildTable("markup_rows", `
    CREATE TABLE markup_rows_new (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cost_group TEXT CHECK(cost_group IN ('bouwpakket','assemblagehal','installateur','derden','hoofdaannemer')),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'percentage' CHECK(type IN ('percentage','fixed','per_m2')),
      value REAL NOT NULL DEFAULT 0,
      basis TEXT NOT NULL DEFAULT 'group_direct' CHECK(basis IN ('group_direct','group_cumulative','totaal_ex_derden','inkoop_derden','grand_total','bouwpakket_plus_assemblage')),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `, "id, project_id, cost_group, name, type, value, basis, sort_order");

  // Extra rebuild: als de eerdere migratie al 'hoofdaannemer' toestond maar nog niet
  // 'bouwpakket_plus_assemblage', herbouwen we alleen de basis-CHECK.
  {
    const existing = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = 'markup_rows'",
    );
    const sql = existing.rows[0]?.sql as string | undefined;
    if (sql && !sql.includes("'bouwpakket_plus_assemblage'")) {
      console.log("  Rebuilding markup_rows (CHECK basis incl. bouwpakket_plus_assemblage)...");
      await client.execute("PRAGMA foreign_keys = OFF");
      try {
        await client.executeMultiple(`
          CREATE TABLE markup_rows_new (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            cost_group TEXT CHECK(cost_group IN ('bouwpakket','assemblagehal','installateur','derden','hoofdaannemer')),
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'percentage' CHECK(type IN ('percentage','fixed','per_m2')),
            value REAL NOT NULL DEFAULT 0,
            basis TEXT NOT NULL DEFAULT 'group_direct' CHECK(basis IN ('group_direct','group_cumulative','totaal_ex_derden','inkoop_derden','grand_total','bouwpakket_plus_assemblage')),
            sort_order INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO markup_rows_new SELECT id, project_id, cost_group, name, type, value, basis, sort_order FROM markup_rows;
          DROP TABLE markup_rows;
          ALTER TABLE markup_rows_new RENAME TO markup_rows;
        `);
      } finally {
        await client.execute("PRAGMA foreign_keys = ON");
      }
    }
  }

  await rebuildTable("kengetal_labour", `
    CREATE TABLE kengetal_labour_new (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES kengetal_sets(id) ON DELETE CASCADE,
      input_label TEXT NOT NULL,
      cost_group TEXT NOT NULL DEFAULT 'arbeid' CHECK(cost_group IN ('arbeid','bouwpakket','assemblagehal','installateur','derden','hoofdaannemer')),
      hours_per_input REAL NOT NULL DEFAULT 0,
      description TEXT,
      gezaagd_m3_per_input REAL NOT NULL DEFAULT 0,
      cnc_simpel_m3_per_input REAL NOT NULL DEFAULT 0,
      cnc_complex_m3_per_input REAL NOT NULL DEFAULT 0,
      kramerijen_m3_per_input REAL NOT NULL DEFAULT 0,
      installatie_hrs_per_input REAL NOT NULL DEFAULT 0
    );
  `, "id, set_id, input_label, cost_group, hours_per_input, description, gezaagd_m3_per_input, cnc_simpel_m3_per_input, cnc_complex_m3_per_input, kramerijen_m3_per_input, installatie_hrs_per_input");
  // kengetal_labour heeft ook de uniek-index nodig na rename.
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS kengetal_labour_set_label_uniq ON kengetal_labour(set_id, input_label)`,
  );

  // One-time migration: bestaande "staart"-markups die bij de hoofdaannemer horen
  // (costGroup=null) opnieuw categoriseren onder de nieuwe "hoofdaannemer"-groep.
  // Idempotent: matcht op exacte namen zoals geseed in api/projects/route.ts.
  const hoofdaannemerMarkupNames = [
    "AK + W&R hoofdaannemer",
    "ABK (keet, kraan, hek)",
    "Coördinatie",
    "CAR verzekering",
  ];
  for (const name of hoofdaannemerMarkupNames) {
    await client.execute({
      sql: `UPDATE markup_rows SET cost_group = 'hoofdaannemer'
            WHERE cost_group IS NULL AND name = ?`,
      args: [name],
    });
  }

  // Idempotent Kramerijen-material (schroeven/kramen/nagels, €50 per m³ bouwpakket).
  // Alleen toevoegen als er nog geen materiaal met code 'KRAM' bestaat.
  if (!existingCodes.has("KRAM")) {
    await db.insert(schema.materials).values({
      code: "KRAM",
      name: "Kramerijen",
      description: "Schroeven, kramen, nagels — bevestigingsmateriaal per m³ bouwpakket",
      unit: "m3",
      category: "Bevestiging",
      costGroup: "bouwpakket",
      pricePerUnit: 50,
      lossPct: 0,
      laborHours: 0,
    });
    console.log("  Added Kramerijen material (KRAM, €50/m³, bouwpakket).");
  }

  // Gevelafwerking drie-stapsopslag: budget / midden / duur. m², assemblagehal.
  const gevelAfwerkingen: { code: string; name: string; price: number; description: string }[] = [
    { code: "GEVBUD", name: "Gevelafwerking Budget",  price: 70,  description: "Basis gevelbekleding (stelpost budget)" },
    { code: "GEVMID", name: "Gevelafwerking Midden",  price: 100, description: "Middensegment gevelbekleding (stelpost midden)" },
    { code: "GEVDUR", name: "Gevelafwerking Duur",    price: 150, description: "Premium gevelbekleding (stelpost duur)" },
  ];
  for (const g of gevelAfwerkingen) {
    if (existingCodes.has(g.code)) continue;
    await db.insert(schema.materials).values({
      code: g.code,
      name: g.name,
      description: g.description,
      unit: "m2",
      category: "Afwerking",
      costGroup: "assemblagehal",
      pricePerUnit: g.price,
      lossPct: 0.10,
      laborHours: 0,
    });
    console.log(`  Added ${g.name} (${g.code}, €${g.price}/m², assemblagehal).`);
  }

  // Ontbrekende materialen uit de Excel UD_Final_STH-sheet (assemblagehal).
  // Prijzen en eenheden 1-op-1 uit de sheet overgenomen. Idempotent — skip als code al bestaat.
  const missingFromExcel: { code: string; name: string; unit: string; category: string; price: number; lossPct: number; description: string }[] = [
    { code: "LEKDRPL",  name: "Lekdorpels",             unit: "m1",    category: "Afwerking",  price: 40,   lossPct: 0.20, description: "Aluminium lekdorpel onder kozijnen (m¹ per kozijn)" },
    { code: "BIDRDRP",  name: "Binnendeurdorpel",       unit: "stuks", category: "Afwerking",  price: 17.7, lossPct: 0,    description: "Hardstenen dorpel onder binnendeur" },
    { code: "VDRDRANG", name: "Vrijloop dranger",       unit: "stuks", category: "Beslag",     price: 450,  lossPct: 0,    description: "Vrijloop-deurdranger per voordeur" },
    { code: "DAKTSLG",  name: "Verzwaard dak toeslag",  unit: "m2",    category: "Dak",        price: 40,   lossPct: 0,    description: "Toeslag op dakopbouw bij verzwaard dak (o.a. installaties, groendak)" },
    { code: "FUNDBEN",  name: "Funderingsbenodigdheden",unit: "stuks", category: "Fundering",  price: 75,   lossPct: 0,    description: "Chemisch anker + verbindingsmiddelen per fundering-node" },
    { code: "FUNDANK",  name: "Funderingsankers",       unit: "stuks", category: "Fundering",  price: 40,   lossPct: 0,    description: "Fundering-anker per stuk" },
    { code: "FUNDKPP",  name: "Funderingskoppelplateau",unit: "stuks", category: "Fundering",  price: 135,  lossPct: 0,    description: "Koppelplateau tussen modules en fundering" },
    { code: "BALKANK",  name: "Balkonankers",           unit: "stuks", category: "Bevestiging",price: 40,   lossPct: 0,    description: "Anker waar balkon aan gebouw hangt" },
    { code: "KERNKPP",  name: "Kernkoppelankers",       unit: "stuks", category: "Bevestiging",price: 20,   lossPct: 0,    description: "Koppeling tussen kern en casco" },
    { code: "SMELTANK", name: "Smeltankers",            unit: "stuks", category: "Bevestiging",price: 5,    lossPct: 0,    description: "Smeltanker voor brandscheiding tussen modules" },
    { code: "TREKANK",  name: "Trekankers",             unit: "stuks", category: "Bevestiging",price: 20,   lossPct: 0,    description: "Trekanker voor verticale verbinding modules" },
    { code: "TRAP",     name: "Trap",                   unit: "stuks", category: "Afwerking",  price: 700,  lossPct: 0,    description: "Binnentrap per verdieping (stelpost)" },
  ];
  for (const m of missingFromExcel) {
    if (existingCodes.has(m.code)) continue;
    await db.insert(schema.materials).values({
      code: m.code,
      name: m.name,
      description: m.description,
      unit: m.unit,
      category: m.category,
      costGroup: "assemblagehal",
      pricePerUnit: m.price,
      lossPct: m.lossPct,
      laborHours: 0,
    });
    console.log(`  Added ${m.name} (${m.code}, €${m.price}/${m.unit}, assemblagehal).`);
  }

  // Only insert demo data if the DB is truly fresh (no orgs yet).
  const existingOrgs = await db.select().from(schema.organizations);
  if (existingOrgs.length > 0) {
    console.log(`  DB already contains ${existingOrgs.length} organizations — skipping demo data insert.`);
    console.log("\nSchema up to date. Existing data preserved.");
    return;
  }

  const [sustainer] = await db.insert(schema.organizations).values({ name: "Sustainer", role: "owner" }).returning();
  const [stmh] = await db.insert(schema.organizations).values({ name: "STMH", role: "assembler" }).returning();
  const [timberfy] = await db.insert(schema.organizations).values({ name: "Timberfy", role: "developer" }).returning();

  const pw1 = await hash("sustainer2025", 10);
  const pw2 = await hash("stmh2025", 10);
  const pw3 = await hash("timberfy2025", 10);
  await db.insert(schema.users).values({ email: "admin@sustainer.nl", passwordHash: pw1, name: "Admin Sustainer", orgId: sustainer.id });
  await db.insert(schema.users).values({ email: "calc@stmh.nl", passwordHash: pw2, name: "Calculator STMH", orgId: stmh.id });
  await db.insert(schema.users).values({ email: "calc@timberfy.nl", passwordHash: pw3, name: "Calculator Timberfy", orgId: timberfy.id });

  type MatDef = {
    code: string; name: string; unit: string; category: string;
    costGroup: "bouwpakket"|"assemblagehal"|"installateur"|"derden";
    pricePerUnit: number; lossPct: number; laborHours: number; description?: string;
  };
  const materialData: MatDef[] = [
    // BOUWPAKKET
    { code: "LVLQ", name: "LVL Spruce Q-panel", unit: "m3", category: "LVL", costGroup: "bouwpakket", pricePerUnit: 760, lossPct: 0.16, laborHours: 0, description: "Kruisgelaagd LVL voor plafondplaten (Q = quer, hoofdrichting verticaal)" },
    { code: "LVLS", name: "LVL Spruce S-beam", unit: "m3", category: "LVL", costGroup: "bouwpakket", pricePerUnit: 700, lossPct: 0.16, laborHours: 0, description: "LVL voor balken en stijlen (S = streifen, vezelrichting langs)" },
    { code: "BAUB", name: "Baubrett Fichte", unit: "m3", category: "LVL", costGroup: "bouwpakket", pricePerUnit: 1400, lossPct: 0.10, laborHours: 0, description: "Massief vurenhouten blokken voor zware kolommen" },
    { code: "SPANO", name: "Spano OSB3", unit: "m3", category: "Plaat", costGroup: "bouwpakket", pricePerUnit: 380, lossPct: 0.25, laborHours: 0, description: "Houtspaanplaat 22mm — stabilisatielaag in de module" },
    { code: "FERM18", name: "Fermacell 18mm", unit: "m3", category: "Plaat", costGroup: "bouwpakket", pricePerUnit: 650, lossPct: 0.14, laborHours: 0, description: "Gipsvezelplaat 18mm — bescherming vloer/plafond" },
    { code: "FERM10", name: "Fermacell 10mm", unit: "m3", category: "Plaat", costGroup: "bouwpakket", pricePerUnit: 650, lossPct: 0.14, laborHours: 0, description: "Gipsvezelplaat 10mm — extra laag" },
    { code: "GIPSF", name: "Gips F brandwerend", unit: "m3", category: "Plaat", costGroup: "bouwpakket", pricePerUnit: 250, lossPct: 0.06, laborHours: 0, description: "Brandwerende gipsplaat (type F)" },
    { code: "CEMVIN", name: "Cemvin cementvezel", unit: "m3", category: "Plaat", costGroup: "bouwpakket", pricePerUnit: 1990, lossPct: 0.06, laborHours: 0, description: "Cementvezelplaat — gevels en vochtige ruimtes" },
    { code: "PROMAT", name: "Promat XS brandwering", unit: "m3", category: "Brandwering", costGroup: "bouwpakket", pricePerUnit: 1250, lossPct: 0.06, laborHours: 0, description: "Promat in hoekdetails van modules" },
    // ASSEMBLAGEHAL
    { code: "GIPSPL", name: "Gipsplaat regulier", unit: "m3", category: "Plaat", costGroup: "assemblagehal", pricePerUnit: 220, lossPct: 0.06, laborHours: 0, description: "Reguliere gipsplaat — afbouw in de hal" },
    { code: "BALLAST", name: "Ballast vloer", unit: "m3", category: "Overig", costGroup: "assemblagehal", pricePerUnit: 77, lossPct: 0.05, laborHours: 0, description: "Akoestische ballast in vloer (bij WSW)" },
    { code: "KRAM", name: "Kramerijen/schroeven", unit: "m3", category: "Bevestiging", costGroup: "assemblagehal", pricePerUnit: 65, lossPct: 0.00, laborHours: 0, description: "Schroeven, nagels, klein bevestigingsmateriaal" },
    { code: "CELL", name: "Cellulose isolatie", unit: "m3", category: "Isolatie", costGroup: "assemblagehal", pricePerUnit: 60, lossPct: 0.10, laborHours: 0, description: "Ingeblazen cellulose-isolatie" },
    { code: "GLASW", name: "Glaswol", unit: "m3", category: "Isolatie", costGroup: "assemblagehal", pricePerUnit: 55, lossPct: 0.20, laborHours: 0, description: "Glaswol — optioneel alternatief voor cellulose" },
    { code: "STEENW", name: "Steenwol", unit: "m3", category: "Isolatie", costGroup: "assemblagehal", pricePerUnit: 95, lossPct: 0.20, laborHours: 0, description: "Steenwol — brand- en geluidsisolatie" },
    { code: "FACF", name: "Facade folie", unit: "m2", category: "Folies", costGroup: "assemblagehal", pricePerUnit: 4.07, lossPct: 0.20, laborHours: 0, description: "Damp-open folie achter gevelafwerking" },
    { code: "PEF", name: "PE folie", unit: "m2", category: "Folies", costGroup: "assemblagehal", pricePerUnit: 0.38, lossPct: 0.20, laborHours: 0, description: "Dampremmende PE folie onder plafondopbouw" },
    { code: "WDLP", name: "Waterdichte laag plafond", unit: "m2", category: "Folies", costGroup: "assemblagehal", pricePerUnit: 5.20, lossPct: 0.20, laborHours: 0, description: "Waterdichte laag onder dakopbouw" },
    { code: "AIRT", name: "Luchtdichting", unit: "m1", category: "Folies", costGroup: "assemblagehal", pricePerUnit: 1.10, lossPct: 0.15, laborHours: 0, description: "Luchtdichtingstape en compribanden" },
    { code: "ACHT", name: "Achterhout", unit: "m1", category: "Afwerking", costGroup: "assemblagehal", pricePerUnit: 1.30, lossPct: 0.20, laborHours: 0, description: "Zwart geïmpregneerd achterhout achter open gevelbekleding" },
    { code: "GEVA", name: "Gevelafwerking", unit: "m2", category: "Afwerking", costGroup: "assemblagehal", pricePerUnit: 100, lossPct: 0.10, laborHours: 0, description: "Gevelbekleding (stelpost — afhankelijk van keuze)" },
    { code: "PIR", name: "PIR 160mm dakisolatie", unit: "m2", category: "Isolatie", costGroup: "assemblagehal", pricePerUnit: 23.14, lossPct: 0.10, laborHours: 0, description: "PIR platen 160mm incl. flensen voor platte daken" },
    { code: "BIT", name: "Bitumen dakbedekking", unit: "m2", category: "Dak", costGroup: "assemblagehal", pricePerUnit: 45, lossPct: 0.20, laborHours: 0, description: "Bitumen waterdichting voor plat dak" },
    { code: "DRPR", name: "Dakrandprofiel alu", unit: "m1", category: "Dak", costGroup: "assemblagehal", pricePerUnit: 50, lossPct: 0.00, laborHours: 0, description: "Aluminium dakrandprofiel (stelpost)" },
    { code: "VRDR", name: "Voordeur cpl", unit: "stuks", category: "Deuren", costGroup: "assemblagehal", pricePerUnit: 1200, lossPct: 0.00, laborHours: 0, description: "Voordeur incl. beslag, basiskleur" },
    { code: "BIDR", name: "Binnendeur", unit: "stuks", category: "Deuren", costGroup: "assemblagehal", pricePerUnit: 180, lossPct: 0.00, laborHours: 0, description: "Opdek binnendeur incl. kozijn en beslag" },
    { code: "HIJS", name: "Hijsankers", unit: "stuks", category: "Bevestiging", costGroup: "assemblagehal", pricePerUnit: 18, lossPct: 0.00, laborHours: 0, description: "Hijsankers per modulehoek" },
    { code: "TEGEL", name: "Tegelwerk badkamer", unit: "m2", category: "Afwerking", costGroup: "assemblagehal", pricePerUnit: 45, lossPct: 0.00, laborHours: 0, description: "Badkamertegels wand+vloer (stelpost)" },
    { code: "KOZ", name: "Kozijn incl glas", unit: "m2", category: "Glas", costGroup: "assemblagehal", pricePerUnit: 355, lossPct: 0.00, laborHours: 0, description: "Houten kozijn incl. HR++ glas (prijs inkoop)" },
    // INSTALLATEUR (per woning)
    { code: "VENT", name: "Ventilatie per woning", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 3332, lossPct: 0, laborHours: 0, description: "WTW-systeem per woning — conform offerte" },
    { code: "WATL", name: "Waterleiding per woning", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 844, lossPct: 0, laborHours: 0, description: "Waterleidingwerk per woning" },
    { code: "RIOL", name: "Riolering per woning", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 536, lossPct: 0, laborHours: 0, description: "Riolering per woning" },
    { code: "WKO", name: "Warmte-koude opwek", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 7144, lossPct: 0, laborHours: 0, description: "WKO (warmtepomp) per woning" },
    { code: "AFG", name: "Afgifte systeem", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 2646, lossPct: 0, laborHours: 0, description: "Vloerverwarming/radiatoren per woning" },
    { code: "BRNN", name: "Bronnen WKO", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 2354, lossPct: 0, laborHours: 0, description: "Bronboringen voor WKO per woning" },
    { code: "ELEC", name: "Elektra per woning", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 4054, lossPct: 0, laborHours: 0, description: "Elektra-installatie per woning" },
    { code: "SANT", name: "Sanitair per woning", unit: "stuks", category: "Installatie", costGroup: "installateur", pricePerUnit: 1184, lossPct: 0, laborHours: 0, description: "Sanitair (WC, douche, kranen, wastafel)" },
    // DERDEN
    { code: "BALK", name: "Balkon", unit: "stuks", category: "Derden", costGroup: "derden", pricePerUnit: 5000, lossPct: 0, laborHours: 0, description: "Balkon exclusief ophanging" },
    { code: "FUND", name: "Fundering", unit: "m2", category: "Derden", costGroup: "derden", pricePerUnit: 100, lossPct: 0, laborHours: 0, description: "Fundering per m² GFA (stelpost)" },
  ];

  const materialIds: Record<string, string> = {};
  for (const m of materialData) {
    const [created] = await db.insert(schema.materials).values(m).returning();
    materialIds[m.code] = created.id;
  }
  console.log(`  ${materialData.length} materials created`);

  const [vt1d] = await db.insert(schema.vehicleTypes).values({ name: "1d-transport (Polen)", costPerKm: 1.29 }).returning();
  const [vt3dS] = await db.insert(schema.vehicleTypes).values({ name: "3d-transport cat. 1 (kort)", costPerKm: 3.10 }).returning();
  await db.insert(schema.vehicleTypes).values({ name: "3d-transport cat. 3 (lang)", costPerKm: 4.00 });

  // Kengetal Sets
  const [ksSTH] = await db.insert(schema.kengetalSets).values({
    name: ".home", description: "Sustainer .home — standaard modulaire houtbouw", orgId: stmh.id, themeColor: "#15803d",
  }).returning();
  const [ksOP] = await db.insert(schema.kengetalSets).values({
    name: ".optop", description: "Sustainer .optop — lichte verdieping op bestaand gebouw", orgId: stmh.id, themeColor: "#b45309",
  }).returning();
  await db.insert(schema.kengetalSets).values({
    name: ".belgium", description: "Sustainer .belgium — Cordeel CLT bouwsysteem (BE)", orgId: stmh.id, themeColor: "#6d28d9",
  });

  // Kengetal rows for v6 STH
  const kgSTH = [
    // Derived inputs (from modules)
    { label: "Module Opp Plafond", unit: "m2", code: "LVLQ", ratio: 0.0503 },
    { label: "Module Opp Plafond", unit: "m2", code: "LVLS", ratio: 0.047 },
    { label: "Module Opp Plafond", unit: "m2", code: "SPANO", ratio: 0.0348 },
    { label: "Module Opp Plafond", unit: "m2", code: "FERM18", ratio: 0.018 },
    { label: "Module Opp Plafond", unit: "m2", code: "FERM10", ratio: 0.010 },
    { label: "Module Opp Plafond", unit: "m2", code: "CELL", ratio: 0.1416 },
    { label: "Module Opp Plafond", unit: "m2", code: "STEENW", ratio: 0.080 },
    { label: "Module Opp Plafond", unit: "m2", code: "PEF", ratio: 1.0 },
    { label: "Module Opp Plafond", unit: "m2", code: "BALLAST", ratio: 0.047 },
    { label: "Module Opp Plafond", unit: "m2", code: "WDLP", ratio: 1.2 },
    { label: "Module Opp Plafond", unit: "m2", code: "AIRT", ratio: 3.33 },
    { label: "Aantal modules", unit: "stuks", code: "HIJS", ratio: 8.0 },
    { label: "Aantal voordeuren", unit: "stuks", code: "VRDR", ratio: 1.0 },
    { label: "Aantal binnendeuren", unit: "stuks", code: "BIDR", ratio: 1.0 },
    { label: "Aantal modules", unit: "stuks", code: "KRAM", ratio: 0.20 },
    // Manual inputs
    { label: "Dichte gevel", unit: "m2", code: "LVLS", ratio: 0.031 },
    { label: "Dichte gevel", unit: "m2", code: "GIPSPL", ratio: 0.025 },
    { label: "Dichte gevel", unit: "m2", code: "STEENW", ratio: 0.120 },
    { label: "Dichte gevel", unit: "m2", code: "FACF", ratio: 1.05 },
    { label: "Dichte gevel", unit: "m2", code: "GEVA", ratio: 1.0 },
    { label: "Dichte gevel", unit: "m2", code: "ACHT", ratio: 4.5 },
    { label: "Open gevel", unit: "m2", code: "KOZ", ratio: 1.0 },
    { label: "Binnenwand", unit: "m1", code: "LVLQ", ratio: 0.0215 },
    { label: "Binnenwand", unit: "m1", code: "GIPSPL", ratio: 0.025 },
    { label: "Binnenwand", unit: "m1", code: "STEENW", ratio: 0.020 },
    { label: "Dakoppervlak", unit: "m2", code: "PIR", ratio: 1.0 },
    { label: "Dakoppervlak", unit: "m2", code: "BIT", ratio: 1.15 },
    { label: "Dakomtrek", unit: "m1", code: "DRPR", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "VENT", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "WATL", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "RIOL", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "WKO", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "AFG", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "BRNN", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "ELEC", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "SANT", ratio: 1.0 },
    { label: "Badkamers", unit: "stuks", code: "TEGEL", ratio: 25.0 },
  ];
  for (let i = 0; i < kgSTH.length; i++) {
    const k = kgSTH[i];
    await db.insert(schema.kengetalRows).values({
      setId: ksSTH.id, inputLabel: k.label, inputUnit: k.unit,
      materialId: materialIds[k.code], ratio: k.ratio, sortOrder: i,
    });
  }

  // Smaller set for Optopper (lighter)
  const kgOP = [
    { label: "Module Opp Plafond", unit: "m2", code: "LVLQ", ratio: 0.040 },
    { label: "Module Opp Plafond", unit: "m2", code: "LVLS", ratio: 0.038 },
    { label: "Module Opp Plafond", unit: "m2", code: "SPANO", ratio: 0.025 },
    { label: "Module Opp Plafond", unit: "m2", code: "CELL", ratio: 0.120 },
    { label: "Aantal modules", unit: "stuks", code: "HIJS", ratio: 8.0 },
    { label: "Dichte gevel", unit: "m2", code: "LVLS", ratio: 0.022 },
    { label: "Dichte gevel", unit: "m2", code: "CELL", ratio: 0.200 },
    { label: "Dichte gevel", unit: "m2", code: "GEVA", ratio: 1.0 },
    { label: "Open gevel", unit: "m2", code: "KOZ", ratio: 1.0 },
    { label: "Dakoppervlak", unit: "m2", code: "PIR", ratio: 1.0 },
    { label: "Dakoppervlak", unit: "m2", code: "BIT", ratio: 1.15 },
    { label: "Aantal appartementen", unit: "stuks", code: "VENT", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "ELEC", ratio: 1.0 },
    { label: "Aantal appartementen", unit: "stuks", code: "SANT", ratio: 0.7 },
    { label: "Aantal appartementen", unit: "stuks", code: "AFG", ratio: 1.0 },
  ];
  for (let i = 0; i < kgOP.length; i++) {
    const k = kgOP[i];
    await db.insert(schema.kengetalRows).values({
      setId: ksOP.id, inputLabel: k.label, inputUnit: k.unit,
      materialId: materialIds[k.code], ratio: k.ratio, sortOrder: i,
    });
  }
  console.log(`  Kengetal rows: ${kgSTH.length} (v6 STH) + ${kgOP.length} (Optopper)`);

  // Demo project
  const [project] = await db.insert(schema.projects).values({
    name: "Strandeiland P9/P10",
    client: "Timberfy",
    assemblyParty: "Stamhuis",
    ownerOrgId: sustainer.id,
    defaultKengetalSetId: ksSTH.id,
    status: "SO",
    destinationAddress: "Amsterdam, Nederland",
    returnToStart: false,
    loadTimeMinutes: 120,
    workdayHours: 8,
    notes: "Demo project met voorbeelddata uit referentie-Excel.\n\nDit is een meerregelige notitie zodat je kunt zien hoe de textarea werkt.",
  }).returning();

  // Buildings — one per system to demo multi-system project
  const [blokA] = await db.insert(schema.buildings).values({
    projectId: project.id, name: "Blok A", count: 12, kengetalSetId: ksSTH.id, sortOrder: 0,
  }).returning();
  const [blokB] = await db.insert(schema.buildings).values({
    projectId: project.id, name: "Blok B", count: 8, kengetalSetId: ksSTH.id, sortOrder: 1,
  }).returning();
  const [optopper] = await db.insert(schema.buildings).values({
    projectId: project.id, name: "Optopper Noord", count: 1, kengetalSetId: ksOP.id, sortOrder: 2,
  }).returning();

  // Modules per building
  await db.insert(schema.modules).values({
    buildingId: blokA.id, name: "Type 1", lengthM: 3.358, widthM: 2.595, heightM: 3.155, count: 54, sortOrder: 0,
  });
  await db.insert(schema.modules).values({
    buildingId: blokB.id, name: "Type 1", lengthM: 3.358, widthM: 2.595, heightM: 3.155, count: 42, sortOrder: 0,
  });
  await db.insert(schema.modules).values({
    buildingId: optopper.id, name: "Type OP", lengthM: 5.0, widthM: 3.2, heightM: 2.8, count: 8, sortOrder: 0,
  });

  // Building inputs — manual ones only (module-derived are auto)
  async function addInputs(bId: string, entries: { label: string; qty: number }[]) {
    for (let i = 0; i < entries.length; i++) {
      await db.insert(schema.buildingInputs).values({
        buildingId: bId, inputLabel: entries[i].label, quantity: entries[i].qty, source: "manual", sortOrder: i,
      });
    }
  }
  await addInputs(blokA.id, [
    { label: "Dichte gevel", qty: 280 },
    { label: "Open gevel", qty: 185 },
    { label: "Binnenwand", qty: 2036 },
    { label: "Dakoppervlak", qty: 614 },
    { label: "Dakomtrek", qty: 98 },
    { label: "Aantal appartementen", qty: 18 },
    { label: "Badkamers", qty: 18 },
  ]);
  await addInputs(blokB.id, [
    { label: "Dichte gevel", qty: 220 },
    { label: "Open gevel", qty: 150 },
    { label: "Binnenwand", qty: 1620 },
    { label: "Dakoppervlak", qty: 480 },
    { label: "Dakomtrek", qty: 86 },
    { label: "Aantal appartementen", qty: 14 },
    { label: "Badkamers", qty: 14 },
  ]);
  await addInputs(optopper.id, [
    { label: "Dichte gevel", qty: 90 },
    { label: "Open gevel", qty: 40 },
    { label: "Dakoppervlak", qty: 128 },
    { label: "Aantal appartementen", qty: 8 },
  ]);

  // Transport
  await db.insert(schema.projectTransport).values({
    projectId: project.id, description: "1d-transport Polen → NL", costGroup: "bouwpakket",
    distanceKm: 1240, vehicleTypeId: vt1d.id, tripCount: 15, costPerTripOverride: 1600, sortOrder: 0,
  });
  await db.insert(schema.projectTransport).values({
    projectId: project.id, description: "3d-transport hal → bouwplaats", costGroup: "assemblagehal",
    distanceKm: 80, vehicleTypeId: vt3dS.id, tripCount: 20, sortOrder: 1,
  });

  // Markup rows — modeled after Excel UD_Final staart
  const markups: { costGroup: any; name: string; type: any; value: number; basis: any; sort: number }[] = [
    // Bouwpakket
    { costGroup: "bouwpakket", name: "Winst/risico inkoop", type: "percentage", value: 10, basis: "group_direct", sort: 0 },
    // Assemblagehal staart
    { costGroup: "assemblagehal", name: "Detailberekening", type: "per_m2", value: 22, basis: "group_direct", sort: 1 },
    { costGroup: "assemblagehal", name: "Nader uit te werken", type: "percentage", value: 5, basis: "group_cumulative", sort: 2 },
    { costGroup: "assemblagehal", name: "AK Assemblagehal", type: "percentage", value: 12.5, basis: "totaal_ex_derden", sort: 3 },
    { costGroup: "assemblagehal", name: "W&R Assemblagehal", type: "percentage", value: 3.0, basis: "totaal_ex_derden", sort: 4 },
    // Project-level (null costGroup) — Hoofdaannemer staart
    { costGroup: null, name: "AK + W&R hoofdaannemer", type: "percentage", value: 14, basis: "inkoop_derden", sort: 0 },
    { costGroup: null, name: "ABK (keet, kraan, hek)", type: "percentage", value: 7, basis: "grand_total", sort: 1 },
    { costGroup: null, name: "Coördinatie", type: "percentage", value: 5, basis: "totaal_ex_derden", sort: 2 },
    { costGroup: null, name: "CAR verzekering", type: "percentage", value: 0.3, basis: "grand_total", sort: 3 },
  ];
  for (const m of markups) {
    await db.insert(schema.markupRows).values({
      projectId: project.id, costGroup: m.costGroup, name: m.name,
      type: m.type, value: m.value, basis: m.basis, sortOrder: m.sort,
    });
  }

  console.log("  Demo project created (3 buildings, 2 bouwsystemen)");
  console.log("\nSeed complete!");
  console.log("\nLogin credentials:");
  console.log("  admin@sustainer.nl / sustainer2025 (owner)");
  console.log("  calc@stmh.nl / stmh2025 (assembler)");
  console.log("  calc@timberfy.nl / timberfy2025 (developer)");
}

seed().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
