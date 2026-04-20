"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/app-header";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { Plus, FileText, ArrowRight, Copy, Trash2, GitBranch, MoreVertical } from "lucide-react";
import type { Project } from "@/types";

const PHASES = ["SO", "VO", "DO", "UO"] as const;

export default function ProjectsPage() {
  const router = useRouter();
  const { loading: authLoading } = useRole();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  async function reload() {
    const res = await fetch("/api/projects");
    setProjects(await res.json());
  }
  useEffect(() => { if (!authLoading) reload().finally(() => setLoading(false)); }, [authLoading]);

  async function duplicateLineage(primaryId: string) {
    setBusy(primaryId);
    try {
      const res = await fetch(`/api/projects/${primaryId}/duplicate`, { method: "POST" });
      if (!res.ok) { alert("Kopiëren mislukt"); return; }
      await reload();
    } finally { setBusy(null); }
  }

  async function deleteLineage(ids: string[], name: string) {
    if (!confirm(`Project "${name}" en alle ${ids.length} versie(s) verwijderen?`)) return;
    setBusy(ids[0]);
    try {
      for (const id of ids) {
        await fetch(`/api/projects/${id}`, { method: "DELETE" });
      }
      await reload();
    } finally { setBusy(null); }
  }

  const groups = useMemo(() => {
    const byRoot = new Map<string, Project[]>();
    for (const p of projects) {
      const key = p.rootProjectId ?? p.id;
      const list = byRoot.get(key) ?? [];
      list.push(p);
      byRoot.set(key, list);
    }
    const out: { primary: Project; versions: Project[] }[] = [];
    for (const [, list] of byRoot) {
      const sorted = [...list].sort((a, b) => {
        const pi = PHASES.indexOf(a.status as any) - PHASES.indexOf(b.status as any);
        if (pi !== 0) return pi;
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
      const primary = sorted[sorted.length - 1] ?? sorted[0];
      out.push({ primary, versions: sorted });
    }
    out.sort((a, b) => (b.primary.createdAt ?? "").localeCompare(a.primary.createdAt ?? ""));
    return out;
  }, [projects]);

  if (authLoading || loading) {
    return <div className="flex min-h-screen items-center justify-center text-on-surface-var">Laden...</div>;
  }

  return (
    <div className="min-h-screen bg-surface">
      <AppHeader />

      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-[0.02em]">Projecten</h2>
          <Button onClick={() => setNewOpen(true)} className="btn-gradient">
            <Plus className="mr-2 h-4 w-4" /> Nieuw project
          </Button>
        </div>

        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg bg-surface-lowest py-16">
            <FileText className="mb-4 h-12 w-12 text-on-surface-var" />
            <p className="text-lg font-medium">Nog geen projecten</p>
            <p className="mb-4 text-sm text-on-surface-var">Maak een nieuw project aan om te beginnen</p>
            <Button onClick={() => setNewOpen(true)} className="btn-gradient">
              <Plus className="mr-2 h-4 w-4" /> Nieuw project
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {groups.map(({ primary, versions }) => (
              <ProjectCard
                key={primary.id}
                primary={primary}
                versions={versions}
                busy={busy === primary.id || (busy !== null && versions.some((v) => v.id === busy))}
                onOpen={() => router.push(`/project/${primary.id}`)}
                onDuplicate={() => duplicateLineage(primary.id)}
                onDelete={() => deleteLineage(versions.map((v) => v.id), primary.name)}
              />
            ))}
          </div>
        )}
      </main>

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

function ProjectCard({
  primary, versions, busy, onOpen, onDuplicate, onDelete,
}: {
  primary: Project;
  versions: Project[];
  busy: boolean;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div
      className={`group relative rounded-lg bg-surface-lowest p-5 transition-all hover:bg-white ${busy ? "opacity-50" : ""}`}
      style={{ boxShadow: "0 1px 2px rgba(24,28,30,0.03)" }}
    >
      <button className="block w-full cursor-pointer text-left" onClick={onOpen}>
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 pr-20">
            <h3 className="truncate text-base font-semibold leading-tight tracking-[0.01em]">{primary.name}</h3>
            <p className="mt-0.5 text-xs text-on-surface-var">
              {primary.client ?? "—"}
              {primary.assemblyParty && <> · {primary.assemblyParty}</>}
            </p>
          </div>
          <span className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white btn-gradient">
            {primary.status}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs text-on-surface-var">
          {versions.length > 1 ? (
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="h-3 w-3" />
              {versions.length} fases · {versions.map((v) => v.status).join(" · ")}
            </span>
          ) : (
            <span>1 fase</span>
          )}
          <ArrowRight className="h-3.5 w-3.5" />
        </div>
      </button>
      {/* Actions: ⋯ dropdown in top-right, below the status badge row */}
      <div ref={menuRef} className="absolute right-3 top-12">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-on-surface-var opacity-0 transition-opacity hover:bg-surface-low group-hover:opacity-100"
          title="Acties"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-8 z-20 min-w-[150px] overflow-hidden rounded-md bg-surface-lowest p-1 text-[13px]"
            style={{ boxShadow: "0 12px 32px rgba(24,28,30,0.10)" }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDuplicate(); }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-surface-low"
            >
              <Copy className="h-3.5 w-3.5" /> Dupliceren
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-destructive hover:bg-surface-low"
            >
              <Trash2 className="h-3.5 w-3.5" /> Verwijderen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
