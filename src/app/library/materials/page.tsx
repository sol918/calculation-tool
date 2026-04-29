"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatPct, COST_GROUP_LABELS } from "@/lib/calculation";
import { Plus, Search, Trash2, Library, GripVertical } from "lucide-react";
import { AppHeader, HeaderContext } from "@/components/app-header";
import { NewMaterialDialog } from "@/components/new-material-dialog";
import type { Material, CostGroup } from "@/types";

const GROUP_COLORS: Record<CostGroup, string> = {
  bouwpakket: "bg-emerald-100 text-emerald-800",
  assemblagehal: "bg-sky-100 text-sky-800",
  installateur: "bg-amber-100 text-amber-800",
  arbeid: "bg-rose-100 text-rose-800",
  derden: "bg-slate-100 text-slate-700",
  hoofdaannemer: "bg-violet-100 text-violet-800",
};

export default function MaterialsLibraryPage() {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get("project");
  const [projectName, setProjectName] = useState<string>("");
  const { role, loading: authLoading } = useRole();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterGroup, setFilterGroup] = useState<CostGroup | "all">("all");
  const [newDialogGroup, setNewDialogGroup] = useState<CostGroup | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<CostGroup | null>(null);

  useEffect(() => {
    if (!projectId) { setProjectName(""); return; }
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((p) => setProjectName(p?.name ?? ""));
  }, [projectId]);

  const canEdit = role === "owner";

  async function reload() {
    const res = await fetch("/api/materials");
    const all = await res.json();
    setMaterials(all);
  }

  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  function openNewDialog(costGroup: CostGroup) {
    setNewDialogGroup(costGroup);
  }

  async function updateMaterial(id: string, updates: Record<string, any>) {
    const res = await fetch("/api/materials", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Update mislukt: ${err.error ?? res.statusText}`);
      return;
    }
    const updated = await res.json();
    setMaterials((prev) => prev.map((m) => (m.id === id ? updated : m)));
  }

  /** Parse getal met punt óf komma als decimaalscheidingsteken. */
  function num(s: string): number {
    const v = parseFloat(String(s).replace(",", "."));
    return Number.isFinite(v) ? v : 0;
  }

  async function deleteMaterial(id: string) {
    if (!confirm("Materiaal verwijderen?")) return;
    await fetch(`/api/materials?id=${id}`, { method: "DELETE" });
    setMaterials((prev) => prev.filter((m) => m.id !== id));
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return materials.filter((m) => {
      if (filterGroup !== "all" && m.costGroup !== filterGroup) return false;
      if (!q) return true;
      return m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q);
    });
  }, [materials, search, filterGroup]);

  // Group by cost group → category. Materials sorted alphabetically by name within
  // each category, categories sorted alphabetically within each group.
  const sections = useMemo(() => {
    const byGroup = new Map<CostGroup, Map<string, Material[]>>();
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name, "nl"));
    for (const m of sorted) {
      const byCat = byGroup.get(m.costGroup) ?? new Map();
      const list = byCat.get(m.category) ?? [];
      list.push(m);
      byCat.set(m.category, list);
      byGroup.set(m.costGroup, byCat);
    }
    // Re-sort category entries alphabetically.
    for (const [g, byCat] of byGroup) {
      const sortedCats = new Map(
        [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b, "nl")),
      );
      byGroup.set(g, sortedCats);
    }
    return byGroup;
  }, [filtered]);

  if (authLoading || loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Laden...</div>;
  }

  const groupOrder: CostGroup[] = ["bouwpakket", "installateur", "assemblagehal", "derden", "hoofdaannemer"];

  return (
    <div className="min-h-screen bg-surface">
      <AppHeader
        backLink={projectId && projectName ? { label: projectName, href: `/project/${projectId}` } : undefined}
        kengetalHref={projectId ? `/library/kengetallen?project=${projectId}` : undefined}
        center={
          <HeaderContext
            icon={Library}
            title="Materialenbibliotheek"
            subtitle="Globaal — gedeeld over alle bouwsystemen"
          />
        }
      />

      <main className="mx-auto max-w-[1400px] px-6 pb-6 pt-10">
        <div className="mb-3 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 pl-8 text-xs" placeholder="Zoek code, naam of categorie..."
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={filterGroup} onValueChange={(v) => setFilterGroup(v as any)}>
            <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle kostengroepen</SelectItem>
              {groupOrder.map((g) => <SelectItem key={g} value={g}>{COST_GROUP_LABELS[g]}</SelectItem>)}
            </SelectContent>
          </Select>
          {canEdit && (
            <Button size="sm" onClick={() => openNewDialog(filterGroup === "all" ? "assemblagehal" : filterGroup)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Nieuw materiaal
            </Button>
          )}
        </div>

        <div className="space-y-4">
          {groupOrder.map((g) => {
            const byCat = sections.get(g);
            const safeByCat = byCat ?? new Map<string, Material[]>();
            const count = Array.from(safeByCat.values()).reduce((s, l) => s + l.length, 0);
            return (
              <div
                key={g}
                className={`rounded-md border bg-white transition-colors ${dragOverGroup === g ? "border-primary bg-primary/5 ring-2 ring-primary/40" : ""}`}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  // Browsers verschillen in case-handling van custom MIME types tijdens
                  // dragover. Normaliseer naar lowercase en accepteer ook text/plain
                  // als fallback (sommige browsers blokkeren custom types tijdens
                  // dragover om security-redenen — text/plain werkt overal).
                  const types = Array.from(e.dataTransfer.types).map((t) => t.toLowerCase());
                  if (types.includes("application/material-id") || types.includes("text/plain")) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverGroup !== g) setDragOverGroup(g);
                  }
                }}
                onDragLeave={(e) => {
                  // Only clear when leaving the card entirely
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  if (dragOverGroup === g) setDragOverGroup(null);
                }}
                onDrop={async (e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  const id = e.dataTransfer.getData("application/material-id")
                    || e.dataTransfer.getData("text/plain");
                  setDragOverGroup(null);
                  if (!id) return;
                  const m = materials.find((x) => x.id === id);
                  if (!m || m.costGroup === g) return;
                  await updateMaterial(id, { costGroup: g });
                }}
              >
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${GROUP_COLORS[g]}`}>{COST_GROUP_LABELS[g]}</span>
                    <span className="text-xs text-muted-foreground">{count} materialen</span>
                  </div>
                  {canEdit && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openNewDialog(g)}>
                      <Plus className="mr-1 h-3 w-3" /> Nieuw in {COST_GROUP_LABELS[g].toLowerCase()}
                    </Button>
                  )}
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      {canEdit && <th className="w-6" />}
                      <th className="px-2 py-1.5 font-medium">Code</th>
                      <th className="px-2 py-1.5 font-medium">Naam &amp; toelichting</th>
                      <th className="px-2 py-1.5 font-medium">
                        <div className="flex items-center justify-end gap-1 text-[10px]">
                          <span className="invisible">€</span>
                          <span className="w-20 text-right">Prijs</span>
                          <span className="invisible">/ m³</span>
                        </div>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <div className="flex items-center justify-end gap-1 text-[10px]">
                          <span className="w-14 text-right">Verlies</span>
                          <span className="invisible">%</span>
                        </div>
                      </th>
                      {canEdit && <th className="w-8" />}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(safeByCat.entries()).flatMap(([cat, list]) => [
                      <tr key={`cat-${g}-${cat}`} className="bg-gray-50/60">
                        <td colSpan={canEdit ? 6 : 5} className="px-2 py-1">
                          {canEdit ? (
                            <CategoryHeader
                              cat={cat}
                              list={list}
                              onRename={async (newName) => {
                                if (!newName.trim() || newName === cat) return;
                                for (const item of list) {
                                  await updateMaterial(item.id, { category: newName });
                                }
                              }}
                            />
                          ) : (
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">— {cat} ({list.length})</span>
                          )}
                        </td>
                      </tr>,
                      ...list.map((m, idx) => (
                        <tr key={m.id} className={`${idx % 2 === 0 ? "bg-white" : "bg-gray-50/40"} hover:bg-blue-50/40`}>
                          {canEdit && (
                            <td className="select-none text-center align-middle">
                              <div
                                className="inline-flex h-6 w-6 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
                                draggable
                                onDragStart={(e) => {
                                  // Zet beide MIME-types: custom voor zelf-detectie,
                                  // text/plain als universele fallback voor browsers die
                                  // custom types tijdens dragover verbergen.
                                  e.dataTransfer.setData("application/material-id", m.id);
                                  e.dataTransfer.setData("text/plain", m.id);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                title="Sleep om naar een andere kostengroep te verplaatsen"
                              >
                                <GripVertical className="h-3.5 w-3.5" />
                              </div>
                            </td>
                          )}
                          <td className="px-2 py-1">
                            {canEdit ? (
                              <Input
                                key={`${m.id}-code-${m.code}`}
                                className="h-7 w-24 text-xs font-medium"
                                defaultValue={m.code}
                                onBlur={(e) => { if (e.target.value !== m.code) updateMaterial(m.id, { code: e.target.value }); }}
                              />
                            ) : <span className="font-medium">{m.code}</span>}
                          </td>
                          <td className="w-full px-2 py-1">
                            {canEdit ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  key={`${m.id}-name-${m.name}`}
                                  className="h-7 w-36 shrink-0 text-xs"
                                  defaultValue={m.name}
                                  onBlur={(e) => { if (e.target.value !== m.name) updateMaterial(m.id, { name: e.target.value }); }}
                                />
                                <Input
                                  key={`${m.id}-desc-${m.description ?? ""}`}
                                  className="h-7 min-w-[200px] flex-1 text-[11px] italic text-muted-foreground"
                                  defaultValue={m.description ?? ""}
                                  placeholder="toelichting (optioneel)"
                                  onBlur={(e) => {
                                    const v = e.target.value;
                                    if (v !== (m.description ?? "")) updateMaterial(m.id, { description: v || null });
                                  }}
                                />
                              </div>
                            ) : (
                              <div className="flex items-baseline gap-2">
                                <span className="font-medium">{m.name}</span>
                                {m.description && (
                                  <span className="truncate text-[11px] italic text-muted-foreground" title={m.description}>
                                    — {m.description}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            <div className="flex items-center justify-end gap-1">
                              <span className="text-[10px] text-muted-foreground">€</span>
                              {canEdit ? (
                                <Input
                                  key={`${m.id}-price-${m.pricePerUnit}`}
                                  className="h-7 w-20 text-right text-xs tabular-nums"
                                  inputMode="decimal"
                                  defaultValue={m.pricePerUnit}
                                  onBlur={(e) => { const v = num(e.target.value); if (v !== m.pricePerUnit) updateMaterial(m.id, { pricePerUnit: v }); }}
                                />
                              ) : (<span className="tabular-nums">{m.pricePerUnit}</span>)}
                              <span className="text-[10px] text-muted-foreground">/</span>
                              {canEdit ? (
                                <Select value={m.unit} onValueChange={(v) => updateMaterial(m.id, { unit: v })}>
                                  <SelectTrigger className="h-7 w-16 px-1.5 text-[10px] text-muted-foreground"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {["m³","m²","m¹","stuks","kg","l","ton"].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              ) : (<span className="text-[10px] text-muted-foreground">{m.unit}</span>)}
                            </div>
                          </td>
                          <td className="px-2 py-1">
                            <div className="flex items-center justify-end gap-1">
                              {canEdit ? (
                                <Input
                                  key={`${m.id}-loss-${m.lossPct}`}
                                  className="h-7 w-14 text-right text-xs tabular-nums"
                                  inputMode="decimal"
                                  defaultValue={Math.round(m.lossPct * 100)}
                                  onBlur={(e) => { const v = num(e.target.value) / 100; if (v !== m.lossPct) updateMaterial(m.id, { lossPct: v }); }}
                                />
                              ) : (<span className="tabular-nums">{Math.round(m.lossPct * 100)}</span>)}
                              <span className="text-[10px] text-muted-foreground">%</span>
                            </div>
                          </td>
                          {canEdit && (
                            <td className="px-2 py-1">
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteMaterial(m.id)}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </td>
                          )}
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
                {count === 0 && (
                  <div className="px-3 py-4 text-center text-[11px] italic text-muted-foreground">
                    Geen materialen — sleep een bestaand materiaal hierheen of klik op "+ Nieuw in {COST_GROUP_LABELS[g].toLowerCase()}".
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="rounded-md border bg-white py-8 text-center text-sm text-muted-foreground">
              {search ? "Geen materialen gevonden." : "Nog geen materialen."}
            </div>
          )}
        </div>

        <div className="mt-3 text-xs text-muted-foreground">
          {filtered.length} materialen{search || filterGroup !== "all" ? ` (gefilterd uit ${materials.length})` : ""}
        </div>
      </main>

      {newDialogGroup && (
        <NewMaterialDialog
          open={true}
          onOpenChange={(o) => { if (!o) setNewDialogGroup(null); }}
          costGroup={newDialogGroup}
          onCreated={reload}
        />
      )}
    </div>
  );
}

function CategoryHeader({
  cat, list, onRename,
}: {
  cat: string;
  list: Material[];
  onRename: (newName: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(cat);
  if (!editing) {
    return (
      <button
        onClick={() => { setValue(cat); setEditing(true); }}
        className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        title="Klik om de categorie te hernoemen"
      >
        — {cat} <span className="lowercase opacity-70">({list.length})</span>
      </button>
    );
  }
  return (
    <Input
      autoFocus
      className="h-6 w-48 text-[10px] uppercase tracking-wider"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => { setEditing(false); await onRename(value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
    />
  );
}
