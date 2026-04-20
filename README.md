# Sustainer Calculator

Cost calculator for Sustainer's prefab timber buildings. Replaces the Excel sheet
(`temp prijscalculatietool/260225 - V2.5 - De Calculatiesheet Algemeen HUIDIG.xlsx`)
with a live web app: define a project → buildings → modules + structured inputs →
get a live begroting, transport estimate, engineering fee and Excel export.

Local-only dev for now. Default URL: `http://localhost:3000`.

> **Agent brief:** `CLAUDE.md` is the canonical handover for future Claude Code
> sessions. Read that first if you're picking up work. This README is the
> human-facing orientation.

---

## Stack

- **Next.js 14** (App Router) + **React 18** + **TypeScript**
- **SQLite** via `@libsql/client` + **drizzle-orm** (schema at `src/lib/db/schema.ts`)
- **NextAuth 5** (beta) — credentials provider
- **Tailwind** + shadcn-style primitives in `src/components/ui/`
- **ExcelJS** for begroting export
- **OpenRouteService** HGV routing (optional — falls back to Haversine × 1.3)
- **Inter** body font + **Architype Stedelijk** wordmark (`public/fonts/`)

---

## Quickstart

```bash
npm install
npm run seed                 # additive migrations + schema sync (safe, preserves data)
npm run dev                  # dev server on http://localhost:3000
```

### Reset everything

```bash
RESET_DB=1 npm run seed      # destructive: drops all tables + reseeds demo data
```

Demo accounts (after a RESET_DB seed):

| Email                  | Password        | Role      |
|------------------------|-----------------|-----------|
| `admin@sustainer.nl`   | `sustainer2025` | owner     |
| `calc@stmh.nl`         | `stmh2025`      | assembler |
| `calc@timberfy.nl`     | `timberfy2025`  | developer |

### Other scripts

```bash
npm run build                # production build
npm run start                # production server
npm run db:studio            # drizzle kit studio — browse the DB
npm run db:generate          # generate migration from schema diff
npm run db:push              # push schema without migration file
```

### Environment

`.env.local` (all optional):

```
ORS_API_KEY=...              # OpenRouteService key; enables HGV routing with
                             # 4.0m height-clamped restrictions. Without it the
                             # transport calc uses Haversine × 1.30 @ 70 km/h.
```

---

## Core concepts

### Bouwsysteem (= `kengetal_set`)

A bouwsysteem maps canonical **input labels** (e.g. `Module oppervlak`,
`Dichte gevel`, `WSW lange zijde`) to **materials** via a **ratio**. Three are
seeded:

- **`.home`** — Sustainer Timber Housing (permanent housing, heavy)
- **`.optop`** — lichte optopper (roof-top extensions, light)
- **`.belgium`** — Cordeel CLT

Each set has its own `kengetal_rows` (label → material × ratio) and
`kengetal_labour` rows (label → hours/eenheid + bouwpakket m³ splits).
Projects pick a default; buildings can override.

### Projects, buildings, modules

- **Project** — has phases `SO → VO → DO → UO`. Versions of the same project
  share a `rootProjectId` ("nieuwe fase" duplicates + bumps phase).
- **Building** — one `kengetal_set`, one `count`, holds modules + structured
  inputs.
- **Module** — `lengthM × widthM × heightM × count` (+ optional `isRoof`).
  Roof modules are auto-derived: `roofRatio = 1 / avg_floors` where
  `avg_floors = module_opp_total / opp_begane_grond`. Roof variants add
  `+0.50 m` transport height.

### Structured inputs (the core UI)

`src/components/structured-inputs.tsx` is the primary UI. It writes to the
canonical `STANDARD_CATEGORIES` labels defined in `src/lib/kengetal-categories.ts`
(33 labels — module-derived, gevels, vloeren, appartementen, balkons, WSW, kolommen).
These labels drive the calc; anything else is a user-added "custom" category.

Composite / helper inputs use a `_`-prefix (e.g. `_gevel_m1`, `_pct_glas`,
`_bk_klein`) — they only feed the UI and derive into canonical labels.

