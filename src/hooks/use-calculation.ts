"use client";

import { useMemo } from "react";
import {
  calculateBuilding, calculateProject, computeLearningFactor, computeBvo,
  DEFAULT_LABOUR_RATES, DEFAULT_EFFICIENCY,
} from "@/lib/calculation";
import type {
  Project, Building, BuildingInput, Override, Material, Module,
  KengetalRow, KengetalLabour, KengetalSet, ProjectTransport, VehicleType, MarkupRow,
  LabourRates, ProjectCalcResult, ProjectExtraLine,
} from "@/types";
import type { CsvAggregate, CsvOverrideEntry } from "@/lib/calculation";

interface UseCalculationInput {
  project: Project | null;
  buildings: Building[];
  modules: Map<string, Module[]>;
  buildingInputs: Map<string, BuildingInput[]>;
  overrides: Map<string, Override[]>;
  materialsMap: Map<string, Material>;
  kengetalRowsBySet: Map<string, KengetalRow[]>;
  kengetalLabourBySet: Map<string, KengetalLabour[]>;
  allKengetalSets: KengetalSet[];
  transport: (ProjectTransport & { vehicleType?: VehicleType })[];
  markupRows: MarkupRow[];
  labourRates: LabourRates | null;
  csvAggregatesByBuilding?: Map<string, CsvAggregate[]>;
  csvOverridesByBuilding?: Map<string, CsvOverrideEntry[]>;
  /** Extern berekend transport dat boven op assemblagehal.transportCost komt (Transport 3D modulair). */
  autoAssemblageTransport?: number | null;
  extraLines?: ProjectExtraLine[];
}

export function useCalculation({
  project, buildings, modules, buildingInputs, overrides, materialsMap,
  kengetalRowsBySet, kengetalLabourBySet, allKengetalSets, transport, markupRows, labourRates,
  csvAggregatesByBuilding, csvOverridesByBuilding, autoAssemblageTransport, extraLines,
}: UseCalculationInput): ProjectCalcResult | null {
  return useMemo(() => {
    if (!project) return null;
    const rates = labourRates ?? DEFAULT_LABOUR_RATES;
    const setsById = new Map(allKengetalSets.map((s) => [s.id, s]));
    const effFor = (setId: string | null | undefined) => {
      if (!setId) return DEFAULT_EFFICIENCY;
      const s = setsById.get(setId);
      if (!s) return DEFAULT_EFFICIENCY;
      return {
        vatHuidig: s.effVatHuidig ?? DEFAULT_EFFICIENCY.vatHuidig,
        vatMax:    s.effVatMax    ?? DEFAULT_EFFICIENCY.vatMax,
        lr:        s.effLr        ?? DEFAULT_EFFICIENCY.lr,
        nRef:      s.effNRef      ?? DEFAULT_EFFICIENCY.nRef,
      };
    };
    const buildingResults = buildings.map((b) => {
      const setId = b.kengetalSetId ?? project.defaultKengetalSetId ?? "";
      const kg = kengetalRowsBySet.get(setId) ?? [];
      const lab = kengetalLabourBySet.get(setId) ?? [];
      return calculateBuilding(
        b,
        buildingInputs.get(b.id) ?? [],
        modules.get(b.id) ?? [],
        kg,
        lab,
        materialsMap,
        overrides.get(b.id) ?? [],
        rates,
        effFor(setId),
        csvAggregatesByBuilding?.get(b.id) ?? [],
        csvOverridesByBuilding?.get(b.id) ?? [],
      );
    });

    // Project-brede leerfactor voor Arbeid-buiten/Projectmanagement: gebruik eff van
    // defaultKengetalSet, over ALLE modules in het project gestapeld (per gebouw
    // building.count keer dezelfde modulemaat).
    const allModulesFlat: Module[] = [];
    for (const b of buildings) {
      const mods = modules.get(b.id) ?? [];
      for (const m of mods) allModulesFlat.push({ ...m, count: m.count * b.count });
    }
    const projectEff = effFor(project.defaultKengetalSetId);
    const projLearn = computeLearningFactor(allModulesFlat, projectEff).factor;

    // BVO per gebouw → wordt gebruikt voor pricePerM2 + per_m² markups, met
    // bouwsysteem-afhankelijke factoren (.home gebruikt andere coëfficiënten dan .optop).
    const gfaByBuildingId = new Map<string, number>();
    for (const br of buildingResults) {
      const setId = br.building.kengetalSetId ?? project.defaultKengetalSetId ?? "";
      const setName = setsById.get(setId)?.name ?? null;
      gfaByBuildingId.set(br.building.id, computeBvo(br.effectiveInputs, setName));
    }

    // Aantal unieke moduletypes (L|W|H tuples) over het hele project. Drijft de
    // type-penalty in de PM-formule (50u extra per type na de eerste).
    const moduleTypeKeys = new Set<string>();
    for (const b of buildings) {
      const mods = modules.get(b.id) ?? [];
      for (const m of mods) moduleTypeKeys.add(`${m.lengthM}|${m.widthM}|${m.heightM}`);
    }
    return calculateProject(project, buildingResults, transport, markupRows, rates, "Module oppervlak", projLearn, gfaByBuildingId, autoAssemblageTransport ?? 0, moduleTypeKeys.size, extraLines ?? []);
  }, [project, buildings, modules, buildingInputs, overrides, materialsMap, kengetalRowsBySet, kengetalLabourBySet, allKengetalSets, transport, markupRows, labourRates, csvAggregatesByBuilding, csvOverridesByBuilding, autoAssemblageTransport, extraLines]);
}
