# Sustainer Calculator — Agent Brief

Read this first. It's the handover for future Claude Code sessions on this project.

## What this is

Web app (Next.js 14 App Router + SQLite via libsql/drizzle) that calculates costs for Sustainer's prefab timber buildings. Replaces an Excel calculation sheet (`temp prijscalculatietool/260225 - V2.5 - De Calculatiesheet Algemeen HUIDIG.xlsx`). Users define a project → buildings → modules + structured inputs → get a live begroting + transport estimate.

Local-only dev. Default dev URL: `http://localhost:3000`.

## Stack

- Next.js 14 App Router, React 18, TypeScript
- SQLite via `@libsql/client` + `drizzle-orm` (schema at `src/lib/db/schema.ts`)
- NextAuth 5 (beta) credentials provider for auth
- Tailwind + shadcn-style components in `src/components/ui/`
- Inter font (Google) + Architype Stedelijk for the wordmark (`public/fonts/`)
- OpenRouteService HGV routing (optional — falls back to Haversine × 1.3 if no key)

## Commands

```bash
npm run dev                 # dev server, hot reload
npm run seed                # ADDITIVE migrations + schema sync (safe, preserves data)
RESET_DB=1 npm run seed     # DESTRUCTIVE: drops all tables + reseeds demo data
```

Demo accounts (after RESET_DB=1 seed):
- `admin@sustainer.nl` / `sustainer2025` — owner (Sustainer)
- `calc@stmh.nl` / `stmh2025` — assembler (STMH)
- `calc@timberfy.nl` / `timberfy2025` — developer (Timberfy)

## Architecture

### Key concepts

- **Bouwsysteem** = `kengetal_set`. Three exist: `.home` (Sustainer Timber Housing), `.optop` (lichte optopper), `.belgium` (Cordeel CLT). Each set has its own kengetal_rows (label → material × ratio).
- **Project** has a default bouwsysteem; each **building** can override. Projects have phases SO/VO/DO/UO and lineage via `rootProjectId`.
- **Buildings** hold **modules** (L×B×H×count with optional `isRoof`) plus structured `building_inputs`.
- **Cost groups**: `bouwpakket` (prefab uit fabriek), `installateur` (gebouwgebonden installaties), `assemblagehal` (NL-afbouw), `derden` (hoofdaannemer-inkoop). Each material has a `cost_group`.
- **Margins** = `markup_rows` per project. Each row has `costGroup` (null = project-level staart, else group-level), `type` (percentage/fixed/per_m2), `value`, `basis`.
- **Modules** bin-pack onto trailers (First-Fit Decreasing by length). **Never mix modules from different buildings on one truck.** Per-building packing.
- **Roof modules** auto-derived: `roofRatio = 1 / avg_floors` where `avg_floors = module_opp_total / opp_begane_grond`. Roof variants get `+0.50m` transport height.

### Directory map

