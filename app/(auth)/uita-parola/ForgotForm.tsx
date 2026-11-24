"use client";

import Link from "next/link";
import { useState } from "react";

/** «Ai uitat parola?»: introduci adresa de e-mail și, dacă e a unui cont activ, primești un link de resetare. Mesajul de după trimitere e același indiferent dacă adresa există. */
export default function ForgotForm({ enabled }: { enabled: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/parola/uitata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setErr(j.error ?? "Nu am putut trimite cererea."); else setDone(true);
    } catch { setErr("Nu am putut contacta serverul."); } finally { setBusy(false); }
  };
  if (!enabled) return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="form-error" role="alert" style={{ whiteSpace: "normal" }}>Resetarea prin e-mail nu este activată pe acest server. Cere unui administrator să-ți schimbe parola (pagina Utilizatori).</p>
      <Link className="btn" href="/login" style={{ textAlign: "center" }}>Înapoi la autentificare</Link>
    </div>
  );
  if (done) return (
    <div style={{ display: "grid", gap: 14 }} role="status">
      <p style={{ margin: 0 }}>Dacă adresa <b>{email.trim()}</b> aparține unui cont activ, ți-am trimis un e-mail cu un link pentru a alege o parolă nouă. Linkul e valabil <b>60 de minute</b> și se poate folosi o singură dată.</p>
      <p className="cell-sub" style={{ whiteSpace: "normal", margin: 0 }}>Nu l-ai primit? Verifică și în «Spam» și așteaptă câteva minute înainte să ceri unul nou.</p>
      <Link className="btn" href="/login" style={{ textAlign: "center" }}>Înapoi la autentificare</Link>
    </div>
  );
  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0, color: "var(--muted)" }}>Scrie adresa de e-mail a contului și îți trimitem un link pentru a alege o parolă nouă.</p>
      <label className="field"><span>Email</span><input className="input" type="email" name="email" autoComplete="username" autoFocus required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!err} /></label>
      {err && <p role="alert" className="form-error">{err}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()} style={{ height: 40 }}>{busy ? "Se trimite…" : "Trimite linkul"}</button>
      <Link className="btn btn-ghost" href="/login" style={{ textAlign: "center" }}>Înapoi la autentificare</Link>
    </form>
  );
}
