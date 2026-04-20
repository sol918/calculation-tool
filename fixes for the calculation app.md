# Fixes for the calculation app

Testproject: **testproject** — Reference Excel (`260225 - Reference.xlsx`), .home system,
18 apartments, 108 modules, 1.411 m² BVO.

## Score vs Excel

| Groep | App (nu) | Excel | Gap |
|---|---:|---:|---:|
| **Materiaal Bouwpakket**   | € 178.422 | € 503.177 | − € 324.755 |
| **Arbeid Bouwpakket**      | €       0 | € 298.651 | − € 298.651 |
| **Transport Polen**        | €  11.900 | (p.m.)    | — |
| Subtotaal Bouwpakket       | € 190.322 | € 825.827 | − € 635.505 |
| **Materiaal Assemblagehal**| € 181.120 | € 410.384 | − € 229.264 |
| **Arbeid Assemblagehal**   | €  34.516 | € 769.797 | − € 735.281 |
| Subtotaal Assemblagehal    | € 215.636 | € 1.180.181 | − € 964.545 |
| **Inkoop Installateur**    | € 397.692 | € 397.682 | **€ +10 ✓** |
| Totaal (exkl. staart)      | € 1.180.056 | € 3.068.380 | − € 1.888.324 |

Inkoop Installateur komt **exact** overeen (binnen €10 — rondings­verschil) —
dat deel van het model klopt dus structureel. De rest van de gaten komt door
ontbrekende kengetallen + arbeid + type-onderscheid in wanden.

De onderstaande lijst is per probleem gecategoriseerd zodat je zelf kan kiezen
wat je wel en niet oppakt.

Legenda:
- 🔴 Grote impact (>€100k gap of blokkeert werkend model)
- 🟠 Middel (€10–100k of maakt het vergelijk onbetrouwbaar)
- 🟡 Klein (cosmetisch, edge-case, of <€10k)

---

## 1. 🔴 `.home`-systeem mist bijna alle arbeid-kengetallen

**Probleem.** Excel .home heeft arbeidsnormen per m², per m1, per kozijn, per
module, per badkamer — samen ± 9.800 uur voor dit project (€770k Assemblagehal
+ €298k Bouwpakket). De app's `kengetal_labour`-tabel bevat voor de .home set
**nul rijen**. Daarom is Arbeid Bouwpakket €0 en Arbeid Assemblagehal slechts
€34k (uitsluitend projectmanagement uit `labour_rates`).

**Excel-bron.** KG-tab, sectie "Modules" (rij 23–36), "Dichte gevels" (rij 62–69),
"Binnenwanden" (rij 76–77), "WSWO" (rij 92–98), enz.:

| Kengetal | Label | Ratio | Unit | Doel |
|---|---|---:|---|---|
| CNC MB | Module breedte totaal | 0,252 | uur/m1 | CNC bewerking |
| CNC MH | Module hoogte totaal | 0,235 | uur/m1 | CNC bewerking |
| CNC MO | Module oppervlak | 0,375 | uur/m² | CNC plafonds+vloeren |
| CNC GO | Dichte gevel | 0,080 | uur/m² | CNC gevels |
| CNC BL | Binnenwand | 0,180 | uur/m1 | CNC binnenwand |
| CNC WSWO | WSW | 0,190 | uur/m1 | CNC WSW |
| ARB MO | Module oppervlak | 1,392 | uur/m² | Cascomontage |
| ARB M | Aantal modules | 11,52 | uur/module | Cascomontage |
| ARB GO | Dichte+Open gevel | 1,32 | uur/m² | Gevelmontage |
| ARB KA | Aantal kozijnen | 0,84 | uur/kozijn | Kozijnmontage |
| ARB BL | Binnenwand | 1,2 | uur/m1 | Binnenwand |
| ARB WSWO | WSW | 1,2 | uur/m1 | Wandmontage |
| ARB DO | Dakoppervlak | 1,0 | uur/m² | Dakmontage |
| ARB MGMT | Aantal modules | 4 | uur/module | Management |
| ARBI M | Aantal modules | 12 | uur/module | Installatiearbeid binnen |

**Voorstel.**
1. Seed-uitbreiding: vul `kengetal_labour` voor set `.home` met alle bovenstaande
   rijen (routeer CNC → `bouwpakket` via `gezaagdM3PerInput`/`cncSimpel…`, routeer
   ARB_* → `assemblagehal` via `hoursPerInput`).
