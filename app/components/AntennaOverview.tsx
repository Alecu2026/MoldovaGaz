"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LINK_LABEL, fdtA, ours, type AntennaRecord, type GasLink, type OverviewRow } from "@/lib/antennas";
import type { GwDetail } from "@/lib/services/gateways";
import { ColumnChart, type Bar } from "./charts/primitives";
import MapCard, { IcoTower, type CardMode } from "./MapCard";
import GwFilterBar, { useGwFilter } from "./GwFilterBar";
import DistanceChart from "./DistanceChart";
import { periodText, queryString, radiusActive, periodActive, type GwQuery } from "@/lib/gw-filter";

const AntennasMap = dynamic(() => import("./AntennasMap"), { ssr: false, loading: () => <div className="skeleton" style={{ height: 520, borderRadius: 12 }} /> });

/**
 * «Antene: date și hartă» — pagină separată: sus tabelul cu datele fiecărei antene (stare, legătura cu contoarele noastre de gaz, contoare auzite, semnal, client,
 * instalator, locație), apoi fișa antenei alese (atribute, mesaje pe zi, contoarele auzite), iar HARTA e dedesubt. Implicit se arată doar antenele care au legătură
 * cu contoarele noastre de gaz (acum sau în ultima lună); restul (demult / niciodată) se aleg din filtru.
 */
type Overview = { rows: OverviewRow[]; now: number };
type More = { record: AntennaRecord | null; detail: GwDetail | null; days: { d: number; n: number }[] };
type Rel = "ours" | "all" | "older" | "never" | "unknown";
const REL: [Rel, string][] = [["ours", "Cu contoarele noastre de gaz"], ["all", "Toate antenele"], ["older", "Gaz demult (peste 30 de zile)"], ["never", "Niciodată gaz"], ["unknown", "Necunoscut"]];
const STATE_LABEL = { on: "activă", slow: "lentă", off: "oprită" } as const;
const STATE_COLOR = { on: "rgb(39, 134, 34)", slow: "rgb(230, 160, 0)", off: "rgb(255, 0, 0)" } as const;
const nf = new Intl.NumberFormat("ro-RO");
const r1 = (v: number | null) => (v === null ? "—" : v.toFixed(1).replace(".", ","));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).split("-").reverse().join(".");
const hasPos = (r: OverviewRow) => r.latitude !== null && r.longitude !== null && !(r.latitude === 0 && r.longitude === 0);
const linkClass = (l: GasLink) => (l === "recent" ? "ok" : l === "month" ? "" : l === "older" ? "warn" : "");
type Col = { key: string; label: string; num?: boolean };
const COLS: Col[] = [
  { key: "name", label: "Antena" }, { key: "state", label: "Stare" }, { key: "link", label: "Contoare de gaz" }, { key: "devices", label: "Contoare auzite", num: true },
  { key: "signal", label: "Semnal (RSSI / SNR)", num: true }, { key: "msgs", label: "Mesaje la noi", num: true }, { key: "client", label: "Client / instalator" }, { key: "pos", label: "Locație" },
];
const LINK_ORDER: Record<GasLink, number> = { recent: 0, month: 1, older: 2, never: 3, unknown: 4 };
const STATE_ORDER = { on: 0, slow: 1, off: 2 } as const;
const sortVal = (r: OverviewRow, k: string): string | number => {
  switch (k) {
    case "name": return (r.name || r.id).toLowerCase();
    case "state": return STATE_ORDER[r.state] * 1e14 - (r.last ?? 0);
    case "link": return LINK_ORDER[r.link] * 1e14 - (r.gasAt ?? 0);
    case "devices": return r.devices; case "signal": return r.rssi ?? -999; case "msgs": return r.msgs;
    case "client": return (r.Client || r.NumeInstalator).toLowerCase(); case "pos": return hasPos(r) ? 1 : 0;
    default: return r.id;
  }
};