```
src/
├── app/
│   ├── page.tsx                      Project list (lineage-grouped)
│   ├── login/page.tsx
│   ├── project/[id]/
│   │   ├── layout.tsx                Project chrome: AppHeader + FloatingTotals
│   │   ├── page.tsx                  Split-screen: invulpagina + <BegrotingView>
│   │   └── begroting/page.tsx        Full-width Begroting (same component)
│   ├── library/
│   │   ├── materials/page.tsx        Materialenbibliotheek (all mats, filter by costGroup)
│   │   └── kengetallen/page.tsx      Per-system kengetal editor (+ STANDARD_CATEGORIES overlay)
│   └── api/
│       ├── auth/[...nextauth]/       NextAuth credentials provider
│       ├── materials/                GET/POST/PATCH/DELETE materials
│       ├── kengetal-sets/[id]/rows/  GET/POST/PUT/DELETE kengetal_rows
│       ├── projects/                 GET/POST + /[id]/{buildings,markups,transport,versions,duplicate,new-phase}
│       ├── buildings/[id]/           {inputs,overrides,modules}
│       └── transport/calculate       Main transport cost endpoint (POST)
│
├── components/
│   ├── app-header.tsx                Shared top bar (wordmark + nav + AccountMenu)
│   ├── account-menu.tsx              Avatar popover with logout
│   ├── floating-totals.tsx           Bottom-right glass pill (grand total)
│   ├── new-project-dialog.tsx        Modal for project creation
│   ├── new-module-dialog.tsx         Modal with isometric SVG scaler (breedte/lengte/hoogte)
│   ├── begroting-view.tsx            Per-group materials table + Transport tab + markup editor
│   ├── transport-calculator.tsx      Per-trailer, per-building truck breakdown UI
│   ├── structured-inputs.tsx         THE important UI: Gevels/Vloeren/Appartementen + KPI card
│   └── ui/                           shadcn primitives (button, input, select, dialog, …)
│
├── hooks/
│   ├── use-project-data.ts           Loads everything for a project in one sweep
│   ├── use-calculation.ts            Wraps calculateProject() in a useMemo
│   └── use-role.ts                   Reads session for rol (owner/assembler/developer)
│
├── lib/
│   ├── calculation.ts                PURE calc: classifyBuilding, calculateProject, group math
│   ├── kengetal-categories.ts        STANDARD_CATEGORIES — canonical label list (23 items)
│   ├── theme.ts                      systemTintStyle(hex) → CSS vars for the bouwsysteem accent
│   ├── db/{index.ts,schema.ts}       Drizzle client + all table definitions
│   └── auth/{config,index,session,permissions}.ts
│
├── types/index.ts                    Exported types inferred from schema + calc result shapes
└── app/globals.css                   Design tokens (Architectural Precision palette)

seed/seed.ts                          Additive migration + demo seeder
public/fonts/Architype-Stedelijk.woff2
```

## Canonical input labels (STANDARD_CATEGORIES)

The library shows these 23 regardless of whether they have rows. `structured-inputs.tsx` writes to exactly these names, so adding a material to any of them WILL feed the calculation:

`Module oppervlak · Aantal modules · Lengte totaal · Breedte totaal · Hoogte totaal · Dichte gevel · Open gevel · Aantal kozijnen · Opp begane grond · Dakoppervlak · Dakomtrek · Gemiddelde verdiepingshoogte · Aantal appartementen · Aantal voordeuren · Binnenwand · WSW korte zijde · WSW lange zijde · Badkamers klein · Badkamers midden · Badkamers groot · Los toilet · Balkons stuks · Balkons opp`

Anything else appearing in the library with a "custom" tag is user-added.

Composite inputs are stored with `_`-prefix labels (e.g. `_gevel_m1`, `_pct_glas`, `_bk_klein`, `_balkon_opp_per_stuk`). These are NOT standard categories and don't feed the calc directly — they only drive the structured-inputs UI and derive into the canonical labels.

## Cost calculation order

1. Per building: `calculateBuilding` → gathers module-derived + manual inputs → applies kengetal ratios → material×labor costs per row, grouped by costGroup.
2. Per project: `calculateProject` → merges all buildings (×count), totals per group, applies `markup_rows` in two passes (group-direct then `totaal_ex_derden`-based), then project-level staart on top.
3. Transport (separate): `/api/transport/calculate` classifies modules to trailer types (4), bin-packs PER BUILDING per trailer, applies width-tariff × surcharge × per-hour billing. Optional 5% auto-extras (only when ≥1 truck carries >1 module).

## UI conventions ("Architectural Precision" design system)

- Fonts: Inter body at 14px, Architype Stedelijk for "sustainer" wordmark
- Colors: surface hierarchy `surface` / `surface-container-low` / `surface-container-lowest`, brand purple `#493ee5`→`#635bff` gradient for CTAs
- **No 1-px sectioning borders.** Use background shifts. Ghost borders if you must.
- Headings: `letter-spacing: 0.02em`
- Numbers: tabular-nums everywhere
- Grid for field rows: `grid-cols-[1fr_6rem_3rem]` (label · input · unit)
- Derived/read-only values: `pr-3` on the value cell to line up with input padding

