"use client";

import { useEffect, useState } from "react";
import { formatRemaining } from "@/lib/impersonation";

/**
 * Bara de jos din timpul unei simulări de login: spune clar «vezi aplicația ca <cont>», cât mai ține simularea și are butonul de ieșire.
 * Apare pe toate paginile (și pe ecranele instalatorului); nu ocupă loc din pagină (plutește jos, centrat).
 */
export default function ImpersonationBanner({ who, by, expiresAt }: { who: string; by: string; expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(iv); }, []);
  const left = expiresAt - now;
  const exit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/simulare/iesire", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { to?: string; error?: string };
      if (!r.ok) { setErr(j.error ?? "Nu am putut ieși."); setBusy(false); return; }
      window.location.assign(j.to ?? "/login");
    } catch { setErr("Nu am putut ieși."); setBusy(false); }
  };
  return (
    <div className="imp-bar" role="status" aria-live="polite">
      <span className="imp-dot" aria-hidden="true" />
      <span className="imp-txt"><b>Simulare de login</b> — vezi aplicația ca <b>{who}</b> · tu ești <b>{by}</b> · {left > 0 ? `mai ține ${formatRemaining(left)}` : "a expirat"}</span>
      <button type="button" className="btn btn-sm" onClick={() => void exit()} disabled={busy}>{busy ? "Se iese…" : "Ieși din simulare"}</button>
      {err && <span className="imp-err" role="alert">{err}</span>}
    </div>
  );
}