export default function AntennaOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [rel, setRel] = useState<Rel>("ours");
  const [state, setState] = useState<"all" | "on" | "slow" | "off">("all");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "link", dir: 1 });
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  /** filtrul rază + perioadă (același ca pe harta de contoare); `counts` = câte contoare din filtru are fiecare antenă */
  const gf = useGwFilter();
  const qs = queryString(gf.q);
  const [matchRaw, setMatchRaw] = useState<{ key: string; v: Map<string, number> } | null>(null);
  const [more, setMore] = useState<{ id: string; v: More | null; err: string | null } | null>(null);
  /** fișa antenei de pe hartă strânsă / deschisă (nu deselectează antena) */
  const [cardMode, setCardMode] = useState<CardMode>("open");
  /** harta urmărește antena aleasă din tabel; la click pe hartă NU se mută (nici zoom) */
  const [follow, setFollow] = useState(true);
  const [full, setFull] = useState(false);
  const [pseudo, setPseudo] = useState(false);
  const wrapRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement !== null && document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!pseudo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPseudo(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pseudo]);
  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (full || pseudo) { setPseudo(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); return; }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setPseudo(true)); else setPseudo(true);
  };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/antennas/overview", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as Overview); setErr(null);
    } catch { setErr((c) => c ?? "Nu am putut citi antenele."); }
  }, []);
  useEffect(() => {
    const t0 = setTimeout(() => void load(), 0);
    const iv = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [load]);

  useEffect(() => {
    if (!gf.on) return;
    const ac = new AbortController();
    void fetch(`/api/integration/gateways?match=1&${qs}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); const d = (await r.json()) as { counts: Record<string, number> }; setMatchRaw({ key: qs, v: new Map(Object.entries(d.counts).map(([k, n]) => [k.toLowerCase(), n])) }); })
      .catch(() => undefined);
    return () => ac.abort();
  }, [gf.on, qs]);
  const match = gf.on && matchRaw && matchRaw.key === qs ? matchRaw.v : null;

  useEffect(() => {
    if (!sel) return;
    const ac = new AbortController();
    void fetch(`/api/antennas/overview?id=${encodeURIComponent(sel)}${qs ? `&${qs}` : ""}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setMore({ id: sel, v: (await r.json()) as More, err: null }); })
      .catch((e: Error) => { if (e.name !== "AbortError") setMore({ id: sel, v: null, err: "Nu am putut citi detaliile antenei." }); });
    return () => ac.abort();
  }, [sel, qs]);

  const all = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(() => {
    const c = { total: all.length, ours: 0, older: 0, never: 0, unknown: 0, on: 0, slow: 0, off: 0, noPos: 0 };
    for (const r of all) {
      if (ours(r.link)) c.ours++; else c[r.link === "older" ? "older" : r.link === "never" ? "never" : "unknown"]++;
      c[r.state]++;
      if (!hasPos(r)) c.noPos++;
    }
    return c;
  }, [all]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = all.filter((r) => {
      if (rel === "ours" ? !ours(r.link) : rel !== "all" && r.link !== rel) return false;
      if (state !== "all" && r.state !== state) return false;
      if (match && !match.has(r.id.toLowerCase())) return false;
      return !needle || `${r.id} ${r.name} ${r.Client} ${r.NumeInstalator} ${r.Comments} ${r.NrTel_SIM} ${r.ip_address}`.toLowerCase().includes(needle);
    });
    out.sort((a, b) => { const x = sortVal(a, sort.key), y = sortVal(b, sort.key); const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ro", { numeric: true }); return (c || a.id.localeCompare(b.id)) * sort.dir; });
    return out;
  }, [all, q, rel, state, sort, match]);
  const lastPage = size ? Math.max(0, Math.ceil(shown.length / size) - 1) : 0;
  const pg = Math.min(page, lastPage);
  const rows = size ? shown.slice(pg * size, (pg + 1) * size) : shown;
  const from = shown.length === 0 ? 0 : size ? pg * size + 1 : 1, to = size ? Math.min(shown.length, (pg + 1) * size) : shown.length;
  const cur = sel ? all.find((r) => r.id === sel) ?? null : null;
  const m = more && more.id === sel ? more : null;
  const sortBy = (k: string) => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const pick = (id: string) => { setFollow(true); setSel(id); setMore(null); };
  const pickMap = (id: string) => { setFollow(false); setSel(id); setMore(null); };
  // ultimele 60 de zile COMPLETE (zilele fără mesaje = 0, nu lipsesc), ziua = ziua UTC ca în rest
  // cu perioada aleasă în filtru (azi / 7 zile / mai vechi de 7 zile) rămân doar zilele ei; raza nu se aplică, fiindcă mesajele pe zi nu se rețin pe contor
  const daysFull = useMemo(() => {
    const days = m?.v?.days;
    if (!days) return null;
    const by = new Map(days.map((x) => [x.d, x.n]));
    const today = Math.floor((data?.now ?? days[days.length - 1]?.d ?? 0) / 86_400_000) * 86_400_000;
    const out: { d: number; n: number }[] = [];
    for (let i = 59; i >= 0; i--) { const d = today - i * 86_400_000; out.push({ d, n: by.get(d) ?? 0 }); }
    return out;
  }, [m, data]);
  const series = useMemo(() => (daysFull ? daysFull.filter((x) => (gf.q.pf === null || x.d + 86_400_000 > gf.q.pf) && (gf.q.pt === null || x.d <= gf.q.pt)) : null), [daysFull, gf.q]);
  const stat = useMemo(() => {
    if (!series || !daysFull || series.length === 0) return null;
    const total = series.reduce((a, b) => a + b.n, 0), active = series.filter((x) => x.n > 0);
    const peak = series.reduce((a, b) => (b.n > a.n ? b : a), series[0]);
    return { total, days: series.length, activeDays: active.length, avg: active.length ? Math.round(total / active.length) : 0, peak, yesterday: daysFull[daysFull.length - 2]?.n ?? 0, today: daysFull[daysFull.length - 1]?.n ?? 0, lastDay: [...series].reverse().find((x) => x.n > 0)?.d ?? null };
  }, [series, daysFull]);
  const bars: Bar[] = useMemo(() => (series ?? []).map((x, i, a) => ({ label: day(x.d), axis: i % 10 === 0 || i === a.length - 1 ? day(x.d).slice(0, 5) : "", value: x.n, ghost: 0, sub: x.n === 0 ? "niciun mesaj în ziua aceasta" : undefined })), [series]);

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <Fold id="stats" label="Rezumat antene" title="Rezumat antene" summary={data ? `${nf.format(counts.total)} antene · ${nf.format(counts.ours)} cu contoarele noastre de gaz · ${nf.format(counts.on)} / ${nf.format(counts.slow)} / ${nf.format(counts.off)} active / lente / oprite · ${nf.format(counts.noPos)} fără locație` : "se încarcă…"}>
        <section className="stats auto" aria-label="Rezumat antene">
        <div className="stat"><div className="k">Antene în total</div><div className="v">{data ? nf.format(counts.total) : "—"}</div><div className="s">din SCADA și din mesajele primite la noi</div></div>
        <div className="stat"><div className="k">Cu contoarele noastre de gaz</div><div className="v">{data ? nf.format(counts.ours) : "—"}</div><div className="s">au auzit gaz în ultima lună</div></div>
        <div className="stat"><div className="k">Gaz demult / niciodată</div><div className="v">{data ? `${nf.format(counts.older)} / ${nf.format(counts.never)}` : "—"}</div><div className="s">fără legătură cu contoarele noastre acum</div></div>
        <div className="stat"><div className="k">Active / lente / oprite</div><div className="v">{data ? `${nf.format(counts.on)} / ${nf.format(counts.slow)} / ${nf.format(counts.off)}` : "—"}</div><div className="s">după ultima activitate (oră / 24 h)</div></div>
        <div className="stat"><div className="k">Fără locație</div><div className="v">{data ? nf.format(counts.noPos) : "—"}</div><div className="s">nu apar pe hartă</div></div>
        </section>
      </Fold>

      <Fold id="filter" card label="Filtru rază și perioadă" title="Filtru: raza de acțiune și perioada" summary={gf.on ? gf.text : "toate antenele, toate contoarele"}>
        <p className="cell-sub" style={{ margin: "0 0 8px", whiteSpace: "normal" }}>Se aplică tabelului, hărții, fișei antenei și graficelor ei: raza = distanța dintre antenă și contor, perioada = când a auzit antena ultima oară contorul. Alegerea se ține minte (e aceeași și pe harta de contoare).</p>
        <GwFilterBar f={gf.f} set={gf.set} reset={gf.reset} on={gf.on} wide />
        {gf.on && <p className="gwf-note">{match ? `${nf.format(match.size)} antene au contoare în filtru (${gf.text}).` : "Se calculează…"}</p>}
      </Fold>

      <Fold id="table" card label="Antene" title="Datele fiecărei antene" summary={`${nf.format(shown.length)} antene afișate`}>
        <p className="cell-sub" style={{ margin: "0 0 8px", whiteSpace: "normal" }}>«Contoare de gaz» arată dacă antena a fost ultima oară cea mai bună receptoare pentru module de gaz (din SCADA, contorul CounterGasModules) sau dacă ne-a trimis contoare prin integrare. Apasă pe o antenă ca să-i vezi fișa pe hartă (dedesubt).</p>
        <div className="toolbar-row2" role="group" aria-label="Filtre" style={{ marginBottom: 8 }}>
          <label className="field"><span>Caută</span><input className="input" type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="nume, EUI, client, instalator…" /></label>
          <label className="field"><span>Legătura cu gazul</span><select className="select" value={rel} onChange={(e) => { setRel(e.target.value as Rel); setPage(0); }}>{REL.map(([k, l]) => <option key={k} value={k}>{l}{k !== "all" ? ` (${k === "ours" ? counts.ours : counts[k]})` : ` (${counts.total})`}</option>)}</select></label>
          <label className="field"><span>Stare</span><select className="select" value={state} onChange={(e) => { setState(e.target.value as typeof state); setPage(0); }}><option value="all">Toate</option><option value="on">Active</option><option value="slow">Lente</option><option value="off">Oprite</option></select></label>
        </div>
        {err && !data && <p className="form-error" role="alert">{err}</p>}
        {!data && !err && <div className="skeleton" style={{ height: 200 }} aria-busy="true" />}
        {data && (
          <div className="card-table" style={{ maxHeight: 520 }}>
            <table className="mini">
              <thead><tr>{COLS.map((c) => <th key={c.key} className={c.num ? "num" : ""} onClick={() => sortBy(c.key)} style={{ cursor: "pointer" }} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>{c.label}{sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => pick(r.id)} style={{ cursor: "pointer", background: sel === r.id ? "var(--accent-soft)" : undefined }} aria-selected={sel === r.id}>
                    <td><b>{r.name || r.id}</b>{r.created && <span className="badge" style={{ marginLeft: 6 }}>creată la noi</span>}<div className="cell-sub mono">{r.id}</div></td>
                    <td><span className="tbx-dot" style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 6, background: STATE_COLOR[r.state] }} aria-hidden="true" />{STATE_LABEL[r.state]}<div className="cell-sub">{r.last ? fdtA(r.last) : "fără activitate"}</div></td>
                    <td><span className={`badge ${linkClass(r.link)}`}>{LINK_LABEL[r.link]}</span>{r.gas !== null && r.gas !== undefined && <div className="cell-sub">{r.gas > 0 ? `${nf.format(r.gas)}× în SCADA${r.gasAt ? `, ultima dată ${day(r.gasAt)}` : ""}` : "0 în SCADA"}</div>}</td>
                    <td className="num">{match ? <>{nf.format(match.get(r.id.toLowerCase()) ?? 0)}<div className="cell-sub">în filtru, din {nf.format(r.devices)}</div></> : <>{nf.format(r.devices)}{r.devices > 0 && <div className="cell-sub">{nf.format(r.primary)} primare · {nf.format(r.exclusive)} doar ea</div>}</>}</td>
                    <td className="num">{r.rssi === null ? "—" : `${r1(r.rssi)} / ${r1(r.snr)}`}</td>
                    <td className="num">{nf.format(r.msgs)}</td>
                    <td style={{ whiteSpace: "normal", minWidth: 160 }}>{r.Client || "—"}{r.NumeInstalator && <div className="cell-sub">{r.NumeInstalator}</div>}</td>
                    <td>{hasPos(r) ? <span className="badge ok">pe hartă</span> : <span className="badge warn">fără</span>}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={COLS.length} className="cell-sub" style={{ padding: 16 }}>Nicio antenă pentru filtrele alese.{gf.on ? " Resetează filtrul de rază / perioadă ca să le vezi pe toate." : ""}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <span className="cell-sub">{from} – {to} din {nf.format(shown.length)}</span>
            <select className="select" style={{ width: 90, height: 30 }} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} aria-label="Pe pagină">{[25, 50, 100, 0].map((n) => <option key={n} value={n}>{n === 0 ? "Toate" : n}</option>)}</select>
            <button type="button" className="btn btn-sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹</button>
            <button type="button" className="btn btn-sm" disabled={to >= shown.length} onClick={() => setPage(pg + 1)}>›</button>
          </div>
        )}
      </Fold>

      <section className="mapwrap ant-wrap" ref={wrapRef} aria-label="Harta antenelor">
        <div className="map-bar">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Harta antenelor</h3>
            <span className="cell-sub">{nf.format(shown.filter(hasPos).length)} din {nf.format(shown.length)} antene din tabel au locație{gf.on ? ` (filtru: ${gf.text})` : ""}. Apasă pe o antenă ca să-i vezi fișa aici, pe hartă.</span>
          </div>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={toggleFull} aria-pressed={full || pseudo}>{full || pseudo ? "Ieși din ecranul complet" : "Ecran complet"}</button>
        </div>
        <div className="map-stage ant-stage">
          <AntennasMap rows={shown} selected={sel} onPick={pickMap} follow={follow} />
          <div className="map-legend" aria-label="Legendă">
            <div className="map-leg-row"><span className="map-dot" style={{ background: "#2e7d32" }} aria-hidden="true" /><span>Activă</span></div>
            <div className="map-leg-row"><span className="map-dot" style={{ background: "#d32f2f" }} aria-hidden="true" /><span>Oprită</span></div>
            <div className="map-leg-row"><span className="map-dot" style={{ background: "#fff", boxShadow: "0 0 0 2.5px #01695c" }} aria-hidden="true" /><span>Aleasă (fișa e în dreapta sus)</span></div>
          </div>
          <div className="map-side ant-side">
            {cur && (
              <MapCard mode={cardMode} setMode={setCardMode} icon={<IcoTower />} label={`Fișa antenei ${cur.name || cur.id}`} className="map-popup ant-card" role="dialog" title={cur.name || cur.id} sub={<span className="mono">{cur.id}</span>}>
          <div className="usr-grid">
            <Fact k="Stare" v={`${STATE_LABEL[cur.state]}${cur.last ? ` · ultima activitate ${fdtA(cur.last)}` : ""}`} />
            <Fact k="Contoare de gaz" v={`${LINK_LABEL[cur.link]}${cur.gas ? ` · ${nf.format(cur.gas)}× în SCADA${cur.gasAt ? `, ultima dată ${day(cur.gasAt)}` : ""}` : ""}`} />
            <Fact k="Contoare auzite la noi" v={cur.devices ? `${nf.format(cur.devices)} (${nf.format(cur.primary)} primare, ${nf.format(cur.exclusive)} doar ea)` : "niciunul încă"} />
            <Fact k="Semnal mediu (RSSI / SNR)" v={cur.rssi === null ? "—" : `${r1(cur.rssi)} dBm / ${r1(cur.snr)} dB`} />
            <Fact k="Mesaje primite la noi" v={nf.format(cur.msgs)} />
            <Fact k="Locație" v={hasPos(cur) ? `${cur.latitude}, ${cur.longitude}` : "nu are"} />
            <Fact k="Client" v={cur.Client || "—"} />
            <Fact k="Instalator" v={cur.NumeInstalator || "—"} />
            <Fact k="NrTel_SIM" v={cur.NrTel_SIM || "—"} />
            <Fact k="ip_address" v={cur.ip_address || "—"} />
            <Fact k="Instalată / mobilă" v={`${cur.Instalta ? "da" : "nu"} / ${cur.Antena_mobila ? "da" : "nu"}`} />
            <Fact k="Comentarii" v={cur.Comments || "—"} />
          </div>
          {!m && <div className="skeleton" style={{ height: 80, marginTop: 10 }} aria-busy="true" />}
          {m?.err && <p className="form-error" role="alert">{m.err}</p>}
          {m?.v && (
            <>
              <h4 style={{ margin: "14px 0 2px" }}>Mesaje primite pe zi ({periodActive(gf.q) ? `${periodText(gf.f)}, din ultimele 60 de zile` : "ultimele 60 de zile"})</h4>
              <p className="cell-sub" style={{ margin: "0 0 8px", whiteSpace: "normal" }}>Fiecare coloană este o zi; înălțimea ei = câte mesaje de la contoarele noastre a primit antena în ziua aceea (ziua începe la miezul nopții UTC). Pe axa din stânga sunt numărul de mesaje, iar dedesubt datele. Treci cu cursorul (sau atinge) peste o coloană ca să vezi ziua exactă.</p>
              {radiusActive(gf.q) && <p className="gwf-note">Raza aleasă nu se aplică mesajelor pe zi: ele se rețin pe antenă, nu pe contor. Perioada se aplică. Raza se vede în graficul «Contoare după distanță» și în lista contoarelor, de mai jos.</p>}
              {!stat && series && series.length === 0 && <p className="cell-sub">Nicio zi în perioada aleasă (mesajele pe zi se păstrează 60 de zile).</p>}
              {stat && stat.total === 0 && <p className="cell-sub">Antena nu a primit niciun mesaj de la contoarele noastre în {stat.days === 60 ? "ultimele 60 de zile" : `perioada aleasă (${stat.days} ${stat.days === 1 ? "zi" : "zile"})`}.</p>}
              {stat && stat.total > 0 && (
                <>
                  <div className="stats auto" style={{ marginBottom: 8 }}>
                    <div className="stat"><div className="k">Total în {stat.days} {stat.days === 1 ? "zi" : "zile"}</div><div className="v">{nf.format(stat.total)}</div><div className="s">mesaje primite</div></div>
                    <div className="stat"><div className="k">Zile cu mesaje</div><div className="v">{stat.activeDays} din {stat.days}</div><div className="s">medie {nf.format(stat.avg)} / zi activă</div></div>
                    <div className="stat"><div className="k">Cea mai bună zi</div><div className="v">{nf.format(stat.peak.n)}</div><div className="s">{day(stat.peak.d)}</div></div>
                    <div className="stat"><div className="k">Azi / ieri</div><div className="v">{nf.format(stat.today)} / {nf.format(stat.yesterday)}</div><div className="s">{stat.lastDay ? `ultimul mesaj în ziua ${day(stat.lastDay)}` : ""}</div></div>
                  </div>
                  <ColumnChart bars={bars} unit="mesaje" ariaLabel={`Mesaje primite pe zi de antenă, ${stat.days} zile, total ${stat.total}`} height={190} labelWidth={46} />
                </>
              )}
              {m.v.detail && <Devices d={m.v.detail} q={gf.q} on={gf.on} text={gf.text} />}
              {!m.v.detail && <p className="cell-sub" style={{ marginTop: 10 }}>La noi nu a trimis încă niciun mesaj prin integrare, deci nu avem contoare auzite de ea.</p>}
            </>
          )}
                  <div className="map-btns"><button type="button" className="btn btn-sm" onClick={() => setSel(null)}>Deselectează antena</button></div>
              </MapCard>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const Fact = ({ k, v }: { k: string; v: string }) => <div className="field"><span>{k}</span><div style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{v}</div></div>;

function Devices({ d, q, on, text }: { d: GwDetail; q: GwQuery; on: boolean; text: string }) {
  const pick = (label: string, x: GwDetail["nearest"]) => (x ? <li><span className="cell-sub">{label}: </span><b>{x.name}</b>{x.km !== null ? ` · ${r1(x.km)} km` : ""}{x.rssi !== null ? ` · RSSI ${r1(x.rssi)}` : ""}</li> : null);
  return (
    <>
      <h4 style={{ margin: "14px 0 2px" }}>Contoare după distanță</h4>
      <p className="cell-sub" style={{ margin: "0 0 6px", whiteSpace: "normal" }}>Câte contoare aude antena la fiecare distanță (raza ei de acțiune){on ? "; cele din raza aleasă rămân pline, restul sunt estompate" : ""}.</p>
      <DistanceChart bands={d.bands} unknown={d.bandsUnknown} q={q} />
      <h4 style={{ margin: "14px 0 6px" }}>{on ? `Contoare auzite de ea, în filtru (${nf.format(d.devicesIn)} din ${nf.format(d.devicesTotal)})` : `Contoare auzite de ea (${nf.format(d.devicesTotal)})`}</h4>
      {on && d.devicesIn === 0 && <p className="cell-sub">Niciun contor nu trece de filtru ({text}). Schimbă raza sau perioada.</p>}
      <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>{pick("cel mai apropiat", d.nearest)}{pick("cel mai îndepărtat", d.farthest)}{pick("semnalul cel mai bun", d.strongest)}{pick("semnalul cel mai slab", d.weakest)}</ul>
      <div className="card-table" style={{ maxHeight: 320 }}>
        <table className="mini">
          <thead><tr><th>Contor</th><th className="num">Distanță</th><th className="num">RSSI</th><th className="num">SNR</th><th className="num">Mesaje</th><th>Ultimul mesaj</th></tr></thead>
          <tbody>{d.list.slice(0, 200).map((x) => <tr key={x.id}><td>{x.name}</td><td className="num">{x.km === null ? "—" : `${r1(x.km)} km`}</td><td className="num">{r1(x.rssi)}</td><td className="num">{r1(x.snr)}</td><td className="num">{nf.format(x.n)}</td><td className="cell-sub">{fdtA(x.last)}</td></tr>)}</tbody>
        </table>
      </div>
      {d.devicesIn > 200 && <p className="cell-sub">Primele 200 din {nf.format(d.devicesIn)} (cele mai recente).</p>}
    </>
  );
}

/** Secțiune care se strânge / se deschide din antet (alegerea se ține minte în browser). */
function Fold({ id, label, title, summary, card, children }: { id: string; label: string; title: string; summary: string; card?: boolean; children: ReactNode }) {
  const key = `mg:ant:fold:${id}`;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => { try { if (localStorage.getItem(key) === "0") setOpen(false); } catch { /* fără alegere reținută */ } }, 0);
    return () => clearTimeout(t);
  }, [key]);
  const toggle = () => setOpen((v) => { const n = !v; try { localStorage.setItem(key, n ? "1" : "0"); } catch { /* alegerea nu se reține */ } return n; });
  const head = (
    <button type="button" className="fold-head" aria-expanded={open} onClick={toggle} title={open ? "Strânge" : "Deschide"}>
      <span className="fold-i" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span className="fold-t">{title}</span>
      {!open && <span className="cell-sub fold-s">{summary}</span>}
    </button>
  );
  return (
    <section className={card ? "card" : "fold-plain"} aria-label={label}>
      {head}
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
