"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DATE_RE, DEFAULT_FILTER, KM_SLIDER_MAX, PERIODS, RADII, describe, parseQuery, periodText, queryActive, queryString, radiusOf, toQuery, type GwFilter, type GwPeriod, type GwQuery, type GwRadius } from "@/lib/gw-filter";

/**
 * Filtrul antenelor: perioada (azi · ultimele 7 zile · mai vechi de 7 zile · toate) și raza de acțiune (până la 1 / 3 / 10 km · toate · sau un interval «de la – până la» cu două puncte).
 * Aceeași alegere se folosește pe harta de contoare, pe «Antene: date și hartă» și (raza) în graficele antenelor; se ține minte în browser, ca să nu o alegi de fiecare dată.
 * «Perioada» = când a auzit antena ultima oară contorul; «raza» = distanța dintre antenă și contor.
 */
const KEY = "mg:gwfilter";
const GW_EVENT = "mg:gwfilter-change";
const PER_OK = new Set<string>(PERIODS.map((p) => p[0])), RAD_OK = new Set<string>(RADII.map((r) => r[0]));

function read(): GwFilter {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<GwFilter> | null;
    if (!o || typeof o !== "object") return DEFAULT_FILTER;
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      per: PER_OK.has(String(o.per)) ? (o.per as GwPeriod) : "all", rad: RAD_OK.has(String(o.rad)) ? (o.rad as GwRadius) : "all",
      kmMin: n(o.kmMin, 0), kmMax: o.kmMax === null || o.kmMax === undefined ? null : n(o.kmMax, 0),
      pFrom: typeof o.pFrom === "string" && DATE_RE.test(o.pFrom) ? o.pFrom : "", pTo: typeof o.pTo === "string" && DATE_RE.test(o.pTo) ? o.pTo : "",
    };
  } catch { return DEFAULT_FILTER; }
}

/** Filtrul curent + limitele lui gata de trimis serverului. Toate locurile din pagină care îl folosesc rămân la fel (se anunță între ele). */
export function useGwFilter(): { f: GwFilter; set: (p: Partial<GwFilter>) => void; reset: () => void; q: GwQuery; on: boolean; text: string; /** alegere făcută dar încă neaplicată (se așteaptă o clipă după ultima mișcare a glisorului) */ dirty: boolean } {
  const [f, setF] = useState<GwFilter>(DEFAULT_FILTER);
  const cur = useRef<GwFilter>(DEFAULT_FILTER);
  /** butoanele și meniurile se aplică pe loc; glisorul și câmpurile numerice așteaptă o clipă după ultima mișcare (altfel fiecare pas ar însemna o cerere) */
  const fast = useRef(true);
  // «acum» se reîmprospătează rar: limitele perioadei depind doar de ziua curentă (miezul nopții local), deci cererile nu se schimbă între timp
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const load = () => { const n = read(); cur.current = n; fast.current = true; setF(n); };
    const t0 = setTimeout(load, 0);
    const onChange = load;
    window.addEventListener(GW_EVENT, onChange);
    const iv = setInterval(() => setNow(Date.now()), 60_000); // «ultima oră» / «24 de ore» se mută odată cu ceasul; restul perioadelor nu schimbă cererea
    return () => { clearTimeout(t0); window.removeEventListener(GW_EVENT, onChange); clearInterval(iv); };
  }, []);
  const save = useCallback((n: GwFilter) => {
    cur.current = n;
    setF(n);
    try { localStorage.setItem(KEY, JSON.stringify(n)); window.dispatchEvent(new Event(GW_EVENT)); } catch { /* alegerea nu se reține */ }
  }, []);
  const set = useCallback((p: Partial<GwFilter>) => { fast.current = !("kmMin" in p || "kmMax" in p || "pFrom" in p || "pTo" in p); save({ ...cur.current, ...p }); }, [save]);
  const reset = useCallback(() => { fast.current = true; save(DEFAULT_FILTER); }, [save]);
  // același filtru = același obiect: trecerea timpului nu declanșează reîncărcări și redesenări dacă limitele nu s-au schimbat
  const raw = queryString(toQuery(f, now));
  const [key, setKey] = useState(raw);
  useEffect(() => {
    if (raw === key) return;
    const t = setTimeout(() => setKey(raw), fast.current ? 0 : 220);
    return () => clearTimeout(t);
  }, [raw, key]);
  const q = useMemo(() => parseQuery(new URLSearchParams(key)), [key]);
  return { f, set, reset, q, on: queryActive(q), text: describe(f), dirty: raw !== key };
}

const fmt = (x: number) => String(x).replace(".", ",");

