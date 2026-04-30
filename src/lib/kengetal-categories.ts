/**
 * Canonieke invoercategorieën voor alle bouwsystemen. Deze lijst bepaalt welke
 * labels de gebruiker standaard in de kengetallen-library ziet, zelfs als er
 * nog geen materialen aan gekoppeld zijn. De labels moeten exact matchen met
 * wat structured-inputs.tsx als inputLabel wegschrijft naar buildingInputs.
 */
/** Hoofd-groep voor de kengetallen-pagina links-paneel. */
export type CategoryGroup = "modules" | "gevels" | "wanden" | "installaties" | "overig";

/** Sub-groep binnen een hoofdgroep — drijft kleur-codering in de UI zodat je in
 *  één oogopslag ziet welke labels bij elkaar horen (b.v. alle "Module Opp X"
 *  varianten krijgen dezelfde tint). */
export type CategorySubgroup =
  | "module-opp"      // BG / Overig / Plafond / Dak (m²) — opbouw oppervlakten
  | "module-aant"     // Aant BG / Dak / Tussenvd (stuks)
  | "module-dim"      // lengte / breedte / hoogte totaal (m¹)
  | "dak"             // Dakoppervlak + Dakomtrek (rond modules)
  | "gevelkolom"      // Aantal gevelkolommen
  | "gevel-opp"       // Open / Dichte gevel (m²)
  | "gevel-stuks"     // Kozijnen / voordeuren
  | "binnenwand"      // Binnenwand / massief / binnendeuren
  | "wsw-home"        // WSW / Verzwaard / Extra verzwaard (.home)
  | "wsw-optop"       // korte / lange zijde (.optop)
  | "extra-kolom"     // Extra kolom (.home)
  | "appartement"     // Aantal appartementen
  | "badkamer"        // Badkamers + Los toilet
  | "balkon";         // Balkons stuks/opp

export interface StandardCategory {
  label: string;
  unit: string;
  group: CategoryGroup;
  subgroup: CategorySubgroup;
  /** Optional hint shown under the category row. */
  description?: string;
}

export const STANDARD_CATEGORIES: StandardCategory[] = [
  // ── MODULES ────────────────────────────────────────────────────
  { label: "Module Opp Vloer BG",           unit: "m²",   group: "modules", subgroup: "module-opp",     description: "Footprint begane grond (1 laag vloer)" },
  { label: "Module Opp Vloer Overig",       unit: "m²",   group: "modules", subgroup: "module-opp",     description: "Vloeren boven BG (totaal − BG)" },
  { label: "Module Opp Plafond",            unit: "m²",   group: "modules", subgroup: "module-opp",     description: "Totaal plafondoppervlak (één per verdieping)" },
  { label: "Module Opp Dak",                unit: "m²",   group: "modules", subgroup: "module-opp",     description: "Oppervlak bovenkant gebouw (= footprint)" },
  { label: "Module Aant BG",                unit: "stuks",group: "modules", subgroup: "module-aant",    description: "Modules op begane grond (afgeleid uit BGG)" },
  { label: "Module Aant Dak",               unit: "stuks",group: "modules", subgroup: "module-aant",    description: "Modules met dakopbouw (afgeleid uit BGG)" },
  { label: "Module Aant Tussenvd",          unit: "stuks",group: "modules", subgroup: "module-aant",    description: "Modules op tussenverdiepingen" },
  { label: "Module lengte totaal",          unit: "m¹",   group: "modules", subgroup: "module-dim",     description: "Σ L × count uit modules" },
  { label: "Module breedte totaal",         unit: "m¹",   group: "modules", subgroup: "module-dim",     description: "Σ B × count uit modules" },
  { label: "Module hoogte totaal",          unit: "m¹",   group: "modules", subgroup: "module-dim",     description: "Σ H × count uit modules" },
  { label: "Dakoppervlak",                  unit: "m²",   group: "modules", subgroup: "dak" },
  { label: "Dakomtrek",                     unit: "m¹",   group: "modules", subgroup: "dak" },
  { label: "Aantal gevelkolommen per laag", unit: "stuks",group: "modules", subgroup: "gevelkolom",     description: "Aantal hoekkolommen op de gevel, per verdieping" },

  // ── GEVELS ─────────────────────────────────────────────────────
  { label: "Dichte gevel",                  unit: "m²",   group: "gevels",  subgroup: "gevel-opp" },
  { label: "Open gevel",                    unit: "m²",   group: "gevels",  subgroup: "gevel-opp" },
  { label: "Aantal kozijnen",               unit: "stuks",group: "gevels",  subgroup: "gevel-stuks" },
  { label: "Aantal voordeuren",             unit: "stuks",group: "gevels",  subgroup: "gevel-stuks" },

  // ── WANDEN ─────────────────────────────────────────────────────
  { label: "Binnenwand",                    unit: "m¹",   group: "wanden",  subgroup: "binnenwand" },
  { label: "Binnenwand massief",            unit: "m¹",   group: "wanden",  subgroup: "binnenwand",     description: "Alleen .home — massieve binnenwanden" },
  { label: "Aantal binnendeuren",           unit: "stuks",group: "wanden",  subgroup: "binnenwand" },
  { label: "WSW",                           unit: "m¹",   group: "wanden",  subgroup: "wsw-home",       description: "Alleen .home — standaard WSW" },
  { label: "Verzwaarde WSW",                unit: "m¹",   group: "wanden",  subgroup: "wsw-home",       description: "Alleen .home" },
  { label: "Extra verzwaarde WSW",          unit: "m¹",   group: "wanden",  subgroup: "wsw-home",       description: "Alleen .home" },
  { label: "WSW korte zijde",               unit: "m¹",   group: "wanden",  subgroup: "wsw-optop",      description: "Alleen .optop" },
  { label: "WSW lange zijde",               unit: "m¹",   group: "wanden",  subgroup: "wsw-optop",      description: "Alleen .optop" },
  { label: "Extra kolom",                   unit: "stuks",group: "wanden",  subgroup: "extra-kolom",    description: "Alleen .home — extra kolommen" },

  // ── INSTALLATIES ───────────────────────────────────────────────
  { label: "Aantal appartementen",          unit: "stuks",group: "installaties", subgroup: "appartement" },
  { label: "Badkamers klein",               unit: "stuks",group: "installaties", subgroup: "badkamer" },
  { label: "Badkamers midden",              unit: "stuks",group: "installaties", subgroup: "badkamer" },
  { label: "Badkamers groot",               unit: "stuks",group: "installaties", subgroup: "badkamer" },
  { label: "Los toilet",                    unit: "stuks",group: "installaties", subgroup: "badkamer" },

  // ── OVERIG ─────────────────────────────────────────────────────
  { label: "Balkons stuks",                 unit: "stuks",group: "overig",  subgroup: "balkon" },
  { label: "Balkons opp",                   unit: "m²",   group: "overig",  subgroup: "balkon" },
];