2. Note: CNC-normen in Excel zijn in **uren**, niet in m³. De app rekent bewerking
   in m³ × €/m³. Twee opties:
   - **A:** kengetal-velden omdopen naar "bewerkings­uren" en rekenen via €/uur
     (zoals Excel doet) — dan moet het UI `gezaagd/CNC` veranderen van "m³" naar "uur".
   - **B:** CNC-uren omrekenen naar equivalente m³ (ad-hoc, zwakker — niet aan
     te raden).
   Ik denk A — consistent met hoe Excel het ziet.

---

## 2. 🔴 `.home`-systeem mist Module-Breedte / Module-Lengte / Module-Hoogte als kengetal-drivers

**Probleem.** Excel gebruikt `Module B` (321 m1), `Module L` (461 m1) en
`Module H` (341 m1) als invoeren voor LVL-kolommen en liggers. De app heeft die
waarden wel als *afgeleide* invoer (`Module breedte totaal` etc.), maar er
staan geen `kengetal_rows` tegen.

Mis­lopende materiaal-inzet:
| Excel kengetal | Label | Ratio | Materiaal |
|---|---|---:|---|
| LVLQ MB | Module breedte totaal | 0,07065 m³/m1 | LVL Q (plafonds/vloeren/kolommen) |
| LVLQ MH | Module hoogte totaal | 0,0841 m³/m1 | LVL Q (kolommen) |
| LVLS DOM | Dakomtrek | 0,01644 m³/m1 | extra LVL S langs dakrand |
| LVLQ DOM | Dakomtrek | 0,0069 m³/m1 | extra LVL Q langs dakrand |
| SPANO DO | Dakoppervlak | 0,01 m³/m² | extra SPANO op dak |

Samen ± 30 m³ LVL extra = ± €21.000 in bouwpakket-materiaal.

**Voorstel.** Voeg deze regels toe aan de `.home`-seed. Allemaal bestaande
materialen (LVLQ / LVLS / SPANO) — geen nieuw materiaal nodig. ± 15 regels seed.

---

## 3. 🔴 Wandtypes — app heeft 3, Excel heeft 5

**Probleem.** Excel onderscheidt:
- A. Binnenwanden (2.036 m1)
- B. Binnenwanden massief — 100 mm LVL kern (0 m1 in dit project, wel in de kengetallen)
- C. Woningscheidende wanden — enkellaags (567 m1)
- D. Verzwaarde WSW — 60 mm massief LVL (1.124 m1)
- E. Extra zware WSW — 120 mm massief LVL (0 m1)

De app heeft alleen:
- `Binnenwand` (1 input)
- `WSW korte zijde` + `WSW lange zijde` (die samen één WSW-type vormen)

Dit geeft een dubbele mismatch: (a) de wand­types ontbreken, (b) WSW korte/lange
zijde is *geometrisch* (korte vs. lange modulezijde), niet constructief
(enkellaags vs. verzwaard vs. extra zwaar).

Gevolg: verzwaarde WSW (1.124 m1) × LVLQ VZSWO 0,176 m³/m = 198 m³ LVL Q mis.
Dat is ± €140.000 bouwpakket.

**Voorstel.** Kies één:

- **A. Volledig aanpassen (klopt semantisch met Excel).** Vervang `Binnenwand`,
  `WSW korte zijde`, `WSW lange zijde` door vijf canonieke labels:
  `Binnenwand regulier`, `Binnenwand massief`, `WSW enkellaags`,
  `WSW verzwaard`, `WSW extra zwaar`. De `structured-inputs.tsx` krijgt dan
  vijf `FieldRow`'s onder "Wanden". Migratie: zet `Binnenwand` → `Binnenwand regulier`,
  `WSW korte zijde` → `WSW enkellaags`, `WSW lange zijde` → `WSW verzwaard`.
  Meest werk, meest accuraat.

- **B. Snelle overbrugging.** Houd de 3 labels; voeg 2 extra canonieke labels toe
  (`Binnenwand massief`, `WSW extra zwaar`) puur voor kengetal-routing. Laat
  de UI voor "korte/lange" staan maar accepteer dat het nu écht
  "enkellaags/verzwaard" betekent.

Ik raad **A** aan — de korte/lange-zijde terminologie zaaide sowieso verwarring.

---

## 4. 🔴 Baubuche-substitutie bij grote modules ontbreekt

**Probleem.** Excel heeft een *conditionele* logica: als een module >6,50 m
lang is of >3,50 m breed, wordt een deel LVL vervangen door Baubuche (BAUB).
Regels:
- ZVLMO (−LVLS +BAUB) wanneer Module O > ...
- VLMB (−LVLQ +BAUB) wanneer Module B > 3,50 m
- VHMH (−LVLQ +BAUB) wanneer Module H × verdiepingen > drempel

