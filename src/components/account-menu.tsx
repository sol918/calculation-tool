"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { LogOut, User as UserIcon } from "lucide-react";
import { useRole } from "@/hooks/use-role";

/** Avatar button with a small popover: email, org, role, logout. */
export function AccountMenu() {
  const { user } = useRole();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const initials = (user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-[12px] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 transition-colors hover:bg-slate-200"
        title={user ? `${user.name ?? user.email}` : "Account"}
        aria-label="Account menu"
      >
        <span className="leading-none">{initials}</span>
      </button>
      {open && user && (
        <div
          className="absolute right-0 top-10 z-50 min-w-[220px] overflow-hidden rounded-lg bg-surface-lowest p-1"
          style={{ boxShadow: "0 12px 40px rgba(24, 28, 30, 0.08)" }}
        >
          <div className="border-b-ghost px-3 py-2">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <UserIcon className="h-3.5 w-3.5 text-on-surface-var" />
              {user.name ?? "—"}
            </div>
            <div className="mt-0.5 text-[11px] text-on-surface-var">{user.email}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px]">
              <span className="rounded bg-surface-low px-1.5 py-0.5 font-medium">{user.orgName}</span>
              <span className="text-on-surface-var">{user.orgRole}</span>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-surface-low"
          >
            <LogOut className="h-3.5 w-3.5" /> Uitloggen
          </button>
        </div>
      )}
    </div>
  );
}
