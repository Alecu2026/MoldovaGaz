"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { GwDetail } from "@/lib/services/gateways";
import GatewayInfo, { km, nf, when } from "./GatewayInfo";
import { gwGet } from "./gw-fetch";

const AntennaMap = dynamic(() => import("./AntennaMap"), { ssr: false, loading: () => <div className="skeleton gw-minimap" /> });

/**
 * Popup-ul unei antene (la click pe o antenă în Grafice): informațiile ei ca în panoul de pe hartă + harta ei cu TOATE contoarele cu care comunică + lista completă a
 * contoarelor (căutare, sortare). Click pe un contor (în listă, pe hartă sau în ultimele cereri) deschide detaliile contorului. Esc sau click în afară închide.
 */
const ROW = 34, VIEW = 380, OVERSCAN = 10;
type SortKey = "last" | "km" | "n" | "rssi" | "name";
const SORTS: [SortKey, string][] = [["last", "Ultimul mesaj"], ["km", "Distanță (apropiate întâi)"], ["n", "Mesaje"], ["rssi", "Semnal (cel mai bun întâi)"], ["name", "Nume"]];

export default function GatewayPopup({ id, onClose, onOpenMeter, onSeries }: { id: string; onClose: () => void; onOpenMeter: (id: string) => void; onSeries: (id: string) => void }) {
  const [res, setRes] = useState<{ id: string; det: GwDetail | null } | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("last");
  const [now] = useState(() => Date.now());
  /** lista contoarelor e VIRTUALIZATĂ: în DOM stau doar rândurile din fereastră (+ câteva de rezervă), nu cele până la 3000 */
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    void gwGet<GwDetail>(`/api/integration/gateways?id=${encodeURIComponent(id)}`, ac.signal).then((d) => { if (!ac.signal.aborted) setRes({ id, det: d }); });
    return () => ac.abort();
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const det = res && res.id === id ? res.det : null;
  const loading = !res || res.id !== id;
  const list = useMemo(() => {
    const all = det?.list ?? [];
    const needle = q.trim().toLowerCase();
    const f = needle ? all.filter((d) => d.name.toLowerCase().includes(needle)) : [...all];
    const by: Record<SortKey, (a: (typeof all)[number], b: (typeof all)[number]) => number> = {
      last: (a, b) => b.last - a.last,
      km: (a, b) => (a.km ?? 1e9) - (b.km ?? 1e9),
      n: (a, b) => b.n - a.n,
      rssi: (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
      name: (a, b) => a.name.localeCompare(b.name, "ro", { numeric: true }),
    };
    return f.sort(by[sort]);
  }, [det, q, sort]);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN), last = Math.min(list.length, Math.ceil((scrollTop + VIEW) / ROW) + OVERSCAN);
  const mapDevices = useMemo(() => (det?.list ?? []).filter((d) => d.la !== null && d.lo !== null).map((d) => ({ id: d.id, name: d.name, la: d.la as number, lo: d.lo as number, rssi: d.rssi, km: d.km })), [det]);

  return (
    <div className="gwpop-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gwpop" role="dialog" aria-modal="true" aria-label={det ? `Antena ${det.gateway.name}` : "Antenă"}>
        <header className="card-h" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ fontSize: 18 }}>{det ? det.gateway.name : "Se încarcă antena…"}</h3>
            {det && <p>{nf.format(det.devicesTotal)} contoare comunică cu această antenă · id {det.gateway.id}</p>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={() => onSeries(id)} disabled={!det} title="Arată seria pe zile a acestei antene în grafic">Arată în grafic</button>
            <button type="button" className="btn" onClick={onClose} aria-label="Închide">Închide ×</button>
          </div>
        </header>

        {loading ? (
          <div className="skeleton" style={{ height: 320 }} />
        ) : !det ? (
          <p className="cell-sub">Nu am putut citi antena (poate nu mai există în evidență).</p>
        ) : (
          <div className="gwpop-cols">
            <div className="gwpop-left">
              <GatewayInfo det={det} now={now} onOpen={onOpenMeter} />
            </div>
            <div className="gwpop-right">
              <AntennaMap name={det.gateway.name} la={det.gateway.la} lo={det.gateway.lo} state={det.gateway.state} devices={mapDevices} onOpen={onOpenMeter} />
              <p className="cell-sub" style={{ margin: "4px 0 8px", whiteSpace: "normal" }}>
                Puncte = contoarele cu care comunică ({nf.format(mapDevices.length)} cu coordonate din {nf.format(det.devicesTotal)}); culoare după semnal: verde bun, galben mediu, roșu slab. Click pe un punct = detaliile contorului.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
                <label className="field"><span>Caută contor</span><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="nume" style={{ width: 200 }} /></label>
                <label className="field"><span>Ordonează după</span>
                  <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                <span className="cell-sub">{nf.format(list.length)} din {nf.format(det.list.length)}</span>
              </div>
              <div className="card-table" style={{ maxHeight: VIEW }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
                <table className="mini">
                  <thead><tr><th>Contor</th><th className="num">Distanță</th><th className="num">RSSI</th><th className="num">SNR</th><th className="num">Mesaje</th><th>Ultimul mesaj</th></tr></thead>
                  <tbody>
                    {first > 0 && <tr aria-hidden="true" style={{ height: first * ROW }}><td colSpan={6} style={{ padding: 0, border: 0 }} /></tr>}
                    {list.slice(first, last).map((d) => (
                      <tr key={d.id} style={{ height: ROW }}>
                        <td><button type="button" className="link-btn" onClick={() => onOpenMeter(d.id)}>{d.name}</button></td>
                        <td className="num mono">{km(d.km)}</td>
                        <td className="num mono">{d.rssi ?? "—"}</td>
                        <td className="num mono">{d.snr ?? "—"}</td>
                        <td className="num mono">{nf.format(d.n)}</td>
                        <td className="mono">{when(d.last).slice(0, 16)}</td>
                      </tr>
                    ))}
                    {last < list.length && <tr aria-hidden="true" style={{ height: (list.length - last) * ROW }}><td colSpan={6} style={{ padding: 0, border: 0 }} /></tr>}
                    {list.length === 0 && <tr><td colSpan={6} className="cell-sub" style={{ padding: 14 }}>Niciun contor.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