export default function GwFilterBar({ f, set, reset, on, compact = false, wide = false, hideRadius = false, hidePeriod = false }: {
  f: GwFilter; set: (p: Partial<GwFilter>) => void; reset: () => void; on: boolean;
  /** în cardul de pe hartă: coloane înguste, fără titluri mari */ compact?: boolean; /** pe pagină: perioada și raza una lângă alta */ wide?: boolean; hideRadius?: boolean; hidePeriod?: boolean;
}) {
  const r = radiusOf(f);
  const lo = r.kmin, hi = r.kmax ?? KM_SLIDER_MAX;
  const pickRad = (v: GwRadius) => {
    if (v === "range") set({ rad: "range", kmMin: r.kmin, kmMax: r.kmax }); // intervalul pornește de la ce era ales
    else set({ rad: v });
  };
  const setLo = (v: number) => set({ rad: "range", kmMin: Math.min(v, hi), kmMax: r.kmax });
  const setHi = (v: number) => set({ rad: "range", kmMin: lo, kmMax: v >= KM_SLIDER_MAX ? null : Math.max(v, lo) });
  const numIn = (s: string): number | null => { const x = Number(s.replace(",", ".")); return s.trim() !== "" && Number.isFinite(x) && x >= 0 ? Math.min(x, 1000) : null; };

  return (
    <div className={`gwf${compact ? " gwf-compact" : ""}${wide ? " gwf-wide" : ""}`} role="group" aria-label="Filtru antene: rază și perioadă">
      {!hidePeriod && (
        <div className="field">
          <label htmlFor="gwf-per-sel" id="gwf-per">De la ce contoare a primit date antena</label>
          <select id="gwf-per-sel" className="select" value={f.per} onChange={(e) => {
            const per = e.target.value as GwPeriod;
            // la «Interval de date» pornesc ultimele 7 zile, ca să nu fie gol
            if (per === "range" && !f.pFrom && !f.pTo) { const t = new Date(), u = new Date(t); u.setDate(u.getDate() - 6); const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; set({ per, pFrom: ymd(u), pTo: ymd(t) }); }
            else set({ per });
          }}>
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {f.per === "range" && (
            <div className="gwf-nums">
              <label>de la <input className="input" type="date" value={f.pFrom} max={f.pTo || undefined} onChange={(e) => set({ pFrom: e.target.value })} /></label>
              <label>până la <input className="input" type="date" value={f.pTo} min={f.pFrom || undefined} onChange={(e) => set({ pTo: e.target.value })} /></label>
            </div>
          )}
          <div className="cell-sub">{f.per === "all" ? "fără limită de dată" : `ultimul mesaj al contorului: ${periodText(f) || "alege datele"}`}</div>
        </div>
      )}
      {!hideRadius && (
        <div className="field">
          <span id="gwf-rad">Raza de acțiune (distanța antenă ↔ contor)</span>
          <div className="seg gwf-seg" role="group" aria-labelledby="gwf-rad">
            {RADII.map(([v, l]) => <button key={v} type="button" aria-pressed={f.rad === v} onClick={() => pickRad(v)}>{l}</button>)}
          </div>
          {f.rad === "range" && (
            <div className="gwf-range">
              <div className="gwf-dual" aria-hidden="false">
                <div className="gwf-track"><i style={{ left: `${(lo / KM_SLIDER_MAX) * 100}%`, right: `${100 - (hi / KM_SLIDER_MAX) * 100}%` }} /></div>
                <input type="range" min={0} max={KM_SLIDER_MAX} step={0.5} value={Math.min(lo, KM_SLIDER_MAX)} onChange={(e) => setLo(Number(e.target.value))} aria-label="De la (km)" />
                <input type="range" min={0} max={KM_SLIDER_MAX} step={0.5} value={hi} onChange={(e) => setHi(Number(e.target.value))} aria-label="Până la (km), maxim = fără limită" />
              </div>
              <div className="gwf-nums">
                <label>de la <input className="input" type="number" inputMode="decimal" min={0} step={0.5} value={r.kmin} onChange={(e) => { const v = numIn(e.target.value); if (v !== null) set({ rad: "range", kmMin: v, kmMax: r.kmax }); }} /> km</label>
                <label>până la <input className="input" type="number" inputMode="decimal" min={0} step={0.5} placeholder="fără limită" value={r.kmax ?? ""} onChange={(e) => set({ rad: "range", kmMin: r.kmin, kmMax: numIn(e.target.value) })} /> km</label>
              </div>
              <div className="cell-sub">{r.kmax === null ? `de la ${fmt(r.kmin)} km, fără limită` : `între ${fmt(r.kmin)} și ${fmt(r.kmax)} km`}{r.kmax === null || r.kmax >= KM_SLIDER_MAX ? " (glisorul la maxim = fără limită)" : ""}</div>
            </div>
          )}
        </div>
      )}
      {on && <button type="button" className="btn btn-sm gwf-reset" onClick={reset}>Resetează filtrul (toate)</button>}
    </div>
  );
}

/** Pictograma filtrului (pâlnie) pentru cardul de pe hartă. */
export const IcoFunnel = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V20l-4-2v-4.5z" /></svg>
);
