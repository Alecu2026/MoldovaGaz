"use client";

import { useEffect, useRef, useState } from "react";
import { DAY, dayOf, type Stats } from "@/lib/gateway-stats";
import { BarList, ColumnChart, nf, nf1, type Bar, type BarItem } from "./charts/primitives";

/**
 * Grafice pe ANTENE (gateway-uri LoRaWAN), cu filtre proprii (separate de cele ale contoarelor): perioadă (azi / 7 / 30 / 90 de zile sau interval ales), stare, căutare după nume,
 * minim de contoare, sortare. Arată eficiența fiecărei antene: contoare auzite, mesaje, mesaje pe contor, semnal (RSSI / SNR), zile active, câte contoare aude doar ea.
 * Click pe o antenă (în grafic sau în tabel) = seria ei pe zile. Datele vin din mesajele primite prin integrare (se strâng de la punerea în funcțiune); ziua e ziua UTC.
 */
type Period = "today" | "7d" | "30d" | "90d" | "custom";
const PERIODS: [Period, string, number][] = [["today", "Azi", 1], ["7d", "7 zile", 7], ["30d", "30 zile", 30], ["90d", "90 zile", 90]];
type Metric = "n" | "dv" | "gws";
const METRICS: [Metric, string][] = [["n", "Mesaje"], ["dv", "Contoare auzite (pe zi)"], ["gws", "Antene active"]];
const SORTS: [string, string][] = [["devices", "Contoare auzite"], ["messages", "Mesaje"], ["perdevice", "Mesaje / contor"], ["rssi", "Semnal (RSSI)"], ["last", "Ultimul mesaj"], ["name", "Nume"]];
const STATE_LABEL: Record<string, string> = { on: "activă", slow: "lentă", off: "offline" };
const STATE_TONE: Record<string, BarItem["tone"]> = { on: "good", slow: "warning", off: "critical" };

