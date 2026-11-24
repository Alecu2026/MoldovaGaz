"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportRow } from "@/lib/report-readings";

/**
 * Raportul de citiri către facturare (Oracle): alegi data și ora (ex. 01/12/2026 07:00) și generezi un fișier CSV pe locul comun al serverului (REPORT_OUT_DIR), de unde îl
 * preia facturarea. Un rând pe contor, cu ultima citire până la momentul ales și doar trei câmpuri: seria radiomodulului, indicația (m³) și data reală a citirii.
 * În fiecare lună, pe 1 la 07:00, serverul generează singur raportul pentru acel moment (scripts/monthly-report.ts).
 */
type Preview = { totalMeters: number; scanned: number; meters: number; rows: number; sample: string[]; header: string; at: number };
const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const day = (ms: number) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`; };
const dt = (ms: number | null) => { if (!ms) return "—"; const d = new Date(ms); return `${day(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);
const atText = (ms: number) => { const d = new Date(ms); return `${day(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
/** „acum”, în ora Moldovei, ca „AAAA-LL-ZZTHH:MM” (valoarea unui câmp datetime-local) */
const nowLocal = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Chisinau" }).slice(0, 16).replace(" ", "T");

export default function ReportsPanel() {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [dir, setDir] = useState("");
  const [at, setAt] = useState("");
  const [billed, setBilled] = useState(true);
  const [pv, setPv] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/reports", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      if (!r.ok) return;
      const j = (await r.json()) as { reports: ReportRow[]; dir: string };
      if (alive.current) { setRows(j.reports); setDir(j.dir); }
    } catch { /* se reîncearcă la următoarea citire */ }
  }, []);
  useEffect(() => {
    alive.current = true;
    const t0 = setTimeout(() => { setAt((v) => v || nowLocal()); void load(); }, 0);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 3000);
    return () => { alive.current = false; clearTimeout(t0); clearInterval(t); };
  }, [load]);

  const body = (action: "preview" | "start") => JSON.stringify({ action, at, onlyBilled: billed });
  const call = async (action: "preview" | "start") => {
    setBusy(true);
    setMsg(null);
    if (action === "preview") setPv(null);
    try {
      const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: body(action) });
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) { setMsg({ ok: false, text: String(j.error ?? "Eroare.") }); return; }
      if (action === "preview") setPv(j as unknown as Preview);
      else { setMsg({ ok: true, text: "Raportul se generează în fundal; progresul apare mai jos." }); void load(); }
    } catch {
      setMsg({ ok: false, text: "Nu am putut contacta serverul." });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: ReportRow) => {
    if (!window.confirm(`Ștergi raportul din ${atText(r.at)} (înregistrarea și fișierul de pe server)?`)) return;
    const res = await fetch(`/api/reports/${r.id}`, { method: "DELETE" });
    if (!res.ok) setMsg({ ok: false, text: "Nu am putut șterge raportul." });
    void load();
  };
  const running = rows?.some((r) => r.status === "running") ?? false;
  const lastAuto = rows?.find((r) => r.kind === "scheduled");
  const estimate = pv && pv.scanned > 0 ? Math.round((pv.rows * pv.totalMeters) / pv.scanned) : 0;

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <section className="card" aria-label="Generează raport">
        <header className="card-h">
          <div>
            <h3>Raport de citiri către facturare (Oracle)</h3>
            <p>Un fișier CSV cu, pentru fiecare contor, <b>ultima citire până la data și ora aleasă</b>, doar cu trei câmpuri: seria radiomodulului, indicația (volumul total în m³) și data reală a citirii. Se scrie pe serverul aplicației, de unde îl preia facturarea.</p>
          </div>
        </header>
        <div className="toolbar-row2" role="group" aria-label="Opțiuni raport" style={{ marginBottom: 10 }}>
          <label className="field"><span>Citirea la data și ora (ora Moldovei)</span>
            <input className="input" type="datetime-local" value={at} onChange={(e) => { setAt(e.target.value); setPv(null); }} aria-label="Data și ora raportului" />
          </label>
          <button type="button" className="btn" onClick={() => { setAt(nowLocal()); setPv(null); }}>Acum</button>
          <label className="chk" style={{ alignSelf: "center" }}>
            <input type="checkbox" checked={billed} onChange={(e) => { setBilled(e.target.checked); setPv(null); }} /> Doar contoare legate de facturare
          </label>
          <button type="button" className="btn" onClick={() => void call("preview")} disabled={busy}>Previzualizează</button>
          <button type="button" className="btn btn-primary" onClick={() => void call("start")} disabled={busy || running || !at} title={running ? "Un raport se generează deja" : "Generează fișierul pe server"}>Generează fișierul</button>
        </div>
        {msg && <p className={msg.ok ? "cell-sub" : "form-error"} role={msg.ok ? "status" : "alert"} style={{ whiteSpace: "normal" }}>{msg.text}</p>}

        {pv && (
          <div>
            <p className="cell-sub" style={{ whiteSpace: "normal", margin: "6px 0" }}>
              Citirea la {atText(pv.at)}. Din primele {nf.format(pv.scanned)} de contoare (din {nf.format(pv.totalMeters)} în raport), {nf.format(pv.meters)} au o citire până atunci;
              raportul întreg ar avea ≈ <b>{nf.format(estimate)}</b> de rânduri (câte unul pe contor).
            </p>
            {pv.sample.length > 0 ? (
              <div className="card-table" style={{ maxHeight: 280 }}>
                <table className="mini">
                  <thead><tr>{pv.header.split(";").map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{pv.sample.map((l, i) => <tr key={i}>{l.split(";").map((c, k) => <td key={k} className="mono">{c}</td>)}</tr>)}</tbody>
                </table>
              </div>
            ) : <p className="cell-sub">Niciun rând în primele contoare pentru acest moment.</p>}
          </div>
        )}
      </section>

      <section className="card" aria-label="Programare automată">
        <header className="card-h"><div><h3>Generare automată lunară</h3></div></header>
        <p className="cell-sub" style={{ whiteSpace: "normal", margin: 0 }}>
          În fiecare lună, pe <b>1, la 07:00</b> (ora serverului), se generează singur raportul cu ultima citire a fiecărui contor până la acel moment (doar contoare legate de facturare, trei câmpuri) și se scrie, ca fișier CSV împreună cu suma de control (<span className="mono">.sha256</span>), în{" "}
          <span className="mono">{dir || "…"}</span>. Fișierul apare în director doar când e complet. Locul se schimbă pe server cu <span className="mono">REPORT_OUT_DIR</span> (director local sau montat din rețea).
          {lastAuto ? <> Ultima rulare automată: <b>{atText(lastAuto.at)}</b> — {lastAuto.status === "done" ? `gata, ${nf.format(lastAuto.rows)} rânduri` : lastAuto.status === "running" ? "se generează" : `eroare: ${lastAuto.error ?? "necunoscută"}`} ({dt(lastAuto.createdAt)}).</> : " Încă nu a rulat nicio dată."}
        </p>
      </section>

      <section className="card" aria-label="Rapoarte generate">
        <header className="card-h"><div><h3>Rapoarte generate</h3><p>cele mai recente 60</p></div></header>
        <div className="card-table" style={{ maxHeight: 520 }}>
          <table className="mini">
            <thead><tr><th>Citirea la</th><th>Tip</th><th>Contoare incluse</th><th className="num">Contoare</th><th className="num">Rânduri</th><th className="num">Mărime</th><th>Stare</th><th>Generat</th><th>Fișier</th></tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td><b>{atText(r.at)}</b></td>
                  <td>{r.kind === "scheduled" ? "automat" : "manual"}<div className="cell-sub">{r.by}</div></td>
                  <td>{r.onlyBilled ? "doar cu facturare" : "toate contoarele"}</td>
                  <td className="num mono">{nf.format(r.meters)}</td>
                  <td className="num mono">{nf.format(r.rows)}</td>
                  <td className="num mono">{size(r.bytes)}</td>
                  <td>
                    {r.status === "running" && <span className="badge warn">se generează {r.total > 0 ? `${Math.min(99, Math.round((r.scanned / r.total) * 100))}%` : ""}</span>}
                    {r.status === "done" && <span className="badge ok">gata</span>}
                    {r.status === "error" && <span className="badge danger" title={r.error ?? ""}>eroare</span>}
                    {r.status === "error" && r.error && <div className="cell-sub" style={{ whiteSpace: "normal" }}>{r.error}</div>}
                  </td>
                  <td className="mono">{dt(r.createdAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.status === "done" && r.file && <a className="btn btn-sm" href={`/api/reports/${r.id}`} download>Descarcă</a>}{" "}
                    {r.status !== "running" && <button type="button" className="btn btn-sm" onClick={() => void remove(r)}>Șterge</button>}
                    {r.sha256 && <div className="cell-sub mono" title={r.sha256}>sha256 {r.sha256.slice(0, 10)}…</div>}
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 && <tr><td colSpan={9} className="cell-sub" style={{ padding: 16 }}>Niciun raport încă.</td></tr>}
              {!rows && <tr><td colSpan={9} className="cell-sub" style={{ padding: 16 }}>se încarcă…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
