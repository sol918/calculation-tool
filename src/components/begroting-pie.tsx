"use client";

import React, { useEffect, useState } from "react";
import { formatEUR } from "@/lib/calculation";

/**
 * Sunburst-diagram: gecentreerde, tekstloze ringen. De binnenste ring is de
 * hoofdverdeling (Bouwpakket / Assemblagehal / Installaties / Inkoop derden /
 * Engineering). Elke volgende ring toont de onderliggende verdeling.
 *
 * Interactie: hover → slice licht op en het midden toont de categorie + €.
 * Klik op een segment → die wordt het nieuwe middelpunt (zoom). Klik op
 * middenknop om terug te gaan.
 */
export interface SunburstNode {
  id: string;
  label: string;
  value: number;
  children?: SunburstNode[];
}

/** Thema-kleuren per hoofdcategorie — roots. Subitems erven een tint van hun root. */
export const THEME_COLORS: Record<string, string> = {
  bouwpakket:    "#635bff", // brand light
  assemblagehal: "#0ea5e9", // sky
  installateur:  "#f59e0b", // amber
  derden:        "#64748b", // slate
  engineering:   "#ec4899", // pink
};

/** Helderheid-laag per ring-diepte (0 = root). */
const RING_LIGHTEN = [0, 0.15, 0.3, 0.45];

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function lighten(hex: string, amt: number): string {
  const [h, s, l] = hexToHsl(hex);
  const newL = Math.min(95, l + amt * 100);
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${newL.toFixed(0)}%)`;
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, startA: number, endA: number): string {
  const span = endA - startA;
  if (span >= Math.PI * 2 - 0.0001) {
    const m = startA + Math.PI;
    return [arcPath(cx, cy, rOuter, rInner, startA, m), arcPath(cx, cy, rOuter, rInner, m, startA + Math.PI * 2)].join(" ");
  }
  const x1 = cx + rOuter * Math.cos(startA);
  const y1 = cy + rOuter * Math.sin(startA);
  const x2 = cx + rOuter * Math.cos(endA);
  const y2 = cy + rOuter * Math.sin(endA);
  const x3 = cx + rInner * Math.cos(endA);
  const y3 = cy + rInner * Math.sin(endA);
  const x4 = cx + rInner * Math.cos(startA);
  const y4 = cy + rInner * Math.sin(startA);
  const large = span > Math.PI ? 1 : 0;
  return [
    `M ${x1.toFixed(3)} ${y1.toFixed(3)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`,
    `L ${x3.toFixed(3)} ${y3.toFixed(3)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4.toFixed(3)} ${y4.toFixed(3)}`,
    "Z",
  ].join(" ");
}

interface Slice {
  node: SunburstNode;
  rootColor: string;
  depth: number;
  startA: number;
  endA: number;
  ringOuter: number;
  ringInner: number;
  path: string;
}

export function BegrotingSunburst({ root }: { root: SunburstNode }) {
  // Focus = node waaruit we "vertrekken". Begin bij root.
  const [focusPath, setFocusPath] = useState<SunburstNode[]>([root]);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Als de onderliggende boom verandert (b.v. gebruiker zet een categorie uit),
  // kunnen nodes uit de `focusPath` verdwenen zijn. Re-resolven op id — valt terug
  // op de nieuwe root als het pad niet meer bestaat. Zonder dit bleven stale
  // referenties in focus staan, waardoor disabled categorieën niet verdwenen.
  useEffect(() => {
    function findById(node: SunburstNode, id: string): SunburstNode | null {
      if (node.id === id) return node;
      for (const c of node.children ?? []) {
        const found = findById(c, id);
        if (found) return found;
      }
      return null;
    }
    setFocusPath((prev) => {
      if (prev.length === 0) return [root];
      const resolved: SunburstNode[] = [root];
      for (let i = 1; i < prev.length; i++) {
        const next = findById(root, prev[i].id);
        if (!next) break;
        resolved.push(next);
      }
      return resolved;
    });
    setHoverId(null);
  }, [root]);

  const focus = focusPath[focusPath.length - 1] ?? root;

  const size = 460;
  const cx = size / 2, cy = size / 2;
  const holeR = 78;
  const maxR = size / 2 - 8;
  const maxDepth = 3; // 3 zichtbare ringen
  const ringThickness = (maxR - holeR) / maxDepth;

  const children = focus.children ?? [];
  const total = children.reduce((s, c) => s + c.value, 0);

  // Bouw ring-segmenten tot maxDepth diep.
  const slices: Slice[] = [];
  function walk(nodes: SunburstNode[], depth: number, startA: number, endA: number, rootColor: string | null) {
    if (depth >= maxDepth) return;
    const span = endA - startA;
    const sum = nodes.reduce((s, n) => s + n.value, 0);
    if (sum <= 0) return;
    let a = startA;
    for (const node of nodes) {
      const slice = (node.value / sum) * span;
      const nextA = a + slice;
      const color = rootColor ?? THEME_COLORS[node.id.split(":")[0]] ?? "#635bff";
      const ringInner = holeR + depth * ringThickness;
      const ringOuter = holeR + (depth + 1) * ringThickness;
      slices.push({
        node,
        rootColor: color,
        depth,
        startA: a,
        endA: nextA,
        ringOuter,
        ringInner,
        path: arcPath(cx, cy, ringOuter, ringInner, a, nextA),
      });
      if (node.children && node.children.length > 0) {
        walk(node.children, depth + 1, a, nextA, color);
      }
      a = nextA;
    }
  }
  walk(children, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, null);

  const hovered = hoverId ? slices.find((s) => s.node.id === hoverId) ?? null : null;
  const centerLabel = hovered ? hovered.node.label : focus.label;
  const centerValue = hovered ? hovered.node.value : (total || focus.value);
  const centerPct = hovered && total > 0 ? ((hovered.node.value / total) * 100).toFixed(1) : null;

  return (
    <div className="rounded-md border bg-white p-4">
      {/* Label + totaal boven het diagram — volgt hover of focus. */}
      <div className="mb-3 flex flex-col items-center justify-center text-center">
        <span className="text-[10px] uppercase tracking-[0.18em] text-[#6b7280]">
          {centerLabel}
        </span>
        <span className="mt-1 text-2xl font-semibold tabular-nums tracking-[0.01em] text-[#111827]">
          {formatEUR(centerValue)}
        </span>
        <span className="mt-0.5 h-4 text-[11px] text-[#6b7280]">
          {centerPct
            ? `${centerPct}%`
            : focusPath.length > 1
              ? "← klik op het midden om terug te gaan"
              : ""}
        </span>
      </div>
      <div className="flex items-center justify-center">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="h-[460px] w-[460px] max-w-full"
          onMouseLeave={() => setHoverId(null)}
        >
          <defs>
            <filter id="sb-shadow" x="-10%" y="-10%" width="120%" height="120%">
              <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#000" floodOpacity="0.06" />
            </filter>
          </defs>
          <g filter="url(#sb-shadow)">
            {slices.map((s) => {
              const isHover = hoverId === s.node.id;
              const fill = lighten(s.rootColor, RING_LIGHTEN[s.depth] ?? 0.3);
              const hasChildren = !!s.node.children && s.node.children.length > 0;
              return (
                <path
                  key={`${s.depth}-${s.node.id}`}
                  d={s.path}
                  fill={fill}
                  stroke="#fff"
                  strokeWidth="1"
                  opacity={hoverId && !isHover ? 0.55 : 1}
                  className={hasChildren ? "cursor-pointer transition-opacity duration-150" : "cursor-default transition-opacity duration-150"}
                  onMouseEnter={() => setHoverId(s.node.id)}
                  onClick={() => { if (hasChildren) setFocusPath((p) => [...p, s.node]); }}
                />
              );
            })}
          </g>
          {/* Midden: clean circle — tekst zit bovenin. Klik = terug als we zijn ingezoomd. */}
          <g
            className={focusPath.length > 1 ? "cursor-pointer" : ""}
            onClick={() => { if (focusPath.length > 1) setFocusPath((p) => p.slice(0, -1)); }}
          >
            <circle cx={cx} cy={cy} r={holeR - 1} fill="#fff" />
            {focusPath.length > 1 && (
              <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fill="#9ca3af">←</text>
            )}
          </g>
        </svg>
      </div>
    </div>
  );
}
