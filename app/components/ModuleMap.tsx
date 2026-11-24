"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";

/** Widgetul „Module Location” din SCADA: harta OpenStreetMap cu locul contorului ales (marker cu numele și ultima citire). Fără contor / fără coordonate: harta Moldovei. */
const TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export default function ModuleMap({ name, label, la, lo }: { name: string; label: string; la: number | null; lo: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const has = la !== null && lo !== null;
    const map = L.map(el, { center: has ? [la, lo] : [47.0, 28.5], zoom: has ? 17 : 7, minZoom: 3, maxZoom: 19 });
    L.tileLayer(TILE, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(map);
    if (has) L.circleMarker([la, lo], { radius: 9, color: "#ffffff", weight: 3, fillColor: "#01695c", fillOpacity: 1 }).bindTooltip(label || name, { permanent: true, direction: "top", offset: [0, -8] }).addTo(map);
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => { ro.disconnect(); map.remove(); };
  }, [name, label, la, lo]);
  return <div ref={box} className="tbx-map" role="application" aria-label="Module Location" />;
}