### Cost groups

Every material has a `cost_group` — mirrors the Excel "UD_Final" sheet:

| Group           | Meaning                                               |
|-----------------|-------------------------------------------------------|
| `bouwpakket`    | prefab uit fabriek                                    |
| `assemblagehal` | NL-afbouw                                             |
| `installateur`  | gebouwgebonden installaties                           |
| `derden`        | hoofdaannemer-inkoop                                  |
| `hoofdaannemer` | AK / winst, verdeeld over hoofdcategorieën in de pie  |
| `arbeid`        | legacy — now lives inside the specific groups         |

### Markup rows

`markup_rows` per project. Each row has:

- `costGroup` — `null` = project-level staart, else group-level markup
- `type` — `percentage` | `fixed` | `per_m2`
- `basis` — `group_direct` | `group_cumulative` | `totaal_ex_derden`
  | `inkoop_derden` | `grand_total` | `bouwpakket_plus_assemblage`

Apply order: group-direct first, then `totaal_ex_derden`-based, then project
staart on top.

### Transport

Per-trailer, per-building bin packing (First-Fit Decreasing on length). **Never
mix modules from different buildings on one truck.** 4 trailer types, width-tariff
× surcharge × per-hour billing (dagtarief ÷ 8). Retour uit; laad-/lostijd default
120 min. Optional auto-extras: `floor(totalTrucks × 0.05)` — only when ≥1
truck carries >1 module somewhere.

### Engineering fee

Sustainer engineering scales with complexity:

```
repetition  = totalModules / uniqueSizes
complexity  = 1 − clamp(log(repetition) / log(100), 0, 1)   ∈ [0, 1]
engineering = €50 + €50 × complexity                         ∈ [€50, €100] /m² BVO
constructie = €12,50 + €12,50 × complexity + (floors-1) × €2   /m² BVO
```

### Kolomcorrectie

Determines which columns are LVL vs. Baubuche, and at which thickness. Baseline
is `145×145` LVL. Rules depend on number of floors `V`:

- `V ≤ 3` — all LVL 145
- `V = 4` — gevel Baubuche, binnen LVL
- `V = 5` — gevel + binnen Baubuche
- `V ≥ 6` — alles Baubuche; thickness steps (145 → 160 → 200 → 240 → 280 mm)
  based on layers above

**Top 2 layers are always LVL 145** regardless of `V` — they barely carry load.

### Leercurve (DeJong)

Per-bouwsysteem parameters on `kengetalSets` drive a correction factor on
assemblage + installatie arbeidsuren:

```
T(n) = T∞ + (T₁ − T∞) × n^b        b = log(LR) / log(2)
T∞   = T_ref × (VAT_huidig / VAT_max)
```

Each unique modulemaat gets its own curve; weighted by module count.

---

## Architecture map

