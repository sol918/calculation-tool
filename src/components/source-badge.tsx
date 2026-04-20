"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const badgeConfig: Record<string, { label: string; className: string; tooltip: string }> = {
  kengetal: { label: "K", className: "source-badge source-badge-kengetal", tooltip: "Berekend uit kengetallen" },
  default: { label: "D", className: "source-badge source-badge-default", tooltip: "Standaardwaarde uit materialenbibliotheek" },
  csv: { label: "O", className: "source-badge source-badge-csv", tooltip: "Overschreven via CSV-upload" },
  manual: { label: "O", className: "source-badge source-badge-manual", tooltip: "Handmatig overschreven" },
  api_architect: { label: "A", className: "source-badge source-badge-api", tooltip: "Via API (architect)" },
  api_assembler: { label: "A", className: "source-badge source-badge-api", tooltip: "Via API (assembler)" },
  api_sustainer: { label: "A", className: "source-badge source-badge-api", tooltip: "Via API (Sustainer)" },
};

interface SourceBadgeProps {
  source: string;
  detail?: string;
}

export function SourceBadge({ source, detail }: SourceBadgeProps) {
  const config = badgeConfig[source] ?? badgeConfig.default;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={config.className}>{config.label}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{config.tooltip}</p>
          {detail && <p className="text-xs opacity-75">{detail}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
