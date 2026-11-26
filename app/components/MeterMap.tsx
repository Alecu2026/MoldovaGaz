"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { samePlace, boundsOf, buildClusters, latFromY, lonFromX, mapLinks, worldSize, type Clusters } from "@/lib/geo";
import { FLAG, PROBLEM_FLAGS } from "@/lib/meter-shared";
import type { MeterStore } from "@/lib/meter-store";
import GatewayLayer from "./GatewayLayer";
import MapCard, { IcoMeter, type CardMode } from "./MapCard";

/**
 * Harta tuturor contoarelor filtrate. Optimizare:
 *  - Leaflet face doar harta de bază (dale, deplasare, zoom, gesturi); punctele NU sunt elemente DOM / markere Leaflet, ci se desenează pe UN SINGUR canvas;
 *  - punctele se grupează în bule într-o singură trecere pe vectori tipizați (lib/geo.ts), doar la schimbarea zoom-ului sau a filtrelor (~2 ms la 44.000 de puncte);
 *    celulele sunt ancorate în „lume”, deci la deplasare bulele nu se recalculează, se desenează doar cele din ecran;
 *  - cursorul / tooltip-ul / popup-ul se mută direct în DOM, fără re-randări React la fiecare cadru.
 * Dalele vin de la OpenStreetMap (https://tile.openstreetmap.org); fără internet harta de bază rămâne goală, dar punctele se văd în continuare.
 */
type ColorBy = "status" | "rssi" | "fresh" | "battery";
const COLOR_OPTIONS: [ColorBy, string][] = [["status", "Stare"], ["rssi", "Semnal (RSSI)"], ["fresh", "Ultima citire"], ["battery", "Baterie"]];
/** bun · atenție · critic · necunoscut (paleta de stare; semnificația fiecărei culori e scrisă în legendă și în popup) */
const PALETTE = ["#0ca30c", "#fab219", "#d03b3b", "#898781"] as const;
const LABELS: Record<ColorBy, [string, string, string, string]> = {
  status: ["OK (raport de stare fără probleme)", "Inactiv în SCADA", "Probleme: baterie / buton / magnet", "Fără raport de stare"],
  rssi: ["Semnal bun (≥ −105 dBm)", "Semnal mediu (−105 … −115 dBm)", "Semnal slab (< −115 dBm)", "Fără semnal raportat"],
  fresh: ["Citire în ultimele 24 h", "Citire acum 1–7 zile", "Citire mai veche de 7 zile", "Fără nicio citire"],
  battery: ["Baterie ≥ 50%", "Baterie 20–50%", "Baterie < 20%", "Fără valoare"],
};
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const CELL = 46; // px (la zoom 17 și peste nu se mai grupează)
const NO_CLUSTER_ZOOM = 17;
const ACCENT = "#2a78d6";

const nf = new Intl.NumberFormat("ro-RO");
const dt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function catOf(st: MeterStore, i: number, by: ColorBy, now: number): 0 | 1 | 2 | 3 {
  switch (by) {
    case "status": {
      const f = st.fl[i];
      if (f & PROBLEM_FLAGS) return 2;
      if (f & FLAG.INACTIVE) return 1;
      return f & FLAG.STATUS ? 0 : 3;
    }
    case "rssi": {
      const r = st.rssi[i];
      return r !== r ? 3 : r >= -105 ? 0 : r >= -115 ? 1 : 2;
    }
    case "fresh": {
      const t = st.ts[i];
      if (!(t > 0)) return 3;
      const a = now - t;
      return a < 86_400_000 ? 0 : a < 7 * 86_400_000 ? 1 : 2;
    }
    default: {
      const b = st.bat[i];
      return b !== b ? 3 : b >= 50 ? 0 : b >= 20 ? 1 : 2;
    }
  }
}

/** raza bulei (px): maximum 21, mai mică decât jumătatea celulei (23), ca bulele vecine să nu se suprapună */
/** Raza bulei = doar cât să încapă numărul (cifre ~6,7 px, punct ~3 px, «K» ~7,5 px la fontul de 11 px) plus puțin aer — fără bule mari, indiferent câte contoare cuprind. */
const clusterRadius = (n: number): number => {
  let w = 0;
  for (const ch of compactCount(n)) w += ch === "." ? 3 : ch === "K" ? 7.5 : 6.7;
  return Math.max(8.5, w / 2 + 4.5);
};

const compactCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(".0", "")}K` : String(n));

type Props = {
  store: MeterStore;
  /** indecșii contoarelor filtrate */
  idx: Int32Array;
  /** crește când lista se modifică pe loc */
  rev: number;
  /** se schimbă când se schimbă filtrele: harta se încadrează pe rezultate */
  fitKey: string;
  onOpen: (id: string) => void;
  /** stratul cu toate antenele (doar administratorii; un utilizator limitat nu vede antenele altor zone) */
  antennas: false | "full" | "basic";
};

export default function MeterMap({ store, idx, rev, fitKey, onOpen, antennas }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [sideEl, setSideEl] = useState<HTMLDivElement | null>(null);
  /** cardul contorului strâns / deschis: se păstrează între contoare și NU deselectează contorul (liniile spre antene rămân) */
  const [popMode, setPopMode] = useState<CardMode>("open");
  /** contoarele din ACELAȘI loc (aceleași coordonate): zoom-ul nu le poate despărți, deci se aleg dintr-o listă */
  const [group, setGroup] = useState<number[] | null>(null);
  const [grpMode, setGrpMode] = useState<CardMode>("open");
  const mapRef = useRef<L.Map | null>(null);
  const [by, setBy] = useState<ColorBy>("status");
  const [sel, setSel] = useState<number | null>(null);
  const [mapObj, setMapObj] = useState<L.Map | null>(null);
  const [gwOn, setGwOn] = useState(!!antennas);
  const [legendOn, setLegendOn] = useState(true);
  const [metersOn, setMetersOn] = useState(true);
  const [full, setFull] = useState(false);
  const [pseudo, setPseudo] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  // alegerea unei antene NU deselectează contorul: ca să se vadă linia dintre ele, contorul rămâne ales (cardul lui se poate strânge)
  const pickGateway = useCallback(() => undefined, []);
  const closeLegend = useCallback(() => setLegendOn(false), []);

  /* ecran complet: API-ul browserului (Esc iese); unde nu există (ex. iPhone), harta acoperă pagina */
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement !== null && document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!pseudo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPseudo(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pseudo]);
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 120);
    return () => clearTimeout(t);
  }, [full, pseudo]);
  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (full || pseudo) {
      setPseudo(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setPseudo(true));
    else setPseudo(true);
  };
  // starea citită de funcția de desenare (se actualizează în efecte, nu la randare)
  const live = useRef({ store, idx, by, now, sel: null as number | null, metersOn: true });
  const cache = useRef<{ zoom: number; cl: Clusters }[]>([]);
  const raf = useRef(0);

  /* ───── câte puncte, cu coordonate, și cum se împart pe culori ───── */
  const stats = useMemo(() => {
    const cats = [0, 0, 0, 0];
    let withGeo = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (store.la[i] !== store.la[i] || store.lo[i] !== store.lo[i]) continue;
      withGeo++;
      cats[catOf(store, i, by, now)]++;
    }
    return { withGeo, cats, without: idx.length - withGeo };
  }, [store, idx, by, now, rev]); // eslint-disable-line react-hooks/exhaustive-deps -- `rev` = lista s-a modificat pe loc

  /* ───── desenare ───── */
  const draw = useCallback(() => {
    raf.current = 0;
    const map = mapRef.current, canvas = canvasRef.current;
    if (!map || !canvas) return;
    const { store: st, idx: ix, by: color, now: t, sel: selected, metersOn: showMeters } = live.current;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size.x * dpr) || canvas.height !== Math.round(size.y * dpr)) {
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const z = map.getZoom();
    let cl = cache.current.find((c) => c.zoom === z)?.cl;
    if (!cl) {
      cl = buildClusters(st.la, st.lo, ix, z, z >= NO_CLUSTER_ZOOM ? 0 : CELL);
      cache.current = [{ zoom: z, cl }, ...cache.current].slice(0, 4);
    }
    const c0 = map.project(map.getCenter(), z);
    const ox = c0.x - size.x / 2, oy = c0.y - size.y / 2;
    const big = z >= 15 ? 6.5 : 5;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = "#ffffff";
    for (let c = 0; c < (showMeters ? cl.n : 0); c++) { // contoarele ascunse: rămân doar antenele
      const sx = cl.x[c] - ox, sy = cl.y[c] - oy;
      if (sx < -30 || sx > size.x + 30 || sy < -30 || sy > size.y + 30) continue;
      const n = cl.cnt[c];
      ctx.beginPath();
      if (n === 1) {
        ctx.arc(sx, sy, big, 0, 6.2832);
        ctx.fillStyle = PALETTE[catOf(st, cl.rep[c], color, t)];
        ctx.fill();
        ctx.stroke();
      } else {
        const r = clusterRadius(n);
        ctx.arc(sx, sy, r, 0, 6.2832);
        ctx.fillStyle = "rgba(42,120,214,0.88)";
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(compactCount(n), sx, sy + 0.5);
      }
    }
    // contorul ales rămâne marcat pe hartă (cardul lui e în dreapta sus și se poate strânge)
    if (selected !== null && showMeters && st.la[selected] === st.la[selected]) {
      const p = map.latLngToContainerPoint([st.la[selected], st.lo[selected]]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, big + 5, 0, 6.2832);
      ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = "#2a78d6"; ctx.stroke();
    }
  }, []);

  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  }, [draw]);

  /* ───── cel mai apropiat punct / bulă sub cursor ───── */
  const hitTest = useCallback((px: number, py: number): { c: number; cl: Clusters; r: number } | null => {
    const map = mapRef.current;
    if (!map || !live.current.metersOn) return null;
    const cl = cache.current.find((c) => c.zoom === map.getZoom())?.cl;
    if (!cl) return null;
    const size = map.getSize();
    const c0 = map.project(map.getCenter(), cl.zoom);
    const ox = c0.x - size.x / 2, oy = c0.y - size.y / 2;
    let best = -1, bestD = Infinity, bestR = 0;
    const single = cl.zoom >= 15 ? 6.5 : 5;
    for (let c = 0; c < cl.n; c++) {
      const dx = cl.x[c] - ox - px, dy = cl.y[c] - oy - py;
      if (dx > 30 || dx < -30 || dy > 30 || dy < -30) continue;
      const r = (cl.cnt[c] === 1 ? single : clusterRadius(cl.cnt[c])) + 3;
      const d = dx * dx + dy * dy;
      if (d <= r * r && d < bestD) { best = c; bestD = d; bestR = r; }
    }
    return best < 0 ? null : { c: best, cl, r: bestR };
  }, []);

  /* ───── harta (o singură dată) ───── */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const map = L.map(box, { center: [46.9, 28.5], zoom: 8, minZoom: 5, maxZoom: 19, zoomControl: true, preferCanvas: true, worldCopyJump: false });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(map);
    mapRef.current = map;
    setMapObj(map);

    const onMove = () => schedule();
    const onZoomStart = () => {
      const c = canvasRef.current;
      if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height); // în timpul animației de zoom punctele ar rămâne în urma dalelor
    };
    map.on("move", onMove);
    map.on("zoomend", onMove);
    map.on("zoomstart", onZoomStart);
    map.on("resize", onMove);

    let hoverRaf = 0;
    const tip = tipRef.current;
    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const h = hitTest(e.containerPoint.x, e.containerPoint.y);
        box.style.cursor = h ? "pointer" : "";
        if (!tip) return;
        if (!h) { tip.style.display = "none"; return; }
        const n = h.cl.cnt[h.c];
        const st = live.current.store;
        tip.textContent = n > 1 ? (h.cl.zoom >= NO_CLUSTER_ZOOM ? `${nf.format(n)} contoare în același loc — click ca să vezi lista` : `${nf.format(n)} contoare — click ca să mărești`) : `${st.nm[h.cl.rep[h.c]]} · ${st.dict.br[st.br[h.cl.rep[h.c]]] ?? ""}`;
        tip.style.display = "block";
        tip.style.transform = `translate(${Math.round(e.containerPoint.x + 14)}px, ${Math.round(e.containerPoint.y + 14)}px)`;
      });
    };
    const onMouseOut = () => { if (tip) tip.style.display = "none"; };
    const onClick = (e: L.LeafletMouseEvent) => {
      const h = hitTest(e.containerPoint.x, e.containerPoint.y);
      if (!h) { setSel(null); setGroup(null); return; }
      const size = worldSize(h.cl.zoom);
      if (h.cl.cnt[h.c] > 1 && h.cl.zoom >= NO_CLUSTER_ZOOM) {
        // la zoom maxim, o bulă = contoare din același loc: lista lor (zoom-ul nu ajută)
        const st = live.current.store;
        setGroup(samePlace(st.la, st.lo, live.current.idx, h.cl.rep[h.c])); setGrpMode("open"); setSel(null);
      } else if (h.cl.cnt[h.c] > 1) {
        map.setView([latFromY(h.cl.y[h.c], size), lonFromX(h.cl.x[h.c], size)], Math.min(map.getMaxZoom(), map.getZoom() + 2));
      } else {
        setGroup(null);
        setSel(h.cl.rep[h.c]);
      }
    };
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("click", onClick);

    const ro = new ResizeObserver(() => { map.invalidateSize(); schedule(); });
    ro.observe(box);
    schedule();
    return () => {
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      raf.current = 0;
      map.remove();
      mapRef.current = null;
      setMapObj(null);
    };
  }, [schedule, hitTest]);

  /* ───── date / culoare / selecție noi ⇒ redesenare ───── */
  useEffect(() => {
    live.current = { store, idx, by, now, sel, metersOn };
    cache.current = []; // bulele depind de rândurile filtrate
    schedule();
  }, [store, idx, by, now, sel, rev, metersOn, schedule]);

  /* ───── încadrare pe rezultate: la prima afișare și când se schimbă filtrele ───── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = boundsOf(store.la, store.lo, idx);
    if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [36, 36], maxZoom: 16, animate: false });
    setSel(null); setGroup(null);
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps -- doar la schimbarea filtrelor, nu la fiecare actualizare live

  const fit = () => {
    const b = boundsOf(store.la, store.lo, idx);
    if (b && mapRef.current) mapRef.current.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [36, 36], maxZoom: 16 });
  };

  const picked = sel !== null ? store.view(sel) : null;
  const links = picked && picked.lat !== null && picked.lon !== null ? mapLinks(picked.lat, picked.lon) : null;
  const pid = picked?.id ?? null, pname = picked?.name ?? "", plat = picked?.lat ?? null, plon = picked?.lon ?? null;

  return (
    <div ref={wrapRef} className={`mapwrap${pseudo ? " map-pseudo" : ""}`}>
      <div className="map-bar">
        <label className="field" style={{ width: 190 }}>
          <span>Colorează punctele după</span>
          <select className="select cf-in" value={by} onChange={(e) => setBy(e.target.value as ColorBy)} style={{ height: 34 }}>
            {COLOR_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={fit} disabled={stats.withGeo === 0}>
          Încadrează rezultatele
        </button>
        <label className="chk" style={{ alignSelf: "center" }}>
          <input type="checkbox" checked={metersOn} onChange={(e) => { setMetersOn(e.target.checked); if (!e.target.checked) setSel(null); }} /> Arată contoarele
        </label>
        {antennas && (
          <label className="chk" style={{ alignSelf: "center" }}>
            <input type="checkbox" checked={gwOn} onChange={(e) => setGwOn(e.target.checked)} /> Arată antenele
          </label>
        )}
        <label className="chk" style={{ alignSelf: "center" }}>
          <input type="checkbox" checked={legendOn} onChange={(e) => setLegendOn(e.target.checked)} /> Legendă
        </label>
        <button type="button" className="btn" onClick={toggleFull} aria-pressed={full || pseudo}>
          {full || pseudo ? "Ieși din ecranul complet" : "Ecran complet"}
        </button>
        <div className="map-count" role="status" aria-live="polite">
          <strong>{nf.format(stats.withGeo)}</strong> contoare pe hartă
          {stats.without > 0 && <span className="cell-sub"> · {nf.format(stats.without)} filtrate fără coordonate (nu apar pe hartă)</span>}
        </div>
      </div>

      <div className="map-stage">
        <div ref={boxRef} className="map-leaflet" role="application" aria-label="Harta contoarelor. Pentru lista contoarelor folosește fila Tabel." />
        <canvas ref={canvasRef} className="map-points" aria-hidden="true" />
        <div ref={tipRef} className="map-tip" style={{ display: "none" }} />

        {stats.withGeo === 0 && (
          <div className="map-empty">
            <strong>Niciun contor filtrat nu are coordonate</strong>
            <span>Coordonatele vin din atributele latitude / longitude din SCADA.</span>
          </div>
        )}

        {legendOn && metersOn && (
        <div className="map-legend" aria-label="Legendă">
          <button type="button" className="map-x" aria-label="Închide legenda" onClick={closeLegend}>×</button>
          {LABELS[by].map((l, k) => (
            <div key={l} className="map-leg-row">
              <span className="map-dot" style={{ background: PALETTE[k] }} aria-hidden="true" />
              <span>{l}</span>
              <span className="mono">{nf.format(stats.cats[k])}</span>
            </div>
          ))}
          <div className="map-leg-row">
            <span className="map-dot" style={{ background: ACCENT }} aria-hidden="true" />
            <span>Grup de contoare (click = zoom)</span>
          </div>
        </div>
        )}

        <GatewayLayer
          map={mapObj}
          enabled={gwOn && !!antennas}
          basic={antennas === "basic"}
          meterId={pid} meterName={pname} meterLa={plat} meterLo={plon}
          onOpen={onOpen}
          onPickGateway={pickGateway}
          legend={legendOn}
          onCloseLegend={closeLegend}
          sideEl={sideEl}
        />

        <div ref={setSideEl} className="map-side">
          {group && group.length > 0 && (
          <MapCard mode={grpMode} setMode={setGrpMode} icon={<IcoMeter />} label={`${group.length} contoare în același loc`} className="map-popup" role="dialog"
            title={`${nf.format(group.length)} contoare în același loc`} sub="aceleași coordonate (de ex. o clădire): alege unul">
            <ul className="map-grp">
              {group.slice(0, 300).map((i) => (
                <li key={i}>
                  <button type="button" className={`map-grp-b${sel === i ? " on" : ""}`} onClick={() => { setSel(i); setPopMode("open"); }}>
                    <span className="cell-main">{store.nm[i]}</span>
                    <span className="cell-sub">{store.ts[i] > 0 ? dt(store.ts[i]) : "fără citiri"}</span>
                  </button>
                </li>
              ))}
            </ul>
            {group.length > 300 && <div className="cell-sub">Primele 300 din {nf.format(group.length)}.</div>}
            <div className="map-btns"><button type="button" className="btn btn-sm" onClick={() => { setGroup(null); setSel(null); }}>Închide lista</button></div>
          </MapCard>
          )}
          {picked && (
          <MapCard mode={popMode} setMode={setPopMode} icon={<IcoMeter />} label={`Contor ${picked.name}`} className="map-popup" role="dialog"
            title={picked.name} sub={[picked.branch, picked.city && picked.city !== "—" ? picked.city : ""].filter(Boolean).join(" · ")}>
            <dl className="kv" style={{ gridTemplateColumns: "92px 1fr", margin: "8px 0", fontSize: 12.5 }}>
              <dt>Ultima citire</dt><dd>{picked.ts > 0 ? dt(picked.ts) : "—"}</dd>
              <dt>Volume</dt><dd className="mono">{picked.val !== null ? `${nf.format(picked.val)} m³` : "—"}</dd>
              <dt>Semnal</dt><dd className="mono">{picked.rssi !== null ? `${picked.rssi} dBm` : "—"}</dd>
              <dt>Baterie</dt><dd className="mono">{picked.bat !== null ? `${Math.round(picked.bat)}%` : "—"}</dd>
              <dt>Culoare</dt>
              <dd>{LABELS[by][catOf(store, sel as number, by, now)]}</dd>
            </dl>
            <div className="map-btns">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpen(picked.id)}>
                Detalii
              </button>
              {links && (
                <>
                  <a className="btn btn-sm" href={links.google} target="_blank" rel="noopener noreferrer">Google Maps</a>
                  <a className="btn btn-sm" href={links.waze} target="_blank" rel="noopener noreferrer">Waze</a>
                  <a className="btn btn-sm" href={links.apple} target="_blank" rel="noopener noreferrer">Apple Hărți</a>
                </>
              )}
            </div>
            <div className="map-btns"><button type="button" className="btn btn-sm" onClick={() => setSel(null)}>Deselectează contorul</button></div>
          </MapCard>
          )}
        </div>
      </div>
    </div>
  );
}
