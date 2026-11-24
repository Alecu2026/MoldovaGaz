"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";
import type { GwState } from "@/lib/services/gateways";
import { STATE_COLOR, sigColor } from "./GatewayInfo";

/**
 * Harta mică a unei antene (în popup-ul din Grafice): antena (cerc mare, colorat după stare) și toate contoarele cu care comunică (puncte colorate după semnal:
 * verde bun, galben mediu, roșu slab), unite cu antena prin linii subțiri. Harta se încadrează pe toate punctele; rotița, butoanele +/−, dublu-click și pinch-ul măresc / micșorează harta.
 */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export type MapDevice = { id: string; name: string; la: number; lo: number; rssi: number | null; km: number | null };
const MAX_LINES = 500;

export default function AntennaMap({ name, la, lo, state, devices, onOpen }: { name: string; la: number | null; lo: number | null; state: GwState; devices: MapDevice[]; onOpen: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  useEffect(() => { open.current = onOpen; }, [onOpen]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const map = L.map(el, { center: [la ?? 47.0, lo ?? 28.5], zoom: 9, minZoom: 5, maxZoom: 19, zoomControl: true, scrollWheelZoom: true, doubleClickZoom: true, touchZoom: true, boxZoom: true, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(map);
    const pts: L.LatLngTuple[] = [];
    if (la !== null && lo !== null) {
      const a: L.LatLngTuple = [la, lo];
      pts.push(a);
      devices.slice(0, MAX_LINES).forEach((d) => L.polyline([a, [d.la, d.lo]], { color: sigColor(d.rssi), weight: 1, opacity: 0.35, interactive: false }).addTo(map));
    }
    for (const d of devices) {
      pts.push([d.la, d.lo]);
      L.circleMarker([d.la, d.lo], { radius: 4.5, color: "#ffffff", weight: 1, fillColor: sigColor(d.rssi), fillOpacity: 0.95 })
        .bindTooltip(`${d.name}${d.km !== null ? ` · ${d.km < 1 ? `${Math.round(d.km * 1000)} m` : `${d.km.toFixed(1)} km`}` : ""}${d.rssi !== null ? ` · ${d.rssi} dBm` : ""}`, { direction: "top" })
        .on("click", () => open.current(d.id))
        .addTo(map);
    }
    if (la !== null && lo !== null) L.circleMarker([la, lo], { radius: 10, color: "#ffffff", weight: 3, fillColor: STATE_COLOR[state], fillOpacity: 1 }).bindTooltip(name, { direction: "top", permanent: false }).addTo(map);
    if (pts.length > 1) map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
    else if (pts.length === 1) map.setView(pts[0], 14);
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => { ro.disconnect(); map.remove(); };
  }, [name, la, lo, state, devices]);

  return <div ref={box} className="gw-minimap" role="application" aria-label={`Harta antenei ${name} și a contoarelor ei`} />;
}
