"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { addressLinks, mapLinks } from "@/lib/geo";

/**
 * Harta proprie a unui contor: o hartă mică cu locația lui + butoane care deschid aceeași locație în Google Maps, Waze, Apple Hărți (navigare până acolo) și
 * OpenStreetMap. Fără coordonate: mesaj + (dacă există adresă) căutare după adresă — adresa pleacă spre aplicația aleasă DOAR când apeși butonul.
 * Rotița mouse-ului nu mărește harta până nu dai click pe ea (ca să nu blocheze derularea panoului).
 */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export default function MeterLocation({ lat, lon, name, address }: { lat: number | null; lon: number | null; name: string; address?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || lat === null || lon === null) return;
    const map = L.map(box, { center: [lat, lon], zoom: 17, minZoom: 5, maxZoom: 19, scrollWheelZoom: false, attributionControl: true });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(map);
    L.circleMarker([lat, lon], { radius: 16, stroke: false, fillColor: "#2a78d6", fillOpacity: 0.18 }).addTo(map);
    L.circleMarker([lat, lon], { radius: 8, color: "#ffffff", weight: 3, fillColor: "#2a78d6", fillOpacity: 1 }).addTo(map).bindTooltip(name, { direction: "top", offset: [0, -8] });
    map.once("click", () => map.scrollWheelZoom.enable());
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(box);
    return () => {
      ro.disconnect();
      map.remove();
    };
  }, [lat, lon, name]);

  if (lat === null || lon === null) {
    const a = address ? addressLinks(address) : null;
    return (
      <div>
        <p className="cell-sub" style={{ margin: "0 0 8px" }}>Acest contor nu are coordonate în ThingsBoard (atributele latitude / longitude lipsesc).</p>
        {a && (
          <>
            <p className="cell-sub" style={{ margin: "0 0 6px" }}>Poți căuta după adresă (adresa se trimite către aplicația aleasă doar când apeși butonul):</p>
            <div className="map-btns">
              <a className="btn btn-sm" href={a.google} target="_blank" rel="noopener noreferrer">Google Maps</a>
              <a className="btn btn-sm" href={a.waze} target="_blank" rel="noopener noreferrer">Waze</a>
              <a className="btn btn-sm" href={a.apple} target="_blank" rel="noopener noreferrer">Apple Hărți</a>
            </div>
          </>
        )}
      </div>
    );
  }

  const links = mapLinks(lat, lon);
  const text = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  return (
    <div>
      <div ref={boxRef} className="map-mini" role="application" aria-label={`Locația contorului ${name} pe hartă`} />
      <div className="map-mini-row">
        <span className="mono">{text}</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
          }}
        >
          {copied ? "Copiat ✓" : "Copiază"}
        </button>
      </div>
      <div className="map-btns" role="group" aria-label="Deschide locația în aplicații de navigație">
        <a className="btn btn-sm" href={links.google} target="_blank" rel="noopener noreferrer">Google Maps</a>
        <a className="btn btn-sm" href={links.waze} target="_blank" rel="noopener noreferrer">Waze</a>
        <a className="btn btn-sm" href={links.apple} target="_blank" rel="noopener noreferrer">Apple Hărți</a>
        <a className="btn btn-sm btn-ghost" href={links.osm} target="_blank" rel="noopener noreferrer">OpenStreetMap</a>
      </div>
    </div>
  );
}
