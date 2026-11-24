"use client";

import { useCallback, useEffect, useState } from "react";
import { describeAgent } from "@/lib/audit-meta";
import { passwordProblem, passwordStrength } from "@/lib/password-rules";

/**
 * «Securitate» (orice cont): schimbarea propriei parole (cere parola veche), sesiunile deschise pe alte dispozitive (cu posibilitatea de a le închide) și activitatea recentă a contului
 * (intrări, încercări eșuate cu adresa ta de e-mail, parole schimbate). Parola uitată se resetează din pagina de autentificare, prin e-mail.
 */
type Sess = { id: string; createdAt: number; expiresAt: number; ua: string | null; ip: string | null; current: boolean };
type Act = { at: number; action: string; ok: boolean; ip: string | null; ua: string | null };
const p2 = (n: number) => String(n).padStart(2, "0");
const dt = (ms: number) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const WHAT: Record<string, string> = { "auth.login": "Autentificare reușită", "auth.login_failed": "Încercare de autentificare EȘUATĂ", "auth.logout": "Ieșire din cont", "auth.password_change": "Parolă schimbată de tine", "auth.password_reset": "Parolă resetată prin e-mail", "auth.sessions_revoke": "Sesiuni închise", "user.password_change": "Parolă schimbată de un administrator" };
const LABEL = ["", "slabă", "acceptabilă", "bună", "puternică"];
const agent = (ua: string | null) => { const a = describeAgent(ua); return a ? `${a.browser} · ${a.os} · ${a.device}` : "dispozitiv necunoscut"; };