```
src/
├── app/
│   ├── page.tsx                      Project list (lineage-grouped)
│   ├── login/page.tsx
│   ├── project/[id]/
│   │   ├── layout.tsx                Chrome + FloatingTotals + ProjectContext
│   │   ├── page.tsx                  Split-screen: invulpagina + <BegrotingView>
│   │   └── begroting/page.tsx        Full-width begroting (same component)
│   ├── library/
│   │   ├── materials/page.tsx        Materialenbibliotheek
│   │   ├── kengetallen/page.tsx      Per-system kengetal editor
│   │   └── labour/page.tsx           Labour rates editor
│   └── api/
│       ├── auth/[...nextauth]/
│       ├── materials/                GET/POST/PATCH/DELETE
│       ├── kengetal-sets/[id]/rows/
│       ├── projects/                 + /[id]/{buildings,markups,transport,
│       │                                        versions,duplicate,new-phase,export}
│       ├── buildings/[id]/           {inputs,overrides,modules}
│       ├── labour-rates/
│       ├── vehicle-types/
│       └── transport/calculate       Main transport endpoint
│
├── components/
│   ├── app-header.tsx                Top bar (wordmark + nav + AccountMenu)
│   ├── account-menu.tsx
│   ├── floating-totals.tsx           Bottom-right glass pill (scope-aware totaal)
│   ├── new-project-dialog.tsx
│   ├── new-module-dialog.tsx         Isometric SVG scaler (L/B/H)
│   ├── begroting-view.tsx            Per-group tables + markups + transport tab
│   │                                  + engineering + kolomcorrectie + CSV-import
│   │                                  + sunburst (see begroting-pie.tsx)
│   ├── begroting-pie.tsx             Sunburst donut (3 rings, click to zoom)
│   ├── transport-calculator.tsx      Per-trailer, per-building truck breakdown
│   ├── structured-inputs.tsx         THE important UI — gevels/vloeren/apps + KPI
│   └── ui/                           shadcn primitives
│
├── hooks/
│   ├── use-project-data.ts           Loads project in one sweep
│   ├── use-calculation.ts            Wraps calculateProject() in useMemo
│   └── use-role.ts                   Session role (owner/assembler/developer)
│
├── lib/
│   ├── calculation.ts                PURE calc (classifyBuilding, calculateProject,
│   │                                  computeEngineering, computeKolomCorrectie,
│   │                                  computeLearningFactor, parseAndAggregateCsv)
│   ├── kengetal-categories.ts        STANDARD_CATEGORIES — canonical label list
│   ├── theme.ts                      systemTintStyle(hex) — bouwsysteem accent vars
│   ├── db/{index.ts,schema.ts}       Drizzle client + tables
│   ├── auth/{config,index,session,permissions}.ts
│   └── utils.ts
│
├── types/index.ts                    Types inferred from schema + calc-result shapes
└── app/globals.css                   Design tokens (Architectural Precision)

seed/seed.ts                          Additive migration + demo seeder (886 lines)
public/fonts/Architype-Stedelijk.woff2
data/sustainer.db                     SQLite — timestamped backups alongside it
```

---

## Calculation flow

1. **Per building** — `calculateBuilding` (`src/lib/calculation.ts`):
   - Derive inputs from modules (area, counts per floor/BG/dak/tussen, totals).
   - Merge with manual `building_inputs` (derived wins for module-derived labels).
   - Apply `kengetal_rows` ratios → per-material netto quantities.
   - Apply `kengetal_labour` rows → per-category hours (assemblage + installatie
     + bouwpakket m³ splits).
   - Apply per-material `overrides` (price, loss, labor, qty, CSV toggle).
   - Group by `costGroup`, compute material + labor subtotals.
   - Apply leercurve factor to assemblage + installatie uren.
2. **Per project** — `calculateProject`:
   - Merge buildings (×count), total per group.
   - Auto-transport (Polen): inbound (I-joist m³) + outbound (all bouwpakket m³).
   - Arbeid buiten + projectmanagement uren.
   - Apply `markup_rows` — group-direct first, then `totaal_ex_derden`-basis,
     then project staart.
3. **Transport** — separate: `/api/transport/calculate`:
   - Classify modules to 1 of 4 trailer types.
   - Bin-pack 1D along length, **per building per trailer**.
   - Width-tariff × surcharge × per-hour billing.
   - Auto-extras (5%) applied only where a truck carries >1 module.

---

## UI conventions — "Architectural Precision"

- Fonts: Inter body 14 px; Architype Stedelijk for the `sustainer` wordmark.
- Palette: surface hierarchy (`surface` / `surface-container-low` /
  `surface-container-lowest`); brand purple `#493ee5 → #635bff` gradient for CTAs.
- **No 1-px sectioning borders.** Use background shifts. Ghost borders if you must.
- Headings: `letter-spacing: 0.02em`; numbers: `tabular-nums` everywhere.
- Field row grid: `grid-cols-[1fr_6rem_3rem]` (label · input · unit).
- Derived / read-only values: `pr-3` so the value lines up with input padding.
- Full-page background tints to the **selected building's bouwsysteem color**;
  top-bar is uniform across pages.
