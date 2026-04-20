"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Isometric box that actually scales with the input dimensions. Labels are
 * rotated to lie along their respective axes so the reader can match edge to
 * label at a glance.
 */
function IsoBlock({ breedte, lengte, hoogte, color = "var(--brand-primary)" }:
  { breedte: number; lengte: number; hoogte: number; color?: string }) {
  const W = 420, Hv = 280;
  const PAD = 44; // room for labels
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = Math.sin(Math.PI / 6);

  // Coordinate system (viewer looks from the front-left-above):
  //   +x = breedte (hoofdbalk) — projects DOWN-LEFT
  //   +y = lengte  (subbalk)   — projects DOWN-RIGHT
  //   +z = hoogte              — projects UP
  const raw = [
    [0, 0, 0],               // 0 front-left-bottom
    [breedte, 0, 0],         // 1 front-right-bottom
    [breedte, lengte, 0],    // 2 back-right-bottom
    [0, lengte, 0],          // 3 back-left-bottom
    [0, 0, hoogte],          // 4 front-left-top
    [breedte, 0, hoogte],    // 5 front-right-top
    [breedte, lengte, hoogte], // 6 back-right-top
    [0, lengte, hoogte],     // 7 back-left-top
  ];
  const proj = raw.map(([x, y, z]) => ({
    x: (y - x) * cos30,
    y: (x + y) * sin30 - z,
  }));
  const xs = proj.map((p) => p.x), ys = proj.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const bboxW = xMax - xMin || 1;
  const bboxH = yMax - yMin || 1;
  const scale = Math.min((W - 2 * PAD) / bboxW, (Hv - 2 * PAD) / bboxH);
  const offX = W / 2 - ((xMin + xMax) / 2) * scale;
  const offY = Hv / 2 - ((yMin + yMax) / 2) * scale;
  const P = proj.map((p) => ({ x: p.x * scale + offX, y: p.y * scale + offY }));

  // Visible faces (looking from +x+y+z camera): top, right, front
  const poly = (idxs: number[]) => idxs.map((i) => `${P[i].x},${P[i].y}`).join(" ");

  const fmt = (v: number) => v.toFixed(3).replace(".", ",");

  // Label anchors — midpoint of the visible edge that corresponds to each axis,
  // offset slightly outward so text doesn't touch the box.
  // breedte (hoofdbalk) edge: P0→P1 (front-bottom)  — axis angle +30° (down-right)
  const midBreedte = { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 + 18 };
  // lengte  (subbalk) edge:  P1→P2 (right-bottom) — axis angle -30° (down-left from back corner, i.e. right going into image)
  const midLengte = { x: (P[1].x + P[2].x) / 2 + 14, y: (P[1].y + P[2].y) / 2 + 6 };
  // hoogte edge: P0→P4 (front-left vertical) — rotated -90°
  const midHoogte = { x: (P[0].x + P[4].x) / 2 - 14, y: (P[0].y + P[4].y) / 2 };

  return (
    <svg viewBox={`0 0 ${W} ${Hv}`} className="h-64 w-full">
      {/* Faces — front is darkest, right mid, top lightest */}
      <polygon points={poly([3, 7, 6, 2])} fill={color} opacity="0.18" />{/* back (guide) */}
      <polygon points={poly([4, 5, 6, 7])} fill={color} opacity="0.30" />{/* top */}
      <polygon points={poly([1, 2, 6, 5])} fill={color} opacity="0.55" />{/* right */}
      <polygon points={poly([0, 1, 5, 4])} fill={color} opacity="0.75" />{/* front */}

      {/* Silhouette */}
      <polyline points={poly([0, 1, 5, 4, 0])} fill="none" stroke={color} strokeWidth="1" />
      <polyline points={poly([1, 2, 6, 5])}    fill="none" stroke={color} strokeWidth="1" />
      <polyline points={poly([4, 5, 6, 7, 4])} fill="none" stroke={color} strokeWidth="1" />

      {/* Labels — rotated to follow their axis */}
      <g fontSize="11" fill="var(--on-surface-variant)" fontVariantNumeric="tabular-nums">
        <text
          x={midBreedte.x} y={midBreedte.y} textAnchor="middle"
          transform={`rotate(30 ${midBreedte.x} ${midBreedte.y})`}
        >breedte · {fmt(breedte)} m</text>
        <text
          x={midLengte.x} y={midLengte.y} textAnchor="start"
          transform={`rotate(-30 ${midLengte.x} ${midLengte.y})`}
        >lengte · {fmt(lengte)} m</text>
        <text
          x={midHoogte.x} y={midHoogte.y} textAnchor="middle"
          transform={`rotate(-90 ${midHoogte.x} ${midHoogte.y})`}
        >hoogte · {fmt(hoogte)} m</text>
      </g>
    </svg>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { lengthM: number; widthM: number; heightM: number; count: number; isRoof: boolean }) => Promise<void> | void;
  tintColor?: string;
}

export function NewModuleDialog({ open, onOpenChange, onSubmit, tintColor }: Props) {
  const [breedte, setBreedte] = useState<string>("3.358");
  const [lengte, setLengte] = useState<string>("5.188");
  const [hoogte, setHoogte] = useState<string>("3.155");
  const [count, setCount] = useState<string>("1");
  const [busy, setBusy] = useState(false);

  const b = parseFloat(breedte.replace(",", ".")) || 0;
  const l = parseFloat(lengte.replace(",", ".")) || 0;
  const h = parseFloat(hoogte.replace(",", ".")) || 0;

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    if (!b || !l || !h) return;
    const cnt = parseInt(count) || 1;
    setBusy(true);
    try {
      // UI "breedte" → schema widthM, "lengte" → lengthM, "hoogte" → heightM.
      // isRoof wordt automatisch afgeleid (ratio dakmodules = 1/gem. verdiepingen).
      await onSubmit({ widthM: b, lengthM: l, heightM: h, count: cnt, isRoof: false });
      onOpenChange(false);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="tracking-[0.01em]">Module toevoegen</DialogTitle>
        </DialogHeader>
        <form onSubmit={handle} className="space-y-3">
          <div className="rounded-md bg-surface-low p-3">
            <IsoBlock breedte={b} lengte={l} hoogte={h} color={tintColor} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Breedte (hoofdbalk)</label>
              <Input type="number" step="0.001" value={breedte} onChange={(e) => setBreedte(e.target.value)} autoFocus />
              <span className="text-[10px] text-on-surface-var">m</span>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Lengte (subbalk)</label>
              <Input type="number" step="0.001" value={lengte} onChange={(e) => setLengte(e.target.value)} />
              <span className="text-[10px] text-on-surface-var">m</span>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Hoogte</label>
              <Input type="number" step="0.001" value={hoogte} onChange={(e) => setHoogte(e.target.value)} />
              <span className="text-[10px] text-on-surface-var">m</span>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-on-surface-var">Aantal stuks</label>
            <Input type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Annuleren</Button>
            <Button type="submit" className="btn-gradient" disabled={busy || !b || !l || !h}>
              {busy ? "Toevoegen..." : "Toevoegen"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
