/**
 * Canonieke invoercategorieën voor alle bouwsystemen. Deze lijst bepaalt welke
 * labels de gebruiker standaard in de kengetallen-library ziet, zelfs als er
 * nog geen materialen aan gekoppeld zijn. De labels moeten exact matchen met
 * wat structured-inputs.tsx als inputLabel wegschrijft naar buildingInputs.
 */
export interface StandardCategory {
  label: string;
  unit: string;
  /** Optional hint shown under the category row. */
  description?: string;
}

export const STANDARD_CATEGORIES: StandardCategory[] = [
  { label: "Module Opp Vloer BG",           unit: "m²",   description: "Footprint begane grond (1 laag vloer)" },
  { label: "Module Opp Vloer Overig",       unit: "m²",   description: "Vloeren boven BG (totaal − BG)" },
  { label: "Module Opp Plafond",            unit: "m²",   description: "Totaal plafondoppervlak (één per verdieping)" },
  { label: "Module Opp Dak",                unit: "m²",   description: "Oppervlak bovenkant gebouw (= footprint)" },
  { label: "Modules begane grond",          unit: "stuks",description: "Modules op begane grond (afgeleid uit BGG)" },
  { label: "Modules dak",                   unit: "stuks",description: "Modules met dakopbouw (afgeleid uit BGG)" },
  { label: "Modules tussenverdieping",      unit: "stuks",description: "Modules op tussenverdiepingen" },
  { label: "Module lengte totaal",          unit: "m¹",   description: "Σ L × count uit modules" },
  { label: "Module breedte totaal",         unit: "m¹",   description: "Σ B × count uit modules" },
  { label: "Module hoogte totaal",          unit: "m¹",   description: "Σ H × count uit modules" },
  { label: "Dichte gevel",                  unit: "m²" },
  { label: "Open gevel",                    unit: "m²" },
  { label: "Aantal kozijnen",               unit: "stuks" },
  { label: "Dakoppervlak",                  unit: "m²" },
  { label: "Dakomtrek",                     unit: "m¹" },
  { label: "Gemiddelde verdiepingshoogte",  unit: "m" },
  { label: "Aantal appartementen",          unit: "stuks" },
  { label: "Aantal voordeuren",             unit: "stuks" },
  { label: "Aantal binnendeuren",           unit: "stuks" },
  { label: "Binnenwand",                    unit: "m¹" },
  { label: "Binnenwand massief",            unit: "m¹",   description: "Alleen .home — massieve binnenwanden" },
  { label: "WSW",                           unit: "m¹",   description: "Alleen .home — standaard woningscheidende wand" },
  { label: "WSW korte zijde",               unit: "m¹",   description: "Alleen .optop — WSW langs korte modulezijde" },
  { label: "WSW lange zijde",               unit: "m¹",   description: "Alleen .optop — WSW langs lange modulezijde" },
  { label: "Verzwaarde WSW",                unit: "m¹",   description: "Alleen .home — verzwaarde woningscheidende wand" },
  { label: "Extra verzwaarde WSW",          unit: "m¹",   description: "Alleen .home — extra verzwaarde WSW" },
  { label: "Extra kolom",                   unit: "stuks",description: "Alleen .home — extra kolommen wanneer massieve wand niet volstaat" },
  { label: "Aantal gevelkolommen per laag", unit: "stuks",description: "Aantal hoekkolommen op de gevel, per verdieping (rest = binnenkolommen)" },
  { label: "Badkamers klein",               unit: "stuks" },
  { label: "Badkamers midden",              unit: "stuks" },
  { label: "Badkamers groot",               unit: "stuks" },
  { label: "Los toilet",                    unit: "stuks" },
  { label: "Balkons stuks",                 unit: "stuks" },
  { label: "Balkons opp",                   unit: "m²" },
];

export const STANDARD_LABEL_SET = new Set(STANDARD_CATEGORIES.map((c) => c.label));

/**
 * Extra invoercategorieën die alleen verschijnen zodra een bouwpakket-materiaal in
 * m³ of m² aan een kengetal-rij hangt. Gezaagd/CNC simpel/CNC complex vangen
 * bewerkingstijd op (labour), Kramerijen is een echt materiaal (schroeven, kramen,
 * nagels) en loopt als m³ per m³ bouwpakket.
 */
export const BOUWPAKKET_PROCESSING_CATEGORIES: StandardCategory[] = [
  { label: "Gezaagd",     unit: "m³", description: "Te zagen bouwpakketvolume (bewerkingstijd)" },
  { label: "CNC simpel",  unit: "m³", description: "CNC-bewerking eenvoudig (bewerkingstijd)" },
  { label: "CNC complex", unit: "m³", description: "CNC-bewerking complex (bewerkingstijd)" },
  { label: "Kramerijen",  unit: "m³", description: "Bevestigingsmateriaal (schroeven, kramen, nagels)" },
];

export const BOUWPAKKET_PROCESSING_LABEL_SET = new Set(
  BOUWPAKKET_PROCESSING_CATEGORIES.map((c) => c.label),
);
