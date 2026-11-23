"use client";

import { useEffect, useState } from "react";
import type { CounterRow } from "@/lib/services/counters";
import type { IntegrationDevices, IntegrationStats } from "@/lib/services/integration";
import { ColumnChart, type Bar } from "./charts/primitives";
import KeptBrowser from "./KeptBrowser";

const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}:${p2(new Date(ms).getSeconds())}`;
const age = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? "< 1 s" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

const SAMPLE = `{
  "id": "00000000-0000-0000-0000-000000000000",
  "tb": { "name": "S2154_00000000_2024", "type": "Cahul_Gas_Meter_DP" },
  "attrs": { "devEUI": "0000000000000000", "active": true },
  "tel": {
    "Volume_m3_Total": { "t": ${Date.now() - 60_000}, "v": "4118.935" },
    "rssi": { "t": ${Date.now() - 60_000}, "v": "-111" },
    "temp": { "t": ${Date.now() - 60_000}, "v": "21" },
    "offline": { "t": ${Date.now() - 60_000}, "v": "false" },
    "ieType": { "t": ${Date.now() - 60_000}, "v": "LastEventSeq" }
  }
}`;

/**
 * Integrare: starea API-ului `POST /api/integration` (mesaje primite direct de la LoRaWAN / antene). Se actualizează la 2 secunde. „Verifică un mesaj” îl validează
 * și arată rezumatul derivat, FĂRĂ să-l salveze. Nu afișează tokenul și nici conținutul mesajelor primite.
 */
export default function IntegrationPanel() {
  const [s, setS] = useState<IntegrationStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [origin, setOrigin] = useState("https://<server>");
  const [text, setText] = useState(SAMPLE);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reMsg, setReMsg] = useState<string | null>(null);
  const [dev, setDev] = useState<IntegrationDevices | null>(null);
  const [cnt, setCnt] = useState<CounterRow[] | null>(null);
  const [help, setHelp] = useState(true);
  const [checkOpen, setCheckOpen] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => { try { if (localStorage.getItem("mg:intHelp") === "0") setHelp(false); if (localStorage.getItem("mg:intCheck") === "0") setCheckOpen(false); } catch { /* fără alegere reținută */ } }, 0);
    return () => clearTimeout(t);
  }, []);
  const toggleCheck = (open: boolean) => { setCheckOpen(open); try { localStorage.setItem("mg:intCheck", open ? "1" : "0"); } catch { /* alegerea nu se reține */ } };
  const toggleHelp = (open: boolean) => { setHelp(open); try { localStorage.setItem("mg:intHelp", open ? "1" : "0"); } catch { /* alegerea nu se reține */ } };

  useEffect(() => {
    const t0 = setTimeout(() => setOrigin(window.location.origin), 0);
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/integration/stats", { cache: "no-store" });
        if (r.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!r.ok) throw new Error("Nu am putut citi starea.");
        const j = (await r.json()) as IntegrationStats;
        if (alive) {
          setS(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    const loadDev = async () => {
      try {
        const r = await fetch("/api/integration/devices", { cache: "no-store" });
        if (r.ok && alive) setDev((await r.json()) as IntegrationDevices);
      } catch {
        /* lista se reîncearcă la următoarea citire */
      }
    };
    const loadCnt = async () => {
      try {
        const r = await fetch("/api/integration/counters", { cache: "no-store" });
        if (r.ok && alive) setCnt(((await r.json()) as { streams: CounterRow[] }).streams);
      } catch {
        /* se reîncearcă la următoarea citire */
      }
    };
    void load();
    void loadDev();
    void loadCnt();
    const tc = setInterval(() => document.visibilityState === "visible" && void loadCnt(), 3000);
    const td = setInterval(() => document.visibilityState === "visible" && void loadDev(), 10_000);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 2000);
    return () => {
      alive = false;
      clearTimeout(t0);
      clearInterval(t);
      clearInterval(td);
      clearInterval(tc);
    };
  }, []);

  const verify = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/integration/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
      const j = (await r.json()) as { ok: boolean; error?: string; id?: string; status?: string; summary?: unknown };
      setCheck(j.ok ? { ok: true, text: `Valid. Contor: ${j.id} · ${j.status === "created" ? "ar fi creat" : j.status === "unchanged" ? "fără schimbări" : "ar fi actualizat"}\n\nRezumat derivat:\n${JSON.stringify(j.summary, null, 2)}` } : { ok: false, text: j.error ?? "Mesaj invalid." });
    } catch {
      setCheck({ ok: false, text: "Nu am putut verifica mesajul." });
    } finally {
      setBusy(false);
    }
  };

  const reprocess = async () => {
    setReMsg("se reia…");
    try {
      const r = await fetch("/api/integration/reprocess", { method: "POST" });
      const j = (await r.json()) as { moved?: number; remaining?: number; error?: string };
      setReMsg(r.ok ? `${j.moved} aplicate acum, ${j.remaining} rămase păstrate` : j.error ?? "Nu am putut relua.");
      const d = await fetch("/api/integration/devices", { cache: "no-store" });
      if (d.ok) setDev((await d.json()) as IntegrationDevices);
    } catch {
      setReMsg("Nu am putut relua.");
    }
  };

  const bars: Bar[] = (s?.perSecond.rx ?? Array(60).fill(0)).map((v, i) => ({ label: `acum ${59 - i} s`, axis: i % 10 === 0 ? `−${59 - i} s` : "", value: v, ghost: 0 }));
  const lagBad = !!s && s.oldestAgeMs !== null && s.oldestAgeMs > 30_000;

  return (
    <div className="page" style={{ overflow: "auto" }}>
      {(!help || !checkOpen) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {!help && <span className={`badge ${s?.enabled ? "ok" : "danger"}`}>{s ? (s.enabled ? "integrare activă" : "dezactivată: lipsește INTEGRATION_TOKEN") : "se verifică…"}</span>}
          {!help && <button type="button" className="btn btn-sm" onClick={() => toggleHelp(true)}>Arată instrucțiunile de trimitere</button>}
          {!checkOpen && <button type="button" className="btn btn-sm" onClick={() => toggleCheck(true)}>Arată „Verifică un mesaj”</button>}
        </div>
      )}
      {help && (
      <section className="card" aria-label="Cum se trimite">
        <header className="card-h">
          <div>
            <h3>Integrare: mesaje direct de la LoRaWAN / antene</h3>
            <p>
              <span className={`badge ${s?.enabled ? "ok" : "danger"}`}>{s ? (s.enabled ? "activă" : "dezactivată: lipsește INTEGRATION_TOKEN") : "se verifică…"}</span>{" "}
              Un răspuns <b>200</b> înseamnă că datele sunt salvate <b>durabil</b>. Mesajele în formatul de contor se aplică în câteva secunde; <b>orice altceva se păstrează</b> pentru procesare ulterioară (nu dă eroare). Dacă primești altceva decât 200 (503, timeout), <b>reîncearcă</b>: reîncercarea nu strică nimic.
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => toggleHelp(false)} aria-label="Închide instrucțiunile de trimitere">Închide ×</button>
        </header>
        <pre className="json" style={{ maxHeight: 220 }}>{`curl -X POST ${origin}/api/integration \\
  -H "Authorization: Bearer <INTEGRATION_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '[ { "tb": { "name": "S2154_00186354_2024" }, "tel": { "Volume_m3_Total": { "t": 1795464061182, "v": "4118.935" } } } ]'