## Open / known-open items

- **Task #14** — Material library: add description-field editing + fix row alignment (partial).
- **Task #15** — Advanced input-fields editor: allow add/remove of custom input labels from `/library/kengetallen`.
- Deploy to `sustainer.app/optopper/calculatietool` (requires Supabase port + auth swap — NOT started; see conversation history from 2026-04-17 for scope).
- Kengetal-sets CRUD: creating new sets isn't wired into the UI yet (only seeded).
- Modules table still supports `isRoof` in DB; UI hides the toggle and auto-derives via `1/avg_floors`.

## Gotchas

- **Never run `RESET_DB=1 npm run seed` without warning.** It wipes user projects. Default `npm run seed` is additive (only alters columns + renames labels).
- Windows: killing the Next dev process leaves a file handle on `data/sustainer.db` for a few seconds; if reseed fails with EBUSY, sleep 2 and retry.
- Port 3000 zombies: `netstat -ano | grep :3000` → `powershell -Command "Stop-Process -Id <pid> -Force"`.
- Next.js webpack cache can get confused after edits to `session.ts` or auth/layout — full restart (`rm -rf .next`) fixes "Cannot read properties of undefined (reading 'call')".
- After a reseed the session cookie references dead org-ids; `getSessionUser` looks up by email against live DB (intentional) so no re-login needed.
- ORS API key lives in `.env.local` as `ORS_API_KEY=...`. When present, HGV routing is used with dimension restrictions clamped to 4.0m (ORS rejects higher). Without key → Haversine × 1.30 @ 70 km/h.
- `NumInput` in `structured-inputs.tsx` is focus-guarded: uses local text state + ref so external prop changes don't interrupt typing but DO sync on blur. Don't switch it to `defaultValue` — paired inputs like "per app" ↔ "totaal binnenwand" rely on this.
- Route cache rows are keyed by from/to + restriction dims. If you change the calculation to use different restrictions, old cache hits can give stale results — clear with `DELETE FROM route_cache` as needed.
- Building-input labels must match `STANDARD_CATEGORIES` exactly (case-sensitive) to drive the calc. The seed has an idempotent label-rename migration that upgrades old names on every `npm run seed`.
- Bin-packing is 1D (along trailer length). Width is a tariff driver, not a packing constraint.
- Extra trucks (5%) only applied to trailers where >1 module is packed per truck somewhere. 1-on-1 is exact.
- Modules' `widthM` = breedte (hoofdbalk, short), `lengthM` = lengte (subbalk, long), `heightM` = hoogte. The SVG block in `new-module-dialog.tsx` projects breedte → down-LEFT, lengte → down-RIGHT, hoogte → up.

## Decisions the user has validated

- Cost groups modeled exactly after the Excel "UD_Final" sheet (bouwpakket / assemblagehal / installateur / derden).
- Per-hour billing (dagtarief ÷ 8), not per-day.
- Retour rit = off by default (removed from UI; stored false).
- Laad-/lostijd default 120 minutes, covers laden + lossen combined.
- Trailer surcharges kept low (1.00 / 1.05 / 1.15 / 1.25) — chauffeur cost dominates.
- User-visible dropdowns: klant (Timberfy/Vink/Cordeel), assemblagepartij (Stamhuis), fase (SO/VO/DO/UO), gevelafwerking (Budget/Middel/Duur).
- Fase = status. "Nieuwe fase" duplicates project + bumps status. Versies-dropdown links siblings via `rootProjectId`.
- Full-page background tints to the selected building's bouwsysteem color. Top-bar is uniform across pages.
- Logo proportions: `sustainer` 28px (header) / 36px (login), CALCULATOR 9–10px with 0.14em tracking, gap-1.

## When in doubt

Read `temp prijscalculatietool/transport_calculator_brief.md` for the transport domain. Read `temp prijscalculatietool/ARCHITECTUUR.md` for the original project spec. Both are Dutch; the user is Dutch and prefers Dutch in the UI.
