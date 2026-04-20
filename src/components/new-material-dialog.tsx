"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COST_GROUP_LABELS } from "@/lib/calculation";
import type { CostGroup } from "@/types";

const UNITS = ["m³", "m²", "m¹", "stuks", "kg", "l", "ton"] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  costGroup: CostGroup;
  onCreated: () => void;
}

function num(s: string): number {
  const v = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : 0;
}

function deriveCode(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return cleaned.slice(0, 8) || "NEW";
}

export function NewMaterialDialog({ open, onOpenChange, costGroup, onCreated }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeManuallyEdited, setCodeManuallyEdited] = useState(false);
  const [unit, setUnit] = useState<string>("m³");
  const [category, setCategory] = useState("");
  const [price, setPrice] = useState("");
  const [lossPct, setLossPct] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setName(""); setCode(""); setCodeManuallyEdited(false);
      setUnit("m³"); setCategory(""); setPrice(""); setLossPct(""); setDescription("");
    }
  }, [open]);

  // Auto-derive code from name unless user edited it manually
  useEffect(() => {
    if (!codeManuallyEdited) setCode(deriveCode(name));
  }, [name, codeManuallyEdited]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/materials", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim() || "NEW",
          name: name.trim(),
          unit,
          category: category.trim() || "Overig",
          costGroup,
          pricePerUnit: num(price),
          lossPct: num(lossPct) / 100,
          laborHours: 0,
          description: description.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Toevoegen mislukt: ${err.error ?? res.statusText}`);
        return;
      }
      onCreated();
      onOpenChange(false);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="tracking-[0.01em]">
            Nieuw materiaal
            <span className="ml-2 text-xs font-normal text-on-surface-var">in {COST_GROUP_LABELS[costGroup]}</span>
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Naam">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Bv. LVL Spruce Q-panel" required />
          </Field>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <Field label="Code">
              <Input value={code}
                onChange={(e) => { setCode(e.target.value.toUpperCase()); setCodeManuallyEdited(true); }}
                placeholder="Auto" />
            </Field>
            <Field label="Eenheid">
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Categorie">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Bv. LVL, Plaat, Isolatie..." />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Prijs (€/eh)">
              <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
            </Field>
            <Field label="Verlies (%)">
              <Input inputMode="decimal" value={lossPct} onChange={(e) => setLossPct(e.target.value)} placeholder="0" />
            </Field>
          </div>
          <Field label="Toelichting">
            <textarea
              className="min-h-[60px] w-full rounded-md border border-input bg-white px-2 py-1.5 text-xs"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optioneel: korte beschrijving, leverancier, etc."
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Annuleren</Button>
            <Button type="submit" className="btn-gradient" disabled={busy || !name.trim()}>
              {busy ? "Toevoegen..." : "Toevoegen"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wider text-on-surface-var">{label}</label>
      {children}
    </div>
  );
}