- Logo proportions: `sustainer` 28 px (header) / 36 px (login), `CALCULATOR`
  9–10 px with `0.14em` tracking, `gap-1`.

---

## Gotchas

- **Never run `RESET_DB=1 npm run seed` without warning.** It wipes user
  projects. Default `npm run seed` is additive (column alters + label renames).
- **Windows file-handle quirk** — killing the Next dev process leaves
  `data/sustainer.db` locked for a few seconds; if reseed fails with EBUSY,
  sleep 2 and retry.
- **Port 3000 zombies** —
  `netstat -ano | grep :3000` → `powershell -Command "Stop-Process -Id <pid> -Force"`.
- **Webpack cache** can get confused after edits to `session.ts` or auth/layout —
  `rm -rf .next` fixes `Cannot read properties of undefined (reading 'call')`.
- **Stale session cookies after reseed** — `getSessionUser` looks up by email
  against live DB (intentional), so no re-login needed.
- **Route cache keys** include restriction dims — if you change the transport
  calc to use different restrictions, old hits can return stale results. Clear
  with `DELETE FROM route_cache` as needed.
- **Input labels are case-sensitive** and must match `STANDARD_CATEGORIES`
  exactly. Seed has an idempotent label-rename migration that runs every
  `npm run seed`.
- **Bin-packing is 1D** (along trailer length). Width drives tariff, not packing.
- **Extra trucks (5%)** only apply to trailers where >1 module is packed per
  truck somewhere. 1-on-1 is exact.
- **Module axes** — `widthM` = breedte (hoofdbalk, short side),
  `lengthM` = lengte (subbalk, long side), `heightM` = hoogte.
  The isometric SVG in `new-module-dialog.tsx` projects breedte → down-LEFT,
  lengte → down-RIGHT, hoogte → up.
- **`NumInput` in `structured-inputs.tsx`** is focus-guarded — local text state
  + ref so external prop changes don't interrupt typing but DO sync on blur.
  Don't switch it to `defaultValue`: paired inputs like "per app" ↔
  "totaal binnenwand" rely on this.

---

## Decisions the product owner has validated

- Cost groups modeled exactly after the Excel `UD_Final` sheet
  (bouwpakket / assemblagehal / installateur / derden).
- **Per-hour** billing (dagtarief ÷ 8), not per-day.
- **Retour rit off** by default (removed from UI; stored `false`).
- **Laad-/lostijd** default 120 minutes — covers laden + lossen combined.
- Trailer surcharges stay low (`1.00 / 1.05 / 1.15 / 1.25`) — chauffeur cost
  dominates.
- User-visible dropdowns: klant (Timberfy/Vink/Cordeel), assemblagepartij
  (Stamhuis), fase (SO/VO/DO/UO), gevelafwerking (Budget/Middel/Duur).
- **Fase = status.** "Nieuwe fase" duplicates + bumps status. Versies-dropdown
  links siblings via `rootProjectId`.
- Hoofdaannemer markups are **distributed across hoofdcategorieën** in the pie,
  not a separate slice.
- UI is Dutch; the user is Dutch.

---

## Known open items

- **Material library** — description-field editing + row alignment (partial).
- **Advanced kengetal editor** — add/remove of custom input labels from
  `/library/kengetallen`.
- **Deploy** to `sustainer.app/optopper/calculatietool` — needs Supabase port +
  auth swap. Not started.
- **Kengetal-sets CRUD** — creating new sets isn't wired into the UI yet
  (seed-only).
- Modules table still supports `isRoof` in DB; UI hides the toggle and
  auto-derives via `1 / avg_floors`.

---

## When in doubt

- `CLAUDE.md` — agent handover (canonical).
- `temp prijscalculatietool/transport_calculator_brief.md` — transport domain.
- `temp prijscalculatietool/ARCHITECTUUR.md` — original project spec.
- `fixes for the calculation app.md` — backlog of fixes / feedback.