In dit project: `Module L > 6,80` en `Module B > 3,50` triggeren 1.057 m1
Baubuche-kolommen (rij 77 Input-tab) — ± €30.000 extra.

De app's kengetal-model is lineair: `qty × ratio`. Er is geen `if`-conditie.

**Voorstel.**
- **A. Nieuwe invoercategorie `Baubuche kolommen` (m1)** — gebruiker vult
  handmatig in (of laat leeg). Drijft BAUB-materiaal rechtstreeks.
  Simpel, maar vereist dat de gebruiker zelf weet hoeveel Baubuche nodig is
  (komt nu uit de Excel formule).
- **B. Conditionele kengetal-extensie.** Voeg een veld `activation_rule` toe
  aan `kengetal_rows` (bv. JSON: `{"when": "module_breedte_max > 3.5"}`).
  Krachtig maar hele verbouwing. Niet doen voor deze ene use-case.
- **C. Afgeleide invoer.** In `calculation.ts::deriveInputsFromModules` bereken
  automatisch `Baubuche_kolommen_m1` = Σ(max(0, moduleB − 3,5) × count × aantal_verdiepingen)
  e.d. Dan via normaal kengetal. **Voorkeur — geen schema-wijziging.**

Maak Optie C. Documenteer de drempels ergens centraal zodat de regels
aanpasbaar zijn.

---

## 5. 🟠 Gevel-oppervlak: Excel-waarde onleesbaar

**Probleem.** Excel heeft "Open gevels = 1,564 m²" en "Dichte gevels = 1,564 m²"
op de Input-tab (rij 6/7). Physiek onmogelijk voor een 18-appartementen/5-lagen
gebouw. Twee lezingen:

- (a) Iemand heeft de waarden verkeerd overgenomen (tikfout, placeholder).
- (b) Het zijn representatieve waarden die in het rekenblad ergens anders
  worden overschreven door de `_vtKZ`/`_vtWA`-varianttabellen.

De app berekent gevel via `_gevel_m1 × avg_hoogte_modules × floors + dakomtrek × 0.5`.
Voor testproject: 98 × 3.155 × 3 + 49 ≈ 976 m² — fysiek aannemelijk.

**Voorstel.**
1. Geen code-wijziging. Document dat de appgevel-logica **afwijkt** van het
   Excel-blad — bewust, omdat Excel hier buggy lijkt.
2. Optioneel: open het Reference-Excel met Sustainer en valideer of 1.564
   een tikfout is. Als het klopt: wat doet Excel er feitelijk mee? (Kan zijn
   dat de formules deze input niet eens gebruiken.)

---

## 6. 🟠 `Aantal kozijnen × ARB KA` ontbreekt

**Probleem.** Excel: `ARB KA = 0,84 uur/kozijn`. 391 kozijnen × 0,84 = 329 uur
Cascomontage. Bij €47/u = €15.463 (matcht exact Excel row 68: Arbeid gevels €15.464).

Onze app heeft wel een `Aantal kozijnen`-input, maar geen `kengetal_labour`-rij
die dat uurnorm driving: dus 0 uur bijgedragen.

**Voorstel.** Seed-entry:
```
{ setId: .home, inputLabel: "Aantal kozijnen", hoursPerInput: 0.84 }  // → assemblagehal
```
(Gezien task 1 valt dit daaronder — zelfde aanpak.)

---

## 7. 🟠 Begane-grond-toeslagen / aftrekken ontbreken

**Probleem.** Excel heeft aparte regels voor BG-modules:
- HIJS BGM: −4 stuks/module (minder hijsankers)
- FUND BGM: +4 stuks/module (funderingsankers)
- TPT BGM: +2 stuks/module (taartplateau)
- CEM VO: +0,005 m³/m² (cempanel ipv fermacell op BG)
- FER 18 VO: −0,018 m³/m² (min fermacell)
- STAAL V: "meerkosten begane grond verankering" (€-forfait per m² BG)

Dit drijft materialen via `Module Aantal BG` (= 36 in dit project).

De app heeft `Module Aantal BG` als afgeleide input, maar geen kengetal-rijen
die er tegenaan hangen voor .home.

**Impact.** ± €15.000–25.000 materiaal + transport/hijs correcties.

**Voorstel.** Seed-uitbreiding — gebruik `Module Aantal BG` als kengetal-label.
Negatieve ratio's zijn al mogelijk in de tabel (`ratio REAL`).

---

## 8. 🟠 Appartement-toeslagen voor badkamers / installatiekasten ontbreken