/** Volgorde van hoofdgroepen voor de UI. */
export const CATEGORY_GROUP_ORDER: CategoryGroup[] = ["modules", "gevels", "wanden", "installaties", "overig"];

/** Nederlandse labels voor de hoofdgroepen. */
export const CATEGORY_GROUP_LABELS: Record<CategoryGroup, string> = {
  modules:      "Modules",
  gevels:       "Gevels",
  wanden:       "Wanden",
  installaties: "Installaties",
  overig:       "Overig",
};

/** Tailwind-tints per subgroep — zachte achtergrondkleur die in de UI bij elke
 *  invoercategorie zichtbaar is, zodat gerelateerde labels ook visueel bij elkaar
 *  horen. Hex-codes; render als border-left of subtle bg. */
export const SUBGROUP_COLORS: Record<CategorySubgroup, { bg: string; bar: string; label: string }> = {
  "module-opp":   { bg: "#dcfce7", bar: "#16a34a", label: "Oppervlakten"  },   // emerald
  "module-aant":  { bg: "#e0f2fe", bar: "#0284c7", label: "Aantallen"     },   // sky
  "module-dim":   { bg: "#ffedd5", bar: "#ea580c", label: "Afmetingen"    },   // orange
  "dak":          { bg: "#fae8ff", bar: "#a21caf", label: "Dak"           },   // fuchsia
  "gevelkolom":   { bg: "#fef3c7", bar: "#ca8a04", label: "Gevelkolommen" },   // amber
  "gevel-opp":    { bg: "#dbeafe", bar: "#2563eb", label: "Gevelopp"      },   // blue
  "gevel-stuks":  { bg: "#ede9fe", bar: "#7c3aed", label: "Gevel-stuks"   },   // violet
  "binnenwand":   { bg: "#fef2f2", bar: "#dc2626", label: "Binnenwand"    },   // red-50
  "wsw-home":     { bg: "#fee2e2", bar: "#b91c1c", label: "WSW (.home)"   },   // red-100
  "wsw-optop":    { bg: "#ffedd5", bar: "#c2410c", label: "WSW (.optop)"  },   // orange-100
  "extra-kolom":  { bg: "#f1f5f9", bar: "#475569", label: "Extra kolom"   },   // slate
  "appartement":  { bg: "#dcfce7", bar: "#15803d", label: "Appartementen" },   // emerald
  "badkamer":     { bg: "#cffafe", bar: "#0891b2", label: "Badkamers"     },   // cyan
  "balkon":       { bg: "#fef9c3", bar: "#a16207", label: "Balkons"       },   // yellow
};

export const STANDARD_LABEL_SET = new Set(STANDARD_CATEGORIES.map((c) => c.label));

/**
 * Extra invoercategorieën die alleen verschijnen zodra een bouwpakket-materiaal in
 * m³ of m² aan een kengetal-rij hangt. Gezaagd/CNC simpel/CNC complex vangen
 * bewerkingstijd op (labour), Kramerijen is een echt materiaal (schroeven, kramen,
 * nagels) en loopt als m³ per m³ bouwpakket.
 */
export interface ProcessingCategory {
  label: string;
  unit: string;
  description?: string;
}
export const BOUWPAKKET_PROCESSING_CATEGORIES: ProcessingCategory[] = [
  { label: "Gezaagd",     unit: "m³", description: "Te zagen bouwpakketvolume (bewerkingstijd)" },
  { label: "CNC simpel",  unit: "m³", description: "CNC-bewerking eenvoudig (bewerkingstijd)" },
  { label: "CNC complex", unit: "m³", description: "CNC-bewerking complex (bewerkingstijd)" },
  { label: "Kramerijen",  unit: "m³", description: "Bevestigingsmateriaal (schroeven, kramen, nagels)" },
];

export const BOUWPAKKET_PROCESSING_LABEL_SET = new Set(
  BOUWPAKKET_PROCESSING_CATEGORIES.map((c) => c.label),
);
