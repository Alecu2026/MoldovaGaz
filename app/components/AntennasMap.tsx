"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";
import type { AntennaRow } from "@/lib/antennas";
import { fdtA } from "@/lib/antennas";

/**
 * „Harta_Instalator” din SCADA: toate antenele pe harta OpenStreetMap, verzi (active) sau roșii (nu mai aud nimic), cu numele și ultima activitate la trecerea cursorului;
 * apăsarea pe o antenă o alege (ca rândul din tabel), iar antena aleasă are un inel în jurul punctului. Doar antenele cu locație valabilă apar.
 * Harta se creează o singură dată; punctele se redesenează când se schimbă lista sau alegerea (fără animații, ca să nu se strice la schimbări rapide).
 */
const TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export default function AntennasMap({ rows, selected, onPick, follow = true }: { rows: AntennaRow[]; selected: string | null; onPick: (id: string) => void; /** harta se mută pe antena aleasă (din tabel); la alegere de pe hartă — nu */ follow?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const lastSel = useRef<string | null>(null);
  const pick = useRef(onPick);
  useEffect(() => { pick.current = onPick; });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const m = L.map(el, { center: [47.0, 28.5], zoom: 7, minZoom: 3, maxZoom: 19, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    L.tileLayer(TILE, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el);
    return () => { ro.disconnect(); m.remove(); map.current = null; layer.current = null; fitted.current = false; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts: L.LatLngTuple[] = [];
    for (const r of rows) {
      if (r.latitude === null || r.longitude === null) continue;
      const on = r.id === selected;
      const c = L.circleMarker([r.latitude, r.longitude], { radius: on ? 10 : 7, color: on ? "#01695c" : "#ffffff", weight: on ? 4 : 2, fillColor: r.active ? "#2e7d32" : "#d32f2f", fillOpacity: 1 });
      c.bindTooltip(`${r.name || r.id}<br/>${fdtA(r.last) || "—"}`, { direction: "top", offset: [0, -6] });
      c.on("click", () => pick.current(r.id));
      c.addTo(g);
      pts.push([r.latitude, r.longitude]);
    }
    const sel = rows.find((r) => r.id === selected && r.latitude !== null && r.longitude !== null);
    // se mută pe antenă doar când alegerea SE SCHIMBĂ din tabel (nu la fiecare reîmprospătare a listei și nu la click pe hartă)
    if (sel) { if (follow && lastSel.current !== selected) m.setView([sel.latitude as number, sel.longitude as number], Math.max(m.getZoom(), 12), { animate: false }); }
    else if (pts.length && !fitted.current) { m.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 12, animate: false }); fitted.current = true; }
    lastSel.current = selected;
  }, [rows, selected, follow]);

  return <div ref={box} className="tbx-map" role="application" aria-label="Harta_Instalator" />;
}
