"use client";

import { useRouter, usePathname } from "next/navigation";
import { Library, Layers, ArrowLeft, Wrench, ChevronRight, Lock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AccountMenu } from "./account-menu";
import { useRole } from "@/hooks/use-role";

interface Props {
  /** Free-form content voor de center-zone. Gebruik bij voorkeur <HeaderContext /> zodat
   *  titel/subtitle/controls consistent uitgelijnd staan. */
  center?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Optional breadcrumb-style back-link (bv. "Strandeiland P9/P10" → /project/abc). */
  backLink?: { label: string; href: string };
  /** Override de Kengetallen-nav href (b.v. om ?project=&set= mee te nemen). */
  kengetalHref?: string;
  /** Override de Materialenbibliotheek-nav href. */
  materialsHref?: string;
  /** Override de Arbeid-nav href. */
  labourHref?: string;
}

/**
 * App-header. Strict 3-zone grid layout:
 *   [Brand]  [Context — groeit/shrinkt]  [Nav + Account]
 *
 * De center-zone is een `min-w-0` flex-1 cel die truncate-gedrag correct doorgeeft
 * aan kind-elementen (titels worden afgekapt, niet de nav).
 */
export function AppHeader({ center, className, style, backLink, kengetalHref, materialsHref, labourHref }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { role } = useRole();
  // Rol-gating: developer (VORM) mag niet in de Kengetallen-bibliotheek.
  const kengetallenLocked = role === "developer";

  const backBreadcrumb = backLink ? (
    <button
      onClick={() => router.push(backLink.href)}
      className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
      title="Terug naar project"
    >
      <ArrowLeft className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      <span className="max-w-[180px] truncate">{backLink.label}</span>
      <ChevronRight className="h-3 w-3 shrink-0 text-gray-400" strokeWidth={1.75} />
    </button>
  ) : null;

  return (
    <header
      className={`border-b border-gray-200 bg-white ${className ?? ""}`}
      style={style}
    >
      <div className="mx-auto grid h-14 max-w-[1400px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-6 px-6">
        {/* ── LEFT: branding ───────────────────────────────────────────── */}
        {/* Lockup: wordmark + "CALC"-badge dicht aan.
             De Stedelijk-pixel-glyphs zitten in de ONDERHELFT van hun em-box,
             dus `items-center` plaatst de badge te hoog. We schuiven de badge
             handmatig naar beneden met translate-Y zodat hij visueel met de
             zichtbare letterhoogte van "sustainer" uitlijnt. Tweak deze waarde
             als het font-rendering in de browser iets anders uitvalt. */}
        <button
          onClick={() => router.push("/")}
          className="flex items-center outline-none"
          aria-label="Home"
        >
          <span className="font-stedelijk text-[26px] leading-none text-gray-900">sustainer</span>
          <span className="-ml-[5px] translate-y-[6px] rounded bg-gray-100 px-1 py-[2px] text-[10px] font-semibold uppercase leading-none tracking-[0.06em] text-gray-500">
            Calc
          </span>
        </button>

        {/* ── CENTER: context ──────────────────────────────────────────── */}
        <div className="flex min-w-0 items-center gap-2">
          {backBreadcrumb}
          <div className="min-w-0 flex-1">{center}</div>
        </div>

        {/* ── RIGHT: nav + account ─────────────────────────────────────── */}
        <div className="flex items-center">
          <nav className="flex items-center gap-0.5">
            <NavLink
              href={kengetalHref ?? "/library/kengetallen"}
              icon={Layers}
              label="Kengetallen"
              active={pathname.startsWith("/library/kengetallen")}
              onNavigate={router.push}
              disabled={kengetallenLocked}
              disabledTitle="Geen toegang voor deze organisatie"
            />
            <NavLink
              href={materialsHref ?? "/library/materials"}
              icon={Library}
              label="Materialen"
              active={pathname.startsWith("/library/materials")}
              onNavigate={router.push}
            />
            <NavLink
              href={labourHref ?? "/library/labour"}
              icon={Wrench}
              label="Arbeid"
              active={pathname.startsWith("/library/labour")}
              onNavigate={router.push}
            />
          </nav>
          <div className="ml-4 border-l border-gray-200 pl-4">
            <AccountMenu />
          </div>
        </div>
      </div>
    </header>
  );
}

// ── Reusable nav-link ──────────────────────────────────────────────
interface NavLinkProps {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onNavigate: (href: string) => void;
  /** Als true: knop niet klikbaar, grijsweergave + lock-icoon. */
  disabled?: boolean;
  /** Tooltip-tekst wanneer disabled. */
  disabledTitle?: string;
}

function NavLink({ href, icon: Icon, label, active, onNavigate, disabled, disabledTitle }: NavLinkProps) {
  if (disabled) {
    return (
      <span
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-gray-300"
        title={disabledTitle ?? "Geen toegang"}
        aria-disabled="true"
      >
        <Icon className="h-4 w-4" strokeWidth={1.75} />
        <span>{label}</span>
        <Lock className="h-3 w-3" strokeWidth={2} />
      </span>
    );
  }
  return (
    <button
      onClick={() => onNavigate(href)}
      className={
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
        (active
          ? "bg-gray-100 text-gray-900"
          : "text-gray-500 hover:bg-gray-50 hover:text-gray-900")
      }
      aria-current={active ? "page" : undefined}
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );
}

// ── Reusable center-zone helper ────────────────────────────────────
interface HeaderContextProps {
  /** Primair label. Donker en semibold — de aandachtstrekker. */
  title: string;
  /** Subtitel / breadcrumb / context — gedempt grijs. */
  subtitle?: string;
  /** Optioneel icoon links van de titel (standaard strokeWidth 1.75). */
  icon?: LucideIcon;
  /** Optionele kleuroverride voor het icoon (b.v. var(--system-tint)). */
  iconColor?: string;
  /** Inline controls rechts van de titel (b.v. een Select/dropdown). */
  children?: React.ReactNode;
}

/**
 * Context-container voor de center-zone van de header. Zorgt voor consistente
 * typografische hiërarchie en uitlijning, zodat alle pagina's hetzelfde ogen.
 * Gebruik:
 *   <HeaderContext icon={Wrench} title="Arbeid & tarieven" subtitle="Organisatie-breed" />
 *   <HeaderContext title="Kengetallen" icon={Layers}>
 *     <Select …>…</Select>
 *   </HeaderContext>
 */
export function HeaderContext({ title, subtitle, icon: Icon, iconColor, children }: HeaderContextProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {Icon && (
          <Icon
            className="h-4 w-4 shrink-0 text-gray-400"
            strokeWidth={1.75}
            style={iconColor ? { color: iconColor } : undefined}
          />
        )}
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-[13px] font-semibold tracking-[0.01em] text-gray-900">
            {title}
          </h1>
          {subtitle && (
            <span className="truncate text-[11px] text-gray-500">{subtitle}</span>
          )}
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
