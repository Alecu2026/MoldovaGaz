"use client";

import { useMemo } from "react";
import { KM_EDGES, bandLabel, radiusActive, type GwQuery } from "@/lib/gw-filter";
import { ColumnChart, nf, type Bar } from "./charts/primitives";

/**
 * «Contoare după distanță»: câte contoare aude antena la fiecare distanță (sub 0,5 km, 0,5–1, 1–2, 2–3, 3–5, 5–10, 10–20, peste 20 km). Arată raza de acțiune reală a antenei.
 * Grupele din raza aleasă în filtru rămân pline, restul se estompează; perioada filtrului e deja aplicată de server (se numără contoarele auzite în perioadă).
 */
export default function DistanceChart({ bands, unknown, q, height = 150 }: { bands: number[]; unknown: number; q: GwQuery; height?: number }) {
  const bars: Bar[] = useMemo(() => bands.map((n, i) => ({ label: bandLabel(i), axis: i === 0 ? "<0,5" : i === KM_EDGES.length ? ">20" : String(KM_EDGES[i - 1]).replace(".", ",") + "–" + String(KM_EDGES[i]).replace(".", ","), value: n, ghost: 0 })), [bands]);
  const total = bands.reduce((a, b) => a + b, 0);
  const inBand = (i: number) => {
    const lo = i === 0 ? 0 : KM_EDGES[i - 1], hi = i < KM_EDGES.length ? KM_EDGES[i] : Infinity;
    return hi > q.kmin && lo <= (q.kmax ?? Infinity);
  };
  if (total === 0) return <p className="cell-sub">{unknown > 0 ? `${nf.format(unknown)} contoare fără distanță cunoscută (lipsesc coordonatele).` : "Niciun contor cu distanță cunoscută în perioada aleasă."}</p>;
  return (
    <>
      <ColumnChart bars={bars} unit="contoare" ariaLabel={`Contoare după distanță față de antenă, total ${total}`} height={height} labelWidth={44} selected={radiusActive(q) ? inBand : undefined} />
      {unknown > 0 && <p className="cell-sub" style={{ margin: "4px 0 0" }}>Încă {nf.format(unknown)} contoare fără distanță cunoscută (nu au coordonate) nu apar în grafic.</p>}
    </>
  );
}
