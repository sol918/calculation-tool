"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowUpRight, GitBranch } from "lucide-react";
import type { Project } from "@/types";

const CLIENTS = ["Timberfy", "Vink", "Cordeel", "VORM"] as const;
const ASSEMBLY_PARTIES = ["Stamhuis"] as const;
const PHASES = ["SO", "VO", "DO", "UO"] as const;
const PHASE_LABELS: Record<string, string> = {
  SO: "SO — Structuurontwerp",
  VO: "VO — Voorlopig ontwerp",
  DO: "DO — Definitief ontwerp",
  UO: "UO — Uitvoeringsontwerp",
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project: Project;
  onChanged: () => void;
}

/**
 * Modal met alle project-instellingen (naam, klant, fase, uurtarief, notities)
 * + fase-navigatie (versies + nieuwe fase). Geconcentreerd op één plek zodat het
 * hoofdscherm leeg blijft voor de echte invoer.
 */
export function ProjectSettingsDialog({ open, onOpenChange, project, onChanged }: Props) {
  const router = useRouter();
  const [versions, setVersions] = useState<Project[]>([]);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/projects/${project.id}/versions`).then((r) => r.json()).then(setVersions);
  }, [open, project.id]);

  async function updateProject(updates: Record<string, any>) {
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    onChanged();
  }

  async function newPhase() {
    const res = await fetch(`/api/projects/${project.id}/new-phase`, { method: "POST" });
    if (!res.ok) { alert("Kon geen nieuwe fase aanmaken"); return; }
    const created = await res.json();
    onOpenChange(false);
    router.push(`/project/${created.id}`);
  }

  const sortedVersions = [...versions].sort((a, b) => {
    const pi = PHASES.indexOf(a.status as any) - PHASES.indexOf(b.status as any);
    if (pi !== 0) return pi;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
  const canAdvancePhase = project.status !== "UO";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-white">
        <DialogHeader>
          <DialogTitle>Projectinstellingen</DialogTitle>
          <DialogDescription className="text-xs">
            Algemene project-metadata, fase en uurtarief.
          </DialogDescription>
        </DialogHeader>

        {/* Fase + versies */}
        <div className="rounded-md bg-gray-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            <GitBranch className="h-3 w-3" strokeWidth={1.75} />
            Fase
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-gray-900 px-2 py-0.5 text-[11px] font-semibold text-white">{project.status}</span>
            {sortedVersions.length > 1 && (
              <Select value={project.id} onValueChange={(v) => { if (v !== project.id) { onOpenChange(false); router.push(`/project/${v}`); } }}>
                <SelectTrigger className="h-7 min-w-[220px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sortedVersions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      <span className="font-medium">{v.status}</span>
                      <span className="ml-2 text-gray-500">{v.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canAdvancePhase && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={newPhase}>
                <ArrowUpRight className="mr-1 h-3 w-3" /> Nieuwe fase
              </Button>
            )}
          </div>
        </div>

        {/* Velden */}
        <div className="grid gap-3 text-xs md:grid-cols-2">
          <Field label="Projectnaam">
            <Input key={`name-${project.id}`} className="h-8 text-xs" defaultValue={project.name} onBlur={(e) => updateProject({ name: e.target.value })} />
          </Field>
          <Field label="Status / fase">
            <Select value={project.status} onValueChange={(v) => updateProject({ status: v })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PHASES.map((p) => <SelectItem key={p} value={p}>{PHASE_LABELS[p]}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Klant">
            <Select value={project.client ?? ""} onValueChange={(v) => updateProject({ client: v })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Kies…" /></SelectTrigger>
              <SelectContent>
                {CLIENTS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Assemblagepartij">
            <Select value={project.assemblyParty ?? ""} onValueChange={(v) => updateProject({ assemblyParty: v })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Kies…" /></SelectTrigger>
              <SelectContent>
                {ASSEMBLY_PARTIES.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Uurtarief arbeid (€/u)">
            <Input
              key={`rate-${project.id}-${project.hourlyRate}`}
              className="h-8 text-xs" type="number" step="1"
              defaultValue={project.hourlyRate}
              onBlur={(e) => updateProject({ hourlyRate: parseFloat(e.target.value) || 0 })}
            />
          </Field>
        </div>
        <Field label="Notities">
          <textarea
            key={`notes-${project.id}`}
            className="min-h-[80px] w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            rows={4}
            defaultValue={project.notes ?? ""}
            onBlur={(e) => updateProject({ notes: e.target.value })}
            placeholder="Bv. toelichting, besluiten, openstaande punten…"
          />
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      {children}
    </label>
  );
}
