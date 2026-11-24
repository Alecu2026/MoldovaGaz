"use client";

import Link from "next/link";
import { useState } from "react";
import { passwordProblem, passwordStrength } from "@/lib/password-rules";

const LABEL = ["", "slabă", "acceptabilă", "bună", "puternică"];
/** Alegerea parolei noi cu linkul din e-mail (tokenul vine din adresă; se trimite doar către server, o singură dată). */
export default function ResetForm({ token, email }: { token: string; email: string }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = pw ? passwordProblem(pw, { email }) : null;
  const mismatch = pw2 !== "" && pw !== pw2;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || problem || mismatch || !pw) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/parola/resetare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setErr(j.error ?? "Nu am putut schimba parola."); else setDone(true);
    } catch { setErr("Nu am putut contacta serverul."); } finally { setBusy(false); }
  };
  if (done) return (
    <div style={{ display: "grid", gap: 14 }} role="status">
      <p style={{ margin: 0 }}>Parola a fost schimbată. Te-ai deconectat de pe toate dispozitivele; autentifică-te cu parola nouă.</p>
      <Link className="btn btn-primary" href="/login" style={{ textAlign: "center", height: 40, lineHeight: "40px", padding: 0 }}>Mergi la autentificare</Link>
    </div>
  );
  const s = passwordStrength(pw);
  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0, color: "var(--muted)" }}>Alege o parolă nouă pentru <b style={{ color: "var(--text)" }}>{email}</b>.</p>
      <label className="field"><span>Parolă nouă (cel puțin 8 caractere)</span>
        <div style={{ position: "relative" }}>
          <input className="input" type={show ? "text" : "password"} autoComplete="new-password" autoFocus required maxLength={200} value={pw} onChange={(e) => setPw(e.target.value)} style={{ paddingRight: 84 }} aria-invalid={!!problem} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow((x) => !x)} aria-pressed={show} style={{ position: "absolute", right: 3, top: 3 }}>{show ? "Ascunde" : "Arată"}</button>
        </div>
      </label>
      {pw && <div aria-live="polite"><div style={{ display: "flex", gap: 4 }} aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= s ? (s <= 1 ? "var(--st-critical)" : s === 2 ? "var(--st-warning)" : "var(--st-good)") : "var(--border)" }} />)}</div><span className="cell-sub">{problem ?? `Parolă ${LABEL[s] || "slabă"}`}</span></div>}
      <label className="field"><span>Repetă parola nouă</span><input className="input" type={show ? "text" : "password"} autoComplete="new-password" required maxLength={200} value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch} />{mismatch && <em style={{ color: "var(--danger)", fontSize: 12 }}>Parolele nu sunt la fel.</em>}</label>
      {err && <p role="alert" className="form-error">{err}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !pw || !!problem || pw !== pw2} style={{ height: 40 }}>{busy ? "Se salvează…" : "Schimbă parola"}</button>
    </form>
  );
}
