"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  Project, Building, BuildingInput, Override, Material,
  KengetalSet, KengetalRow, KengetalLabour, ProjectTransport, VehicleType, Module, MarkupRow,
  LabourRates,
} from "@/types";
import type { CsvAggregate, CsvOverrideEntry } from "@/lib/calculation";

interface ProjectData {
  project: Project | null;
  buildings: Building[];
  modules: Map<string, Module[]>;            // buildingId → modules
  buildingInputs: Map<string, BuildingInput[]>;
  overrides: Map<string, Override[]>;
  materials: Material[];
  materialsMap: Map<string, Material>;
  allKengetalSets: KengetalSet[];
  kengetalRowsBySet: Map<string, KengetalRow[]>;   // setId → rows
  kengetalLabourBySet: Map<string, KengetalLabour[]>; // setId → labour rows
  transport: (ProjectTransport & { vehicleType?: VehicleType })[];
  vehicleTypes: VehicleType[];
  markupRows: MarkupRow[];
  labourRates: LabourRates | null;
  csvAggregatesByBuilding: Map<string, CsvAggregate[]>;
  csvOverridesByBuilding: Map<string, CsvOverrideEntry[]>;
  loading: boolean;
}

export function useProjectData(projectId: string): ProjectData & { refetch: () => void } {
  const [data, setData] = useState<ProjectData>({
    project: null, buildings: [], modules: new Map(), buildingInputs: new Map(),
    overrides: new Map(), materials: [], materialsMap: new Map(),
    allKengetalSets: [], kengetalRowsBySet: new Map(), kengetalLabourBySet: new Map(),
    transport: [], vehicleTypes: [], markupRows: [], labourRates: null,
    csvAggregatesByBuilding: new Map(), csvOverridesByBuilding: new Map(),
    loading: true,
  });

  const fetchData = useCallback(async () => {
    try {
      const [projRes, matsRes, vtRes, ksRes, lrRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch("/api/materials"),
        fetch("/api/vehicle-types"),
        fetch("/api/kengetal-sets"),
        fetch("/api/labour-rates"),
      ]);
      const project: Project = await projRes.json();
      const materials: Material[] = await matsRes.json();
      const vehicleTypes: VehicleType[] = await vtRes.json();
      const allKengetalSets: KengetalSet[] = await ksRes.json();
      const labourRates: LabourRates = await lrRes.json();
      const materialsMap = new Map(materials.map((m) => [m.id, m]));

      const buildingsRes = await fetch(`/api/projects/${projectId}/buildings`);
      const buildings: Building[] = await buildingsRes.json();

      const modulesMap = new Map<string, Module[]>();
      const buildingInputs = new Map<string, BuildingInput[]>();
      const overridesMap = new Map<string, Override[]>();
      const csvAggregatesByBuilding = new Map<string, CsvAggregate[]>();
      const csvOverridesByBuilding = new Map<string, CsvOverrideEntry[]>();
      await Promise.all(buildings.map(async (b) => {
        const [inputsRes, ovRes, modsRes, csvRes] = await Promise.all([
          fetch(`/api/buildings/${b.id}/inputs`),
          fetch(`/api/buildings/${b.id}/overrides`),
          fetch(`/api/buildings/${b.id}/modules`),
          fetch(`/api/buildings/${b.id}/csv`).catch(() => null),
        ]);
        buildingInputs.set(b.id, await inputsRes.json());
        overridesMap.set(b.id, await ovRes.json());
        modulesMap.set(b.id, await modsRes.json());
        if (csvRes && csvRes.ok) {
          const csvBody = await csvRes.json();
          csvAggregatesByBuilding.set(b.id, csvBody.aggregates ?? []);
          csvOverridesByBuilding.set(b.id, csvBody.overrides ?? []);
        }
      }));

      // Fetch kengetal rows for all sets actually used (+ project default if set)
      const setIdsUsed = new Set<string>();
      for (const b of buildings) if (b.kengetalSetId) setIdsUsed.add(b.kengetalSetId);
      if (project.defaultKengetalSetId) setIdsUsed.add(project.defaultKengetalSetId);
      const kengetalRowsBySet = new Map<string, KengetalRow[]>();
      const kengetalLabourBySet = new Map<string, KengetalLabour[]>();
      await Promise.all(Array.from(setIdsUsed).map(async (id) => {
        const [rowsRes, labRes] = await Promise.all([
          fetch(`/api/kengetal-sets/${id}/rows`),
          fetch(`/api/kengetal-sets/${id}/labour`),
        ]);
        kengetalRowsBySet.set(id, await rowsRes.json());
        kengetalLabourBySet.set(id, await labRes.json());
      }));

      const trRes = await fetch(`/api/projects/${projectId}/transport`);
      const transportRaw: ProjectTransport[] = await trRes.json();
      const transport = transportRaw.map((t) => ({ ...t, vehicleType: vehicleTypes.find((v) => v.id === t.vehicleTypeId) }));

      const mkRes = await fetch(`/api/projects/${projectId}/markups`);
      const markupRows: MarkupRow[] = await mkRes.json();

      setData({
        project, buildings, modules: modulesMap, buildingInputs,
        overrides: overridesMap, materials, materialsMap,
        allKengetalSets, kengetalRowsBySet, kengetalLabourBySet,
        transport, vehicleTypes, markupRows, labourRates,
        csvAggregatesByBuilding, csvOverridesByBuilding, loading: false,
      });
    } catch (err) {
      console.error("Failed to load project data:", err);
      setData((prev) => ({ ...prev, loading: false }));
    }
  }, [projectId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { ...data, refetch: fetchData };
}
