"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MODE_LABEL, type ReportMode, type ReportRow } from "@/lib/report-readings";

/**
 * Raportul de citiri către facturare (Oracle): alegi perioada (luna aceasta, luna trecută sau un interval), ce citiri intră (toate / una pe zi / doar ultima) și
 * generezi un fișier CSV pe locul comun al serverului (REPORT_OUT_DIR), de unde îl preia facturarea. Fiecare rând = un contor, indicația (m³) și momentul citirii.
 * În fiecare lună, pe 1 la 07:00, serverul generează singur raportul lunii precedente (scripts/monthly-report.ts).
 */
type Period = "this" | "prev" | "custom";
type Preview = { totalMeters: number; scanned: number; meters: number; rows: number; sample: string[]; header: string; from: number; to: number };
const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const day = (ms: number) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`; };
const dt = (ms: number | null) => { if (!ms) return "—"; const d = new Date(ms); return `${day(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);
const period = (r: ReportRow) => `${day(r.from)} – ${day(Math.max(r.from, r.to - 1))}`;

export default function ReportsPanel() {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [dir, setDir] = useState("");
  const [per, setPer] = useState<Period>("prev");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<ReportMode>("all");
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
    const t0 = setTimeout(() => void load(), 0);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 3000);
    return () => { alive.current = false; clearTimeout(t0); clearInterval(t); };
  }, [load]);

  const body = (action: "preview" | "start") => JSON.stringify({ action, period: per, from, to, mode, onlyBilled: billed });
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
    if (!window.confirm(`Ștergi raportul ${period(r)} (înregistrarea și fișierul de pe server)?`)) return;
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
            <p>Un fișier CSV cu, pentru fiecare contor, indicația (volumul total în m³) și momentul fiecărei citiri. Se scrie pe serverul aplicației, de unde îl preia facturarea.</p>
          </div>
        </header>
        <div className="toolbar-row2" role="group" aria-label="Opțiuni raport" style={{ marginBottom: 10 }}>
          <div className="field">
            <span id="rp-per">Perioadă</span>
            <div className="seg" role="group" aria-labelledby="rp-per">
              <button type="button" aria-pressed={per === "this"} onClick={() => { setPer("this"); setPv(null); }}>Luna aceasta</button>
              <button type="button" aria-pressed={per === "prev"} onClick={() => { setPer("prev"); setPv(null); }}>Luna trecută</button>
              <button type="button" aria-pressed={per === "custom"} onClick={() => { setPer("custom"); setPv(null); }}>Interval</button>
            </div>
          </div>
          {per === "custom" && (
            <>
              <label className="field"><span>De la (inclusiv)</span><input className="input" type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPv(null); }} /></label>
              <label className="field"><span>Până la (inclusiv)</span><input className="input" type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPv(null); }} /></label>
            </>
          )}
          <label className="field"><span>Ce citiri intră</span>
            <select className="select" value={mode} onChange={(e) => { setMode(e.target.value as ReportMode); setPv(null); }}>
              {(Object.keys(MODE_LABEL) as ReportMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </label>
          <label className="chk" style={{ alignSelf: "center" }}>
            <input type="checkbox" checked={billed} onChange={(e) => { setBilled(e.target.checked); setPv(null); }} /> Doar contoare legate de facturare
          </label>
          <button type="button" className="btn" onClick={() => void call("preview")} disabled={busy}>Previzualizează</button>
          <button type="button" className="btn btn-primary" onClick={() => void call("start")} disabled={busy || running} title={running ? "Un raport se generează deja" : "Generează fișierul pe server"}>Generează fișierul</button>
        </div>
        {msg && <p className={msg.ok ? "cell-sub" : "form-error"} role={msg.ok ? "status" : "alert"} style={{ whiteSpace: "normal" }}>{msg.text}</p>}

        {pv && (
          <div>
            <p className="cell-sub" style={{ whiteSpace: "normal", margin: "6px 0" }}>
              Perioada {day(pv.from)} – {day(Math.max(pv.from, pv.to - 1))}. Din primele {nf.format(pv.scanned)} de contoare (din {nf.format(pv.totalMeters)} în raport), {nf.format(pv.meters)} au citiri în perioadă, cu {nf.format(pv.rows)} de rânduri;
              raportul întreg ar avea ≈ <b>{nf.format(estimate)}</b> de rânduri.
            </p>
            {pv.sample.length > 0 ? (
              <div className="card-table" style={{ maxHeight: 280 }}>
                <table className="mini">
                  <thead><tr>{pv.header.split(";").map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{pv.sample.map((l, i) => <tr key={i}>{l.split(";").map((c, k) => <td key={k} className="mono">{c}</td>)}</tr>)}</tbody>
                </table>
              </div>
            ) : <p className="cell-sub">Niciun rând în primele contoare pentru această perioadă.</p>}
          </div>
        )}
      </section>

      <section className="card" aria-label="Programare automată">
        <header className="card-h"><div><h3>Generare automată lunară</h3></div></header>
        <p className="cell-sub" style={{ whiteSpace: "normal", margin: 0 }}>
          În fiecare lună, pe <b>1, la 07:00</b> (ora serverului), se generează singur raportul lunii precedente (toate citirile, doar contoare legate de facturare) și se scrie, ca fișier CSV împreună cu suma de control (<span className="mono">.sha256</span>), în{" "}
          <span className="mono">{dir || "…"}</span>. Fișierul apare în director doar când e complet. Locul se schimbă pe server cu <span className="mono">REPORT_OUT_DIR</span> (director local sau montat din rețea).
          {lastAuto ? <> Ultima rulare automată: <b>{period(lastAuto)}</b> — {lastAuto.status === "done" ? `gata, ${nf.format(lastAuto.rows)} rânduri` : lastAuto.status === "running" ? "se generează" : `eroare: ${lastAuto.error ?? "necunoscută"}`} ({dt(lastAuto.createdAt)}).</> : " Încă nu a rulat nicio dată."}
        </p>
      </section>

      <section className="card" aria-label="Rapoarte generate">
        <header className="card-h"><div><h3>Rapoarte generate</h3><p>cele mai recente 60</p></div></header>
        <div className="card-table" style={{ maxHeight: 520 }}>
          <table className="mini">
            <thead><tr><th>Perioadă</th><th>Tip</th><th>Citiri</th><th className="num">Contoare</th><th className="num">Rânduri</th><th className="num">Mărime</th><th>Stare</th><th>Generat</th><th>Fișier</th></tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td><b>{period(r)}</b></td>
                  <td>{r.kind === "scheduled" ? "automat" : "manual"}<div className="cell-sub">{r.by}</div></td>
                  <td>{MODE_LABEL[r.mode]}<div className="cell-sub">{r.onlyBilled ? "doar cu facturare" : "toate contoarele"}</div></td>
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