**Probleem.** Excel row 145–148:
- SPANO APP: +0,55 m³/app (spaanplaat voor badkamer, tech kast, toilet)
- GIPS APP: −0,38 m³/app (min gips want vervangen door SPANO)
- WIND A: 0 m²/app (windstopper)
- ARB MGMT: 4 uur/module (projectmanagement)
- ARBI M: 12 uur/module (installatie binnen)
- ARBI T: 5 uur/tech ruimte (installatiearbeid tech)

De app heeft `Aantal appartementen` maar de kengetal-rijen voor SPANO/GIPS
toeslagen ontbreken. ARBI M staat ook niet.

**Impact.** ± €5.000 materiaal + ± 1.350 uur installatie = € 88.000 arbeid.

**Voorstel.** Seed-uitbreiding — standaard toevoegen.

---

## 9. 🟠 Assemblage­hal-materialen ontbreken / undervalued

**Probleem.** App Inkoop Assemblagehal = €181k, Excel €410k. Gap €229k.
Na audit mist de app:

- **Staal** (fundering/verankering) — STAAL V ≈ €40k voor dit project.
- **Evenaar/laadkraan** (transport hulpmiddel) — ~€8k. App heeft hier niets voor.
- **Opslag modules** — Excel heeft een aparte regel "Opslag modules" voor
  vrachten vanuit assemblagehal naar opslag. App heeft dit niet.
- **Trap/binnendeurdorpel** — niet in app-seed.
- **Balkonankers / Kernkoppelankers / Akoestisch drukplaatje** — niet in app.
- **Verzwaard-dak-toeslag** — Excel heeft dit, app niet (Verzwaard dak = 0 in
  testproject — laat deze laatste dus liggen).

**Voorstel.** Inventarisatie: open `UD_Final_TFY` rij 29–63 en check welke
materialen in de app-bibliotheek ontbreken. Voeg ze toe aan `seed/seed.ts` én
aan de `.home` kengetal-mapping.

---

## 10. 🟠 Transport Polen: aantal trucks wijkt af

**Probleem.** Excel row 70: "1d transport = 14,1 vrachtwagens" (auto-berekend
via module-volume / 30 m³/truck). App: 17 trucks × €700 = €11.900.

Excel's kostprijs per truck is niet zichtbaar op Input-tab; moet uit de KG-sheet
of een formule komen. App's €700 staat vast. De 3 trucks verschil (14 vs 17) zit
in de volume-aanname:
- Excel: `outbound_m³ = module-m³ totaal` (circa 1.411 m² × gemiddelde modulhoogte)
- App: `outbound = Σ bouwpakket m³` + I-joist m³ (benadering)

**Voorstel.** Align de outbound-m³-formule naar *module-volume*:
`outbound_m³ = Σ (length × width × height) × count` voor alle modules. Dat
matcht de Excel direct en is ook fysiek correcter (het bouwpakket *is* de
module). Inbound blijft I-joists + LVL + SPANO (grondstoffen).

Kleinere fix dan #1–#4 maar maakt auto-transport 1:1 vergelijkbaar.

---

## 11. 🟡 Module-Opp-Vloer BG / Plafond / Dak labels — partial overlap

**Probleem.** Excel drijft LVL-plafondmaterialen via `Module Opp` (= hele area).
App splitst in `Module Opp Plafond` = totaal area − dak. Resultaat: **klein
verschil** — app telt de dakverdieping niet als plafond.

Voor testproject: app gebruikt plafond = 1.411 − 614 = 797 m², Excel 1.411 m².
Verschil 614 m² × 0,05 m³/m² = 31 m³ LVL = ± €22.000.

**Voorstel.** Twee opties:
- **A.** App-logica aanpassen: `Module Opp Plafond` = totaal module-opp
  (geen dak-aftrek), en dak-toeslag (PIR/BIT) via `Dakoppervlak` los zoals nu.
- **B.** Excel-conventie overnemen: plafond = totaal module-opp (alles onder
  een dak heeft ook een plafond).

Ik denk B, maar valideer met Sustainer: is er een constructief plafond onder
het dak, of is de LVLQ-plafond tegelijk de onderkant van het dakpakket?

---

## 12. 🟡 Opslag hoofdaannemer: basis onduidelijk