export default function SecurityPanel({ email, name }: { email: string; name: string }) {
  const [sessions, setSessions] = useState<Sess[] | null>(null);
  const [activity, setActivity] = useState<Act[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/securitate", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      const j = (await r.json()) as { sessions?: Sess[]; activity?: Act[]; error?: string };
      if (!r.ok) throw new Error(j.error || "Nu am putut citi datele.");
      setSessions(j.sessions ?? []); setActivity(j.activity ?? []); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const post = async (body: unknown) => {
    const r = await fetch("/api/securitate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; closed?: number };
    return { ok: r.ok, j };
  };
  const problem = pw ? passwordProblem(pw, { email, current: cur }) : null;
  const mismatch = pw2 !== "" && pw !== pw2;
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !cur || !pw || problem || pw !== pw2) return;
    setBusy("pw"); setMsg(null);
    try {
      const { ok, j } = await post({ action: "password", current: cur, next: pw });
      if (!ok) { setMsg({ ok: false, text: j.error ?? "Nu am putut schimba parola." }); return; }
      setCur(""); setPw(""); setPw2("");
      setMsg({ ok: true, text: `Parola a fost schimbată.${j.closed ? ` Am închis ${j.closed} ${j.closed === 1 ? "altă sesiune" : "alte sesiuni"} de pe celelalte dispozitive.` : ""}` });
      await load();
    } catch { setMsg({ ok: false, text: "Nu am putut contacta serverul." }); } finally { setBusy(null); }
  };
  const revoke = async (body: { action: string; id?: string }) => {
    setBusy(body.id ?? body.action); setMsg(null);
    try { const { ok, j } = await post(body); setMsg(ok ? { ok: true, text: j.closed ? `Sesiuni închise: ${j.closed}.` : "Nu era nimic de închis." } : { ok: false, text: j.error ?? "Nu am putut închide." }); await load(); }
    catch { setMsg({ ok: false, text: "Nu am putut contacta serverul." }); } finally { setBusy(null); }
  };
  const s = passwordStrength(pw);
  const others = sessions?.filter((x) => !x.current).length ?? 0;

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <section className="card" aria-label="Schimbă parola">
        <header className="card-h"><div><h3>Schimbă parola</h3><p>Cont: <b>{name}</b> · {email}. La schimbare, te deconectăm de pe toate celelalte dispozitive (aici rămâi autentificat).</p></div></header>
        <form onSubmit={(e) => void change(e)} className="usr-grid" style={{ maxWidth: 760 }}>
          <label className="field"><span>Parola veche</span><input className="input" type={show ? "text" : "password"} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} maxLength={200} required /></label>
          <label className="field"><span>Parola nouă (cel puțin 8 caractere)</span><input className="input" type={show ? "text" : "password"} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} maxLength={200} required aria-invalid={!!problem} /></label>
          <label className="field"><span>Repetă parola nouă</span><input className="input" type={show ? "text" : "password"} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} maxLength={200} required aria-invalid={mismatch} /></label>
          <div style={{ alignSelf: "end", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="chk"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Arată parolele</label>
            <button className="btn btn-primary" type="submit" disabled={!!busy || !cur || !pw || !!problem || pw !== pw2}>{busy === "pw" ? "Se salvează…" : "Schimbă parola"}</button>
          </div>
        </form>
        {pw && <div style={{ maxWidth: 360, marginTop: 8 }} aria-live="polite"><div style={{ display: "flex", gap: 4 }} aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= s ? (s <= 1 ? "var(--st-critical)" : s === 2 ? "var(--st-warning)" : "var(--st-good)") : "var(--border)" }} />)}</div><span className="cell-sub">{problem ?? `Parolă ${LABEL[s] || "slabă"}`}{mismatch ? " · parolele nu sunt la fel" : ""}</span></div>}
        {msg && <p className={msg.ok ? "cell-sub" : "form-error"} role={msg.ok ? "status" : "alert"} style={{ whiteSpace: "normal", marginTop: 8, color: msg.ok ? "var(--ok)" : undefined }}>{msg.text}</p>}
        <p className="cell-sub" style={{ whiteSpace: "normal", marginTop: 8 }}>Ai uitat parola veche? Ieși din cont și folosește «Ai uitat parola?» de pe pagina de autentificare: primești un link pe e-mail.</p>
      </section>

      <section className="card" aria-label="Sesiuni active">
        <header className="card-h"><div><h3>Sesiuni active</h3><p>Dispozitivele pe care ești autentificat acum. Dacă nu recunoști una, închide-o și schimbă parola.</p></div>
          {others > 0 && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => { if (window.confirm(`Închizi ${others} ${others === 1 ? "sesiune" : "sesiuni"} de pe celelalte dispozitive?`)) void revoke({ action: "revoke_others" }); }}>Închide toate celelalte ({others})</button>}</header>
        {err && <p className="form-error" role="alert">{err}</p>}
        {!sessions && !err && <div className="skeleton" style={{ height: 90 }} aria-busy="true" />}
        {sessions && (
          <div style={{ overflowX: "auto" }}><table className="mini"><thead><tr><th>Dispozitiv</th><th>Adresă IP</th><th>Autentificat la</th><th>Expiră</th><th /></tr></thead><tbody>
            {sessions.map((x) => (
              <tr key={x.id}>
                <td><b>{agent(x.ua)}</b>{x.current && <span className="badge ok" style={{ marginLeft: 6 }}>această sesiune</span>}</td>
                <td className="mono">{x.ip ?? "—"}</td><td>{dt(x.createdAt)}</td><td>{dt(x.expiresAt)}</td>
                <td style={{ textAlign: "right" }}>{!x.current && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void revoke({ action: "revoke", id: x.id })}>Închide</button>}</td>
              </tr>
            ))}
            {sessions.length === 0 && <tr><td colSpan={5} className="cell-sub" style={{ padding: 16 }}>Nicio sesiune.</td></tr>}
          </tbody></table></div>
        )}
      </section>

      <section className="card" aria-label="Activitatea contului">
        <header className="card-h"><div><h3>Activitatea recentă a contului</h3><p>Ultimele intrări, încercările eșuate cu adresa ta de e-mail și schimbările de parolă. Dacă vezi ceva ce nu ai făcut tu, schimbă parola.</p></div></header>
        {!activity && !err && <div className="skeleton" style={{ height: 90 }} aria-busy="true" />}
        {activity && (
          <div style={{ overflowX: "auto" }}><table className="mini"><thead><tr><th>Când</th><th>Ce</th><th>Adresă IP</th><th>Dispozitiv</th></tr></thead><tbody>
            {activity.map((a, i) => (
              <tr key={i}>
                <td>{dt(a.at)}</td>
                <td style={a.action === "auth.login_failed" ? { color: "var(--danger)" } : undefined}>{WHAT[a.action] ?? a.action}{!a.ok && a.action !== "auth.login_failed" ? " (eșuat)" : ""}</td>
                <td className="mono">{a.ip ?? "—"}</td><td className="cell-sub">{agent(a.ua)}</td>
              </tr>
            ))}
            {activity.length === 0 && <tr><td colSpan={4} className="cell-sub" style={{ padding: 16 }}>Nicio activitate înregistrată încă.</td></tr>}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}
