"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole } from "@/hooks/use-role";
import { Input } from "@/components/ui/input";
import { AppHeader, HeaderContext } from "@/components/app-header";
import { Wrench } from "lucide-react";
import type { LabourRates } from "@/types";

type FieldKey = Exclude<keyof LabourRates, "id" | "orgId">;

interface FieldDef {
  key: FieldKey;
  label: string;
  unit: string;
  group: "bouwpakket" | "arbeid";
  hint?: string;
}

const FIELDS: FieldDef[] = [
  { key: "gezaagdPerM3",               label: "Gezaagd",             unit: "€/m³", group: "bouwpakket", hint: "Kosten per m³ gezaagd bouwpakket-hout" },
  { key: "cncSimpelPerM3",             label: "CNC simpel",          unit: "€/m³", group: "bouwpakket", hint: "Kosten per m³ CNC-bewerking (eenvoudig)" },
  { key: "cncComplexPerM3",            label: "CNC complex",         unit: "€/m³", group: "bouwpakket", hint: "Kosten per m³ CNC-bewerking (complex)" },
  { key: "steenachtigPerM3",           label: "Steenachtig",         unit: "€/m³", group: "bouwpakket", hint: "Kosten per m³ steenachtig-bewerking (Fermacell + Cemvin, auto-afgeleid uit kengetallen)" },

  { key: "assemblageHourlyRate",       label: "Assemblagearbeid",    unit: "€/uur", group: "arbeid", hint: "Tarief voor de kengetallen 'Assemblagearbeid'" },
  { key: "installatieHourlyRate",      label: "Installatiearbeid",   unit: "€/uur", group: "arbeid", hint: "Tarief voor de kengetallen 'Installatiearbeid'" },
  { key: "arbeidBuitenHourlyRate",     label: "Arbeid buiten",       unit: "€/uur", group: "arbeid", hint: "Tarief voor arbeid op de bouwplaats (na aflevering)" },
  { key: "arbeidBuitenHoursBase",      label: "— basis-uren",        unit: "uren",  group: "arbeid", hint: "Vaste opstart-uren voor arbeid buiten, onafhankelijk van aantal modules" },
  { key: "arbeidBuitenHoursPerModule", label: "— uren per module",   unit: "u/mod", group: "arbeid", hint: "Vaste uren arbeid buiten per geplaatste module" },
  { key: "projectmgmtHourlyRate",      label: "Projectmanagement",   unit: "€/uur", group: "arbeid", hint: "Tarief voor werkvoorbereiding + projectmanagement" },
  { key: "projectmgmtHoursBase",       label: "— basis-uren",        unit: "uren",  group: "arbeid", hint: "Vaste opstart-uren voor projectmanagement, onafhankelijk van aantal modules (default 200)" },
  { key: "projectmgmtHoursPerModule",  label: "— uren per module",   unit: "u/mod", group: "arbeid", hint: "Vaste uren projectmanagement per module (default 2)" },
];

export default function LabourRatesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get("project");
  const [projectName, setProjectName] = useState("");
  const { role } = useRole();
  const [data, setData] = useState<LabourRates | null>(null);
  const [loading, setLoading] = useState(true);

  const canEdit = role === "owner";

  useEffect(() => {
    if (!projectId) { setProjectName(""); return; }
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((p) => setProjectName(p?.name ?? ""));
  }, [projectId]);

  useEffect(() => {
    fetch("/api/labour-rates").then((r) => r.json()).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, []);

  async function patch(key: FieldKey, value: number) {
    if (!data) return;
    setData({ ...data, [key]: value });
    const res = await fetch("/api/labour-rates", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Opslaan mislukt: ${err.error ?? res.statusText}`);
      return;
    }
    const updated = await res.json();
    setData(updated);
  }

  const bouwpakketFields = FIELDS.filter((f) => f.group === "bouwpakket");
  const arbeidFields = FIELDS.filter((f) => f.group === "arbeid");

  return (
    <div className="min-h-screen bg-surface">
      <AppHeader
        backLink={projectId && projectName ? { label: projectName, href: `/project/${projectId}` } : undefined}
        kengetalHref={projectId ? `/library/kengetallen?project=${projectId}` : undefined}
        materialsHref={projectId ? `/library/materials?project=${projectId}` : undefined}
        labourHref={projectId ? `/library/labour?project=${projectId}` : undefined}
        center={
          <HeaderContext
            icon={Wrench}
            title="Arbeid & tarieven"
            subtitle="Organisatie-breed"
          />
        }
      />
      <main className="mx-auto max-w-[900px] px-6 py-5">
        {loading || !data ? (
          <div className="text-sm text-muted-foreground">Laden…</div>
        ) : (
          <div className="space-y-4">
            <Section title="Bouwpakket-bewerking" subtitle="Kosten per m³ bewerkt bouwpakket-materiaal. De hoeveelheid m³ per invoercategorie stel je in bij de kengetallen.">
              {bouwpakketFields.map((f) => (
                <Row key={f.key} field={f} value={data[f.key] as number} canEdit={canEdit} onSave={patch} />
              ))}
            </Section>
            <Section title="Arbeid — uurtarieven + module-uren" subtitle="Uurtarieven voor de kengetal-arbeid en de module-gedreven posten (arbeid buiten, projectmanagement).">
              {arbeidFields.map((f) => (
                <Row key={f.key} field={f} value={data[f.key] as number} canEdit={canEdit} onSave={patch} />
              ))}
            </Section>
            {!canEdit && (
              <p className="text-[11px] text-muted-foreground">
                Alleen gebruikers met rol <span className="font-medium">owner</span> kunnen deze tarieven aanpassen.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-gray-200">
      <div className="bg-gray-50/60 px-4 py-2.5">
        <div className="text-sm font-semibold">{title}</div>
        {subtitle && <div className="text-[11px] text-muted-foreground">{subtitle}</div>}
      </div>
      {/* Zebra-striping ipv horizontale borders tussen rijen — minder visuele ruis. */}
      <div className="[&>*:nth-child(even)]:bg-gray-50/40 [&>*:nth-child(odd)]:bg-white">
        {children}
      </div>
    </div>
  );
}

function Row({ field, value, canEdit, onSave }: {
  field: FieldDef;
  value: number;
  canEdit: boolean;
  onSave: (key: FieldKey, v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-2">
      <div className="min-w-0">
        <div className="text-sm">{field.label}</div>
        {field.hint && <div className="text-[11px] text-muted-foreground">{field.hint}</div>}
      </div>
      {canEdit ? (
        <Input
          key={`${field.key}-${value}`}
          className="h-8 w-24 text-right text-xs tabular-nums"
          inputMode="decimal"
          defaultValue={value}
          onBlur={(e) => {
            const raw = e.target.value.replace(",", ".").trim();
            if (raw === "") return;
            const v = parseFloat(raw);
            if (!isNaN(v) && v !== value) onSave(field.key, v);
          }}
        />
      ) : (
        <span className="tabular-nums">{value}</span>
      )}
      <span className="min-w-[3.5rem] text-[11px] text-muted-foreground">{field.unit}</span>
    </div>
  );
}
