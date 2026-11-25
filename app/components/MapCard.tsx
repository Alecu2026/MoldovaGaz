"use client";

import type { ReactNode } from "react";

/**
 * Cardurile de pe hartă (contorul ales, antenele lui, antena aleasă, fișa antenei) au trei stări, ca să nu acopere harta:
 *   open = card întreg · bar = doar bara cu numele (săgeata) · icon = doar un buton rotund cu pictograma cardului (ocupă cel mai puțin loc).
 * Nicio stare nu deselectează contorul / antena; apăsarea pe bară sau pe pictogramă redeschide cardul.
 */
export type CardMode = "open" | "bar" | "icon";

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
/** contor (cadran) */
export const IcoMeter = () => <Svg><path d="M4.5 18.5a9 9 0 1 1 15 0" /><path d="M12 14l4-5" /><circle cx="12" cy="14" r="1.4" /><path d="M7 21h10" /></Svg>;
/** antenă (turn radio) */
export const IcoTower = () => <Svg><path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9" /><path d="M7.8 4.7a6.1 6.1 0 0 0-.8 7.5" /><circle cx="12" cy="9" r="2" /><path d="M16.2 4.7a6.1 6.1 0 0 1 .8 7.5" /><path d="M19.1 1.9a10.1 10.1 0 0 1 0 14.2" /><path d="M9.5 18h5" /><path d="m8 22 4-11 4 11" /></Svg>;
const Shrink = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" /><path d="m3 21 7-7" /></svg>;

export default function MapCard({ mode, setMode, icon, label, title, sub, tag = "div", className, role, children }: {
  mode: CardMode; setMode: (m: CardMode) => void; icon: ReactNode;
  /** numele cardului pentru cititoare de ecran și indiciu (ex. «Contor S123») */ label: string;
  title: ReactNode; sub?: ReactNode; tag?: "div" | "aside"; className: string; role?: string; children: ReactNode;
}) {
  if (mode === "icon") {
    return <button type="button" className="map-icon-btn" onClick={() => setMode("open")} aria-label={`Deschide: ${label}`} title={`${label} — apasă ca să deschizi`}>{icon}</button>;
  }
  const Tag = tag;
  return (
    <Tag className={`${className}${mode === "bar" ? " map-card-bar" : ""}`} role={role} aria-label={label}>
      <div className="map-fold-row">
        <button type="button" className="map-fold" aria-expanded={mode === "open"} aria-label={mode === "open" ? `Strânge: ${label} (rămâne ales)` : `Deschide: ${label}`} title={mode === "open" ? "Strânge (rămâne ales)" : "Deschide"} onClick={() => setMode(mode === "open" ? "bar" : "open")}>
          <span className="map-fold-t"><span className="cell-main">{title}</span>{sub ? <span className="cell-sub">{sub}</span> : null}</span>
          <span aria-hidden="true" className="map-fold-i">{mode === "open" ? "▴" : "▾"}</span>
        </button>
        <button type="button" className="map-min" aria-label={`Doar pictogramă: ${label}`} title="Doar pictogramă (ocupă cel mai puțin loc)" onClick={() => setMode("icon")}><Shrink /></button>
      </div>
      {mode === "open" ? children : null}
    </Tag>
  );
}
