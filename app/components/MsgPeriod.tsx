"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { iso, periodOptions, useMsgPeriod } from "./useMsgCounts";

/**
 * Perioada pentru mesaje: meniu cu zile (azi, ieri, ultimele 2–13 zile), perioade (3 zile, o săptămână, o lună — zile întregi, fără azi) și «Interval ales…» (două date, cel mult 31 de zile).
 * `compact` (rândul de filtre al tabelului): datele alese apar într-o fereastră mică sub meniu; altfel (fila «Mesaje») câmpurile stau pe loc, lângă meniu.
 */
const DAY = 86_400_000;
export default function MsgPeriod({ compact = false }: { compact?: boolean }) {
  const [period, setPeriod] = useMsgPeriod();
  const [now] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const rg = /^r:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(period);
  const custom = rg !== null;
  const from = rg ? rg[1] : "", to = rg ? rg[2] : "";
  const t = Math.floor(now / DAY) * DAY;
  const lo = iso(t - 30 * DAY), hi = iso(t);
  const { perioade, zile } = periodOptions(now);

  const openAt = () => { const r = box.current?.getBoundingClientRect(); if (r) setRect({ left: Math.min(r.left, window.innerWidth - 250), top: r.bottom + 4 }); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { const n = e.target as Node; if (!pop.current?.contains(n) && !box.current?.contains(n)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const onSel = (v: string) => {
    if (v === "custom") { setPeriod(`r:${iso(t - 7 * DAY)}:${iso(t - DAY)}`); if (compact) openAt(); }
    else { setPeriod(v); setOpen(false); }
  };
  const setDates = (a: string, b: string) => { if (a && b) setPeriod(`r:${a}:${b}`); };
  const dates = (
    <div className={compact ? "msgp-pop" : "msgp-inline"} ref={compact ? pop : undefined} style={compact && rect ? { position: "fixed", left: rect.left, top: rect.top } : undefined} role={compact ? "dialog" : undefined} aria-label="Interval ales">
      <label>de la <input className="input" type="date" min={lo} max={to || hi} value={from} onChange={(e) => setDates(e.target.value, to)} /></label>
      <label>până la <input className="input" type="date" min={from || lo} max={hi} value={to} onChange={(e) => setDates(from, e.target.value)} /></label>
      <span className="cell-sub">cel mult 31 de zile; ziua începe la miezul nopții UTC</span>
      {compact && <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Gata</button>}
    </div>
  );
  return (
    <div className={compact ? "msgp msgp-c" : "msgp"} ref={box}>
      <select className="select cf-in" aria-label="Perioada pentru mesaje (UTC)" title="Perioada pentru care se arată mesajele (zilele încep la miezul nopții UTC)" value={custom ? "custom" : period} onChange={(e) => onSel(e.target.value)}>
        <optgroup label="Perioade (zile întregi)">{perioade.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</optgroup>
        <optgroup label="O singură zi">{zile.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</optgroup>
        <option value="custom">{custom && from && to ? `${from.slice(5).split("-").reverse().join(".")} – ${to.slice(5).split("-").reverse().join(".")}` : "Interval ales…"}</option>
      </select>
      {custom && compact && <button type="button" className="btn btn-sm msgp-btn" onClick={() => (open ? setOpen(false) : openAt())} aria-label="Schimbă intervalul" title="Schimbă intervalul">▾</button>}
      {custom && !compact && dates}
      {custom && compact && open && createPortal(dates, document.body)}
    </div>
  );
}