**Probleem.** Excel "Bijkomend (hoofdaannemer)" bevat:
- AK + W&R 14% over **€440.000** ("inkoop hoofdaannemer") — niet over totaal
- ABK 7% over wat? (Excel-cel is onleesbaar gesneden — "voor de hekken...
  MINDER DAN 10 KORTER BOUWWEG")
- Coördinatie 5% over subtotaal assemblagehal
- CAR 0,30% over totaal subtotaal

Mijn seed gebruikte `basis: inkoop_derden` voor AK+W&R en `grand_total` voor
CAR/ABK — dat lijkt goed, maar de **€440.000 basis** staat hard-coded in
Excel. In de app moet dat een input zijn ("Inkoop hoofdaannemer bedrag" of
een staart-regel met vast bedrag).

**Voorstel.** Voeg een aparte `derden`-invoer toe (fixed EUR) of een
`derden`-materiaal "Inkoop hoofdaannemer" dat gewoon €440.000 is. Dan werkt
`inkoop_derden` basis correct.

---

## 13. 🟡 Module-oppervlak wordt als "Aantal modules × wat?" gerekend

**Probleem.** App kent `Aantal modules` = 108 (totaal). Excel drijft HIJS, KRAM
op basis daarvan — werkt. Maar voor bv. ARB M (arbeid per module), de app heeft
wel `Aantal modules` als label, alleen de `kengetal_labour` rijen zijn leeg.

Samen met #1 → opgelost.

---

## 14. 🟡 Badkamer-types S/M/L splitting

**Probleem.** App: `Badkamers klein/midden/groot` + `Los toilet` (4 categorieën).
Excel: "Badkamers S / S+T / M / M+T / Installaties S / M" (6 categorieën).

De Excel-index "S+T" = klein inclusief toilet (één geintegreerde ruimte);
de app modelt dat via `Badkamers klein` + aparte `Los toilet` checkbox.

Voor testproject: S = 18, alle andere 0, Los toilet = 18. App zet dat als
`Badkamers klein` 18 + `Los toilet` 18. Excel-rij 33/34 "Installaties S/M" =
18 van installatieset M — dat mapt niet 1:1.

**Voorstel.** Lage prioriteit — zolang `Aantal appartementen` correct is,
dekt `Aantal appartementen × installatieset-kengetallen` het grootste deel.

---

## 15. 🟡 Project-inputs `Module L > 6,80` en `Module B > 3,5` als afgeleide

**Probleem.** Excel berekent automatisch:
- `Module L > 6,8 m2 oppervlak` — som van area van modules met lengte > 6,80
- `Module B > 3,5 breedte` — som van m1 breedte van modules met breedte > 3,50

Dit wordt gebruikt als input voor de Baubuche-logica (zie #4).

**Voorstel.** Samen met #4 oplossen — beide zijn afgeleide inputs.

---

## 16. 🟡 Kozijn­oppervlak uit Aantal kozijnen-formule

**Probleem.** Excel heeft geen "Kozijn oppervlak" als aparte input — het wordt
gerekend als `Aantal kozijnen × 1,8 m²` (vaste aanname). App doet dit impliciet
via het `_aantal_kozijnen` composite veld op `Open gevel`. Klopt dus.

**Voorstel.** Geen actie.

---

## Samenvatting — waar zit het grootste gap

| # | Probleem | Geschatte impact |
|---|---|---:|
| 1 | Labour-kengetallen .home leeg | **€ 1.070.000** |
| 3 | Wand-types ontbreken | **€ 140.000** |
| 4 | Baubuche-substitutie ontbreekt | € 30.000 |
| 2 | Module B/L/H als kengetal-driver | € 21.000 |
| 9 | Assemblagehal-materialen missing | € 229.000 |
| 11 | Plafond-area verschil | € 22.000 |
| 6 | ARB KA ontbreekt | (valt onder #1) |
| 7 | BG-module-toeslagen | € 20.000 |
| 8 | Appartement-toeslagen arbeid | € 88.000 |

Meeste winst zit in **#1 (labour seed)** + **#9 (materiaal inventarisatie)** +
**#3 (wandtypes)**. Die drie samen dekken grof geschat €1,4M van de €1,9M gap.
De rest (€0,5M) zit in #2/#4/#7/#8/#11 en diverse kleinere posten.

Mijn voorstel voor volgorde, als je dit wilt oppakken:

1. **Eerst #1** (seed labour-kengetallen voor .home) — grootste impact, pure data.
2. **Dan #9** (missing materiaal-audit, seed-uitbreiding) — pure data.
3. **Dan #3** (wandtypes — vereist UI-wijziging in `structured-inputs.tsx` en
   eventueel label-migratie).
4. **Dan #2/#7/#8** (seed-uitbreidingen, pure data).
5. **Tot slot #4/#11/#10/#12** (afgeleiden en grensgevallen, na validatie met
   Sustainer-team).

Backup van huidige projecten staat in `temp_backups/sustainer.db.backup-*.db`.
