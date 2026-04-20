"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const CLIENTS = ["Timberfy", "Vink", "Cordeel"] as const;
const ASSEMBLY_PARTIES = ["Stamhuis"] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [client, setClient] = useState<string>("Timberfy");
  const [assemblyParty, setAssemblyParty] = useState<string>("Stamhuis");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), client, assemblyParty }),
      });
      if (!res.ok) { alert("Kon project niet aanmaken"); return; }
      const p = await res.json();
      onOpenChange(false);
      setName("");
      router.push(`/project/${p.id}`);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="tracking-[0.01em]">Nieuw project</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3 pt-2">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Projectnaam</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Bv. Strandeiland P9/P10" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Klant</label>
              <Select value={client} onValueChange={setClient}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLIENTS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Assemblagepartij</label>
              <Select value={assemblyParty} onValueChange={setAssemblyParty}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSEMBLY_PARTIES.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-[11px] text-on-surface-var">
            Fase begint op <span className="font-medium">SO</span>. Gebouwen en bouwsysteem kies je straks in het project zelf.
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Annuleren</Button>
            <Button type="submit" className="btn-gradient" disabled={busy || !name.trim()}>
              {busy ? "Aanmaken..." : "Aanmaken"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