const p2 = (n: number) => String(n).padStart(2, "0");
const dm = (ms: number) => `${p2(new Date(ms).getUTCDate())}.${p2(new Date(ms).getUTCMonth() + 1)}`;
const ymd = (ms: number) => `${new Date(ms).getUTCFullYear()}-${p2(new Date(ms).getUTCMonth() + 1)}-${p2(new Date(ms).getUTCDate())}`;
const when = (ms: number) => {
  if (!(ms > 0)) return "—";
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

export default function GatewayCharts() {
  const [period, setPeriod] = useState<Period>("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [min, setMin] = useState("");
  const [sort, setSort] = useState("devices");
  const [metric, setMetric] = useState<Metric>("n");
  const [gw, setGw] = useState("");
  const [now] = useState(() => Date.now());
  const [res, setRes] = useState<{ key: string; data: Stats | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const days = PERIODS.find((p) => p[0] === period)?.[2] ?? 7;
  const fromMs = period === "custom" ? (Date.parse(from) || dayOf(now) - 6 * DAY) : dayOf(now) - (days - 1) * DAY;
  const toMs = period === "custom" ? (Date.parse(to) || now) : now;
  const qs = new URLSearchParams({ stats: "1", from: String(fromMs), to: String(toMs), state, q, min: min || "0", sort, gw }).toString();

  useEffect(() => {
    const ac = new AbortController();
    void fetch(`/api/integration/gateways?${qs}`, { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Stats>) : null))
      .then((d) => setRes({ key: qs, data: d }))
      .catch(() => undefined);
    return () => ac.abort();
  }, [qs]);

  const onQ = (v: string) => {
    setQInput(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(v.trim()), 350);
  };
  const loading = !res || res.key !== qs;
  const st = res?.data ?? null;
  const t = st?.totals;
  const series = gw && st?.gw ? st.gw.days : st?.days ?? [];
  const bars: Bar[] = series.map((d, i) => ({
    label: `${dm(d.d)}.${new Date(d.d).getUTCFullYear()}`, axis: i % Math.max(1, Math.ceil(series.length / 12)) === 0 ? dm(d.d) : "",
    value: metric === "n" ? d.n : metric === "dv" ? d.dv : d.gws, ghost: gw && st ? (metric === "n" ? st.days[i]?.n ?? 0 : metric === "dv" ? st.days[i]?.dv ?? 0 : st.days[i]?.gws ?? 0) : 0,
  }));
  const rows = st?.rows ?? [];
  const byDevices: BarItem[] = [...rows].filter((r) => r.devicesIn > 0).sort((a, b) => b.devicesIn - a.devicesIn).map((r) => ({ key: r.id, label: r.name, value: r.devicesIn, ghost: 0, sub: `${nf.format(r.messages)} mesaje · ${STATE_LABEL[r.state]}`, tone: STATE_TONE[r.state] }));
  const bySignal: BarItem[] = [...rows].filter((r) => r.rssiIn !== null).sort((a, b) => (b.rssiIn as number) - (a.rssiIn as number)).map((r) => ({ key: r.id, label: r.name, value: Math.max(1, 140 + (r.rssiIn as number)), ghost: 0, show: `${r.rssiIn} dBm`, sub: `SNR ${r.snrIn ?? "—"}`, tone: (r.rssiIn as number) >= -105 ? "good" : (r.rssiIn as number) >= -115 ? "warning" : "critical" }));
  const noData = !!st && st.days.every((d) => d.n === 0);
  const pick = (k: string) => setGw((g) => (g === k ? "" : k));

  return (
    <section className="card" aria-label="Antene" style={{ marginTop: 12 }}>
      <header className="card-h">
        <div>
          <h3>Antene: eficiență pe perioadă</h3>
          <p>Din mesajele primite prin integrare (se strâng de la punerea în funcțiune). Filtrele de aici sunt doar pentru antene, nu pentru contoare. Ziua = ziua UTC.</p>
        </div>
      </header>

      <div className="toolbar-row2" role="group" aria-label="Filtre antene" style={{ marginBottom: 10 }}>
        <div className="field">
          <span id="gw-period">Perioadă</span>
          <div className="seg" role="group" aria-labelledby="gw-period">
            {PERIODS.map(([v, l]) => <button key={v} type="button" aria-pressed={period === v} onClick={() => setPeriod(v)}>{l}</button>)}
            <button type="button" aria-pressed={period === "custom"} onClick={() => { setPeriod("custom"); if (!from) setFrom(ymd(dayOf(now) - 6 * DAY)); if (!to) setTo(ymd(now)); }}>Interval</button>
          </div>
        </div>
        {period === "custom" && (
          <>
            <label className="field"><span>De la</span><input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field"><span>Până la</span><input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        <label className="field"><span>Stare antenă</span>
          <select className="select" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Toate</option><option value="on">Active (ultima oră)</option><option value="slow">Lente (sub 24 h)</option><option value="off">Offline (peste 24 h)</option>
          </select>
        </label>
        <label className="field"><span>Caută antenă</span><input className="input" type="search" placeholder="nume sau id" value={qInput} onChange={(e) => onQ(e.target.value)} /></label>
        <label className="field"><span>Contoare auzite, minim</span><input className="input" type="number" min={0} value={min} placeholder="0" onChange={(e) => setMin(e.target.value)} style={{ width: 110 }} /></label>
        <label className="field"><span>Ordonează după</span>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        {(state || q || min || gw) && <button type="button" className="btn" onClick={() => { setState(""); setQ(""); setQInput(""); setMin(""); setGw(""); }}>Resetează filtrele antenelor</button>}
      </div>

      {st && t && (
        <div className="stats auto" aria-live="polite" style={{ opacity: loading ? 0.6 : 1, marginBottom: 12 }}>
          <div className="stat"><div className="k">Antene în filtru</div><div className="v">{nf.format(t.gateways)}</div><div className="s">{t.on} active · {t.slow} lente · {t.off} offline</div></div>
          <div className="stat"><div className="k">Mesaje în perioadă</div><div className="v">{nf.format(t.messages)}</div><div className="s">auzite de antenele din filtru</div></div>
          <div className="stat"><div className="k">Contoare auzite</div><div className="v">{nf.format(t.devices)}</div><div className="s">suma pe antene (un contor aude mai multe)</div></div>
          <div className="stat"><div className="k">Mesaje / contor</div><div className="v">{t.avgPerDevice !== null ? nf1.format(t.avgPerDevice) : "—"}</div><div className="s">medie pe antenă-contor</div></div>
          <div className="stat"><div className="k">Semnal mediu</div><div className="v">{t.rssi !== null ? `${nf1.format(t.rssi)} dBm` : "—"}</div><div className="s">ponderat cu mesajele</div></div>
          <div className="stat"><div className="k">Antene cu contoare doar ale lor</div><div className="v">{nf.format(t.singles)}</div><div className="s">fără ele, acele contoare nu s-ar auzi</div></div>
        </div>
      )}

      {noData && !loading && <p className="cell-sub" style={{ whiteSpace: "normal" }}>Încă nu avem mesaje pe zile în această perioadă. Datele se strâng din mesajele primite după punerea în funcțiune a acestei funcții; revino după câteva ore sau alege o perioadă mai recentă.</p>}

      <div className="seg" role="group" aria-label="Ce arată graficul pe zile" style={{ marginBottom: 6 }}>
        {METRICS.map(([v, l]) => <button key={v} type="button" aria-pressed={metric === v} onClick={() => setMetric(v)}>{l}</button>)}
      </div>
      <p className="cell-sub" style={{ margin: "0 0 4px" }}>{gw && st?.gw ? <>Antena <b>{st.gw.name}</b> (restul, estompat) · <button type="button" className="link-btn" onClick={() => setGw("")}>arată toate</button></> : "Toate antenele din filtru, pe zile"}</p>
      <div style={{ opacity: loading ? 0.6 : 1 }}>
        <ColumnChart unit={metric === "n" ? "mesaje" : metric === "dv" ? "contoare" : "antene"} bars={bars} ariaLabel="Antene pe zile" height={170} labelWidth={52} />
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <section className="card" aria-label="Contoare auzite pe antenă">
          <header className="card-h"><div><h3>Contoare auzite, pe antenă</h3><p>în perioadă; click = seria antenei</p></div></header>
          <BarList unit="contoare" items={byDevices} selected={gw ? [gw] : []} onToggle={pick} top={12} ariaLabel="Contoare auzite pe antenă" />
        </section>
        <section className="card" aria-label="Semnal pe antenă">
          <header className="card-h"><div><h3>Semnal mediu, pe antenă</h3><p>RSSI mediu în perioadă (mai lung = mai bun)</p></div></header>
          <BarList unit="" items={bySignal} selected={gw ? [gw] : []} onToggle={pick} top={12} ariaLabel="Semnal mediu pe antenă" />
        </section>
      </div>

      <div className="card-table" style={{ maxHeight: 460, marginTop: 12 }}>
        <table className="mini">
          <thead>
            <tr><th>Antenă</th><th>Stare</th><th className="num">Contoare auzite</th><th className="num">Mesaje</th><th className="num">Mesaje / contor</th><th className="num">RSSI</th><th className="num">SNR</th><th className="num">Zile active</th><th className="num">Doar ea aude</th><th>Ultimul mesaj</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} aria-selected={gw === r.id} onClick={() => pick(r.id)} style={{ cursor: "pointer", background: gw === r.id ? "var(--row-hover)" : undefined }}>
                <td><b>{r.name}</b>{r.la === null && <span className="cell-sub"> · fără poziție</span>}</td>
                <td><span className={`badge ${r.state === "on" ? "ok" : r.state === "slow" ? "warn" : "danger"}`}>{STATE_LABEL[r.state]}</span></td>
                <td className="num mono">{nf.format(r.devicesIn)}</td>
                <td className="num mono">{nf.format(r.messages)}</td>
                <td className="num mono">{r.perDevice !== null ? nf1.format(r.perDevice) : "—"}</td>
                <td className="num mono">{r.rssiIn ?? "—"}</td>
                <td className="num mono">{r.snrIn ?? "—"}</td>
                <td className="num mono">{r.activeDays}</td>
                <td className="num mono">{nf.format(r.exclusive)}</td>
                <td className="mono">{when(r.last)}</td>
              </tr>
            ))}
            {st && rows.length === 0 && <tr><td colSpan={10} className="cell-sub" style={{ padding: 16 }}>Nicio antenă pentru filtrele alese.</td></tr>}
            {!st && <tr><td colSpan={10} className="cell-sub" style={{ padding: 16 }}>se încarcă…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
