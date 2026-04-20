"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// ⚠ TIJDELIJK: passwordless login. Elke knop logt direct in als de bijbehorende
// user. Auth-check (`config.ts authorize`) doet géén wachtwoordvergelijking meer.
const ACCOUNTS = [
  { email: "admin@sustainer.nl", label: "Sustainer",  role: "owner",     hint: "Volledige toegang" },
  { email: "calc@stmh.nl",       label: "Stamhuis",   role: "assembler", hint: "Volledige toegang" },
  { email: "calc@timberfy.nl",   label: "VORM",       role: "developer", hint: "Geen toegang tot Kengetallen" },
] as const;

export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function loginAs(email: string) {
    setBusy(email);
    setError("");
    const result = await signIn("credentials", { email, password: "-", redirect: false });
    if (result?.error) {
      setError("Inloggen mislukt");
      setBusy(null);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-sm ring-1 ring-gray-200">
        <div className="mb-8 text-center">
          <div className="mb-3 flex items-center justify-center">
            <span className="font-stedelijk text-[36px] leading-none text-gray-900">sustainer</span>
            <span className="-ml-[6px] translate-y-[9px] rounded bg-gray-100 px-1 py-[2px] text-[12px] font-semibold uppercase leading-none tracking-[0.06em] text-gray-500">
              Calc
            </span>
          </div>
          <p className="mt-4 text-xs text-gray-500">Kies een account om in te loggen</p>
        </div>

        <div className="space-y-2">
          {ACCOUNTS.map((a) => (
            <Button
              key={a.email}
              variant="outline"
              onClick={() => loginAs(a.email)}
              disabled={busy !== null}
              className="flex h-auto w-full items-center justify-between gap-3 rounded-md border-gray-200 px-4 py-3 text-left hover:border-gray-300 hover:bg-gray-50"
            >
              <div className="flex flex-col items-start">
                <span className="text-sm font-semibold text-gray-900">{a.label}</span>
                <span className="text-[11px] font-normal text-gray-500">{a.hint}</span>
              </div>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-500">
                {a.role}
              </span>
            </Button>
          ))}
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <p className="mt-6 text-center text-[10px] text-gray-400">
          Tijdelijk passwordless — voor demo / development.
        </p>
      </div>
    </div>
  );
}