# se poate trimite orice (obiect, listă, text), cel mult 8 MB; corpul poate fi comprimat: Content-Encoding: gzip
# contorul se identifică prin "id" (UUID), "tb.name" sau "attrs.devEUI"
# răspuns: { "received": 1, "accepted": 1, "kept": 0 }  (accepted = se aplică pe contoare · kept = păstrat pentru procesare ulterioară)
# 401 token greșit (cu motivul)   ·   503 ocupat (Retry-After): reîncearcă`}</pre>
      </section>
      )}

      <section className="stats auto" aria-label="Stare" aria-live="polite">
        <div className="stat"><div className="k">Primite / secundă</div><div className="v">{s ? nf.format(s.rateRx10) : "—"}</div><div className="s">media ultimelor 10 s</div></div>
        <div className="stat"><div className="k">Salvate / secundă</div><div className="v">{s ? nf.format(s.rateOk10) : "—"}</div><div className="s">media ultimelor 10 s</div></div>
        <div className={`stat ${s && s.depth > 1000 ? "alert" : ""}`}><div className="k">În cutia de intrare</div><div className="v">{s ? nf.format(s.depth) : "—"}</div><div className="s">{s ? `cel mai vechi: ${age(s.oldestAgeMs)} · limita ${nf.format(s.maxInbox)}` : " "}</div></div>
        <div className="stat"><div className="k">Ultimul pachet aplicat</div><div className="v">{s?.lastBatch ? `${nf.format(s.lastBatch.n)}` : "—"}</div><div className="s">{s?.lastBatch ? `${s.lastBatch.ms} ms · ${clock(s.lastBatch.at)}` : "încă niciunul"}</div></div>
        <div className="stat"><div className="k">Durată pachet (p50 / p95)</div><div className="v" style={{ fontSize: 18 }}>{s?.batchP50 != null ? `${s.batchP50} / ${s.batchP95} ms` : "—"}</div><div className="s">ultimele 100 de pachete</div></div>
        <div className={`stat ${s && s.keptCount > 0 ? "alert" : ""}`}><div className="k">Păstrate pentru procesare ulterioară</div><div className="v">{s ? nf.format(s.keptCount) : "—"}</div><div className="s"><button type="button" className="btn btn-sm" onClick={reprocess}>Reia acum</button> {reMsg ?? "alt format / contor necunoscut"}</div></div>
        <div className={`stat ${s && s.deadCount > 0 ? "alert" : ""}`}><div className="k">Respinse la aplicare</div><div className="v">{s ? nf.format(s.deadCount) : "—"}</div><div className="s">în „integration_dead” (30 de zile)</div></div>
      </section>

      {lagBad && <p className="form-error" role="alert">Mesajele așteaptă de {age(s?.oldestAgeMs ?? null)}: aplicarea nu ține pasul sau baza de date e lentă. Nu se pierde nimic, dar contoarele se actualizează cu întârziere.</p>}
      {s?.lastError && <p className="form-error" role="alert">Eroare la aplicare (se reîncearcă singură, mesajele rămân în cutie): {s.lastError}</p>}
      {err && <p className="form-error" role="alert">{err}</p>}

      <div className="grid">
        <section className="card span2" aria-label="Ritm">
          <header className="card-h"><div><h3>Mesaje primite pe secundă</h3><p>ultimele 60 de secunde (de la acest proces)</p></div></header>
          <ColumnChart unit="mesaje" bars={bars} ariaLabel="Mesaje primite pe secundă în ultimul minut" height={140} labelWidth={44} />
          <p className="cell-sub" style={{ margin: "6px 0 0", whiteSpace: "normal" }}>
            De la pornirea procesului: {s ? `${nf.format(s.totals.received)} primite · ${nf.format(s.totals.kept)} păstrate pentru procesare ulterioară · ${nf.format(s.totals.processed)} aplicate (${nf.format(s.totals.created)} contoare noi, ${nf.format(s.totals.updated)} actualizate, ${nf.format(s.totals.unchanged)} fără schimbări) · ${nf.format(s.totals.busy)} refuzate din cauza cutiei pline` : "—"}.
          </p>
        </section>

        {checkOpen && (
        <section className="card" aria-label="Verifică un mesaj">
          <header className="card-h"><div><h3>Verifică un mesaj</h3><p>îl validează și arată rezumatul; <b>nu</b> îl salvează</p></div><button type="button" className="btn btn-sm" onClick={() => toggleCheck(false)} aria-label="Închide verificarea unui mesaj">Închide ×</button></header>
          <textarea className="input mono" style={{ width: "100%", height: 200, padding: 10, fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Mesaj JSON" />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-primary" onClick={verify} disabled={busy}>Verifică</button>
            <button type="button" className="btn" onClick={() => { setText(SAMPLE); setCheck(null); }}>Exemplu</button>
          </div>
          {check && <pre className={check.ok ? "json" : "form-error"} style={{ marginTop: 8, maxHeight: 260, whiteSpace: "pre-wrap" }}>{check.text}</pre>}
        </section>
        )}
      </div>

      <section className="card" aria-label="Verificare continuitate" style={{ marginBottom: 14 }}>
        <header className="card-h">
          <div>
            <h3>Verificare continuitate: se pierde vreun mesaj?</h3>
            <p>
              Expeditorul pune un număr crescător pe fiecare mesaj, în câmpul <span className="mono">counter</span> (sau <span className="mono">cnt</span>, <span className="mono">seq</span>) de la rădăcina mesajului;
              dacă sunt mai mulți expeditori, în plus <span className="mono">stream</span> cu numele lui. Numărăm la primire: un salt înseamnă numere care nu au ajuns la noi.
            </p>
          </div>
          <button type="button" className="btn" disabled={!cnt || cnt.length === 0} onClick={async () => { if (window.confirm("Ștergi numerele urmărite și începi un test nou?")) { await fetch("/api/integration/counters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: "all" }) }); setCnt([]); } }}>Test nou</button>
        </header>
        {cnt === null ? (
          <p className="cell-sub" style={{ padding: 12 }}>se încarcă…</p>
        ) : cnt.length === 0 ? (
          <p className="cell-sub" style={{ padding: 12 }}>Încă nu a venit niciun mesaj cu număr (counter). Când vine, apare aici.</p>
        ) : (
          cnt.map((c) => (
            <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", alignItems: "baseline" }}>
                <strong>{c.id === "implicit" ? "Expeditor" : c.id}</strong>
                <span className="cell-sub">câmp <span className="mono">{c.field}</span> · de la {nf.format(c.first)} la {nf.format(c.last)} · ultimul mesaj {clock(c.lastAt)}</span>
                <span className={c.lost === 0 ? "badge ok" : "badge warn"}>{c.lost === 0 ? "nu lipsește nimic" : `lipsesc ${nf.format(c.lost)}`}</span>
              </div>
              <div className="gw-stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                <div><b>{nf.format(c.expected)}</b><span>numere trebuiau să vină</span></div>
                <div><b>{nf.format(c.received)}</b><span>au venit</span></div>
                <div><b style={{ color: c.lost ? "#d03b3b" : undefined }}>{nf.format(c.lost)}</b><span>lipsesc acum</span></div>
                <div><b>{nf.format(c.late)}</b><span>au venit târziu (altă ordine)</span></div>
                <div><b>{nf.format(c.dup)}</b><span>duplicate (reîncercări)</span></div>
              </div>
              {c.gaps.length > 0 && (
                <div className="card-table" style={{ maxHeight: 200 }}>
                  <table className="mini">
                    <thead><tr><th>Lipsesc numerele</th><th className="num">A sărit peste</th><th>Observat la</th></tr></thead>
                    <tbody>
                      {c.gaps.map((g, k) => (
                        <tr key={k}><td className="mono">{g.from === g.to ? nf.format(g.from) : `${nf.format(g.from)} – ${nf.format(g.to)}`}</td><td className="num mono">{nf.format(g.size)}</td><td className="mono">{clock(g.at)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {c.hiddenGaps > 0 && <p className="cell-sub">Mai sunt goluri mai vechi, necuprinse în listă (totalul „lipsesc acum” le include).</p>}
            </div>
          ))
        )}
      </section>

      <div className="grid">
        <section className="card" aria-label="Contoare care trimit">
          <header className="card-h">
            <div>
              <h3>De la care contoare vin datele</h3>
              <p>{dev ? `${nf.format(dev.seenTotal)} contoare au trimis prin integrare (cele mai recente ${dev.seen.length})` : "se încarcă…"}</p>
            </div>
          </header>
          <div className="card-table" style={{ maxHeight: 360 }}>
            <table className="mini">
              <thead><tr><th>Contor</th><th>Filială</th><th className="num">Mesaje</th><th>Ultimul mesaj</th></tr></thead>
              <tbody>
                {dev?.seen.map((m) => (
                  <tr key={m.id}><td className="mono">{m.name || m.id}</td><td>{m.branch ?? "—"}</td><td className="num mono">{nf.format(m.n)}</td><td className="mono">{m.last ? `${p2(new Date(m.last).getDate())}.${p2(new Date(m.last).getMonth() + 1)} ${clock(m.last)}` : "—"}</td></tr>
                ))}
                {dev && dev.seen.length === 0 && <tr><td colSpan={4} className="cell-sub" style={{ padding: 16 }}>Niciun contor nu a trimis încă date aplicate pe contoare.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-label="Date păstrate">
          <header className="card-h">
            <div>
              <h3>Păstrate pentru procesare ulterioară, pe dispozitiv</h3>
              <p>{dev ? `${nf.format(dev.keptMessages)} mesaje de la ${nf.format(dev.keptDevices)} dispozitive; ${nf.format(dev.keptMatched)} se potrivesc cu un contor și se aplică singure (se reiau automat în cel mult un minut)` : "se încarcă…"}</p>
            </div>
          </header>
          <div className="card-table" style={{ maxHeight: 360 }}>
            <table className="mini">
              <thead><tr><th>Dispozitiv</th><th>Aplicație</th><th className="num">Mesaje</th><th>Se potrivește cu</th></tr></thead>
              <tbody>
                {dev?.kept.map((k) => (
                  <tr key={k.key}>
                    <td className="mono" title={k.key}>{k.deviceName || k.key}</td>
                    <td>{k.app || "—"}</td>
                    <td className="num mono">{nf.format(k.n)}</td>
                    <td>{k.meter ? <><span className="mono">{k.meter}</span> <span className="cell-sub">{k.branch ?? ""}</span></> : <span className="badge warn">contor necunoscut</span>}</td>
                  </tr>
                ))}
                {dev && dev.kept.length === 0 && <tr><td colSpan={4} className="cell-sub" style={{ padding: 16 }}>Nimic păstrat de acest fel.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <KeptBrowser />

      <section className="tablebox" aria-label="Ultimele mesaje" style={{ minHeight: 160, flex: "none" }}>
        <div className="vp" style={{ maxHeight: 320 }}>
          <table className="mini">
            <thead><tr><th>Ora</th><th>Contor</th><th>Stare</th></tr></thead>
            <tbody>
              {s?.events.map((e, i) => (
                <tr key={`${e.at}-${e.id}-${i}`}><td className="mono">{clock(e.at)}</td><td>{e.name || e.id}</td><td><span className={`badge ${e.status === "primit" ? "" : e.status === "nou" ? "ok" : "warn"}`}>{e.status}</span></td></tr>
              ))}
              {s && s.events.length === 0 && <tr><td colSpan={3} className="cell-sub" style={{ padding: 16 }}>Niciun mesaj primit de la pornirea procesului.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
