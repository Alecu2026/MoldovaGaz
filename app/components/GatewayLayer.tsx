"use client";

import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { DevGateway, GwDetail, GwDevice, GwState, GwSummary } from "@/lib/services/gateways";

/**
 * Antenele (gateway-uri LoRaWAN) pe hartă, desenate deasupra hărții de contoare:
 *  - fiecare antenă cu poziție este un marcaj colorat după activitate (verde = a auzit ceva în ultima oră, galben = în ultimele 24 h, roșu = offline);
 *  - click pe antenă ⇒ panou cu eficiența ei, ultimele cereri primite prin ea, cel mai apropiat / îndepărtat contor și linii spre contoarele auzite;
 *  - un contor ales pe hartă ⇒ panou cu antenele care îl aud și linii spre ele (cea principală = semnalul cel mai bun).
 * Datele vin din mesajele primite prin integrare (/api/integration/gateways); ora este ora mesajului din rețea, nu ceasul antenei.
 */
const nf = new Intl.NumberFormat("ro-RO");
const STATE_LABEL: Record<GwState, string> = { on: "activă (a auzit ceva în ultima oră)", slow: "lentă (ultimul mesaj acum 1–24 h)", off: "offline (nimic de peste 24 h)" };
const STATE_COLOR: Record<GwState, string> = { on: "#0ca30c", slow: "#fab219", off: "#d03b3b" };
const sigColor = (r: number | null) => (r === null ? "#898781" : r >= -105 ? "#0ca30c" : r >= -115 ? "#fab219" : "#d03b3b");

const pad = (n: number) => String(n).padStart(2, "0");
const when = (ms: number) => {
  if (!(ms > 0)) return "—";
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const ago = (ms: number, now: number) => {
  if (!(ms > 0)) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 90 ? `acum ${s} s` : s < 5400 ? `acum ${Math.round(s / 60)} min` : s < 129_600 ? `acum ${Math.round(s / 3600)} h` : `acum ${Math.round(s / 86_400)} zile`;
};
const km = (x: number | null) => (x === null ? "—" : x < 1 ? `${Math.round(x * 1000)} m` : `${x.toFixed(1).replace(".", ",")} km`);

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const r = await fetch(url, { signal, cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

type Props = {
  map: L.Map | null;
  enabled: boolean;
  /** contorul ales pe hartă (id, nume, poziție) */
  meter: { id: string; name: string; la: number; lo: number } | null;
  onOpen: (id: string) => void;
  /** a fost aleasă o antenă: harta închide popup-ul contorului */
  onPickGateway: () => void;
};

export default function GatewayLayer({ map, enabled, meter, onOpen, onPickGateway }: Props) {
  const [sum, setSum] = useState<GwSummary | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [det, setDet] = useState<GwDetail | null>(null);
  const [detFor, setDetFor] = useState<string | null>(null);
  const [dev, setDev] = useState<{ id: string; list: DevGateway[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const overlay = useRef<HTMLDivElement>(null);
  const lines = useRef<L.LayerGroup | null>(null);

  /* lista antenelor, reîmprospătată la un minut */
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    const load = async () => {
      const s = await getJson<GwSummary>("/api/integration/gateways", ac.signal);
      if (s) { setSum(s); setNow(Date.now()); }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => { ac.abort(); clearInterval(t); };
  }, [enabled]);

  /* marcajele antenelor: butoane într-un strat propriu, DEASUPRA canvasului cu contoare, repoziționate direct în DOM la fiecare mișcare a hărții */
  useEffect(() => {
    const box = overlay.current;
    if (!map || !enabled || !sum || !box) return;
    const place = () => {
      const size = map.getSize();
      for (const el of Array.from(box.children) as HTMLElement[]) {
        const p = map.latLngToContainerPoint([Number(el.dataset.la), Number(el.dataset.lo)]);
        el.style.transform = `translate(${Math.round(p.x - 12)}px, ${Math.round(p.y - 12)}px)`;
        el.style.visibility = p.x < -20 || p.y < -20 || p.x > size.x + 20 || p.y > size.y + 20 ? "hidden" : "visible";
      }
    };
    place();
    map.on("move zoom zoomend resize", place);
    return () => { map.off("move zoom zoomend resize", place); };
  }, [map, enabled, sum]);

  /* detaliile antenei alese */
  useEffect(() => {
    if (!enabled || !sel) { setDet(null); setDetFor(null); return; }
    const ac = new AbortController();
    setDetFor(sel);
    void getJson<GwDetail>(`/api/integration/gateways?id=${encodeURIComponent(sel)}`, ac.signal).then((d) => { if (d) { setDet(d); setNow(Date.now()); } });
    return () => ac.abort();
  }, [enabled, sel]);

  /* antenele contorului ales (și închidem antena aleasă) */
  const meterId = meter?.id ?? null;
  useEffect(() => {
    if (!meterId) { setDev(null); return; }
    setSel(null);
    if (!enabled) return;
    const ac = new AbortController();
    void getJson<{ gateways: DevGateway[] }>(`/api/integration/gateways?device=${encodeURIComponent(meterId)}`, ac.signal).then((d) => { if (d) { setDev({ id: meterId, list: d.gateways }); setNow(Date.now()); } });
    return () => ac.abort();
  }, [enabled, meterId]);

  /* liniile: antenă → contoare, sau contor → antene */
  useEffect(() => {
    if (!map || !enabled) return;
    const grp = L.layerGroup().addTo(map);
    lines.current = grp;
    const bounds: L.LatLngTuple[] = [];
    if (sel && det && detFor === sel && det.gateway.la !== null && det.gateway.lo !== null) {
      const a: L.LatLngTuple = [det.gateway.la, det.gateway.lo];
      bounds.push(a);
      for (const d of det.devices) {
        if (d.la === null || d.lo === null) continue;
        L.polyline([a, [d.la, d.lo]], { color: sigColor(d.rssi), weight: 1.3, opacity: 0.55, interactive: false }).addTo(grp);
        bounds.push([d.la, d.lo]);
      }
      const ring = (d: GwDevice | null, label: string, color: string) => {
        if (!d || d.la === null || d.lo === null) return;
        L.circleMarker([d.la, d.lo], { radius: 9, color, weight: 3, fillOpacity: 0, interactive: true })
          .bindTooltip(`${label}: ${d.name} · ${km(d.km)}`, { direction: "top" })
          .addTo(grp);
      };
      ring(det.nearest, "Cel mai apropiat", "#2a78d6");
      ring(det.farthest, "Cel mai îndepărtat", "#7a3fc9");
    } else if (meter && dev && dev.id === meter.id) {
      const a: L.LatLngTuple = [meter.la, meter.lo];
      bounds.push(a);
      for (const g of dev.list) {
        if (g.la === null || g.lo === null) continue;
        L.polyline([a, [g.la, g.lo]], { color: STATE_COLOR[g.state], weight: g.primary ? 3.5 : 2, opacity: g.primary ? 0.95 : 0.7, dashArray: g.primary ? undefined : "6 6", interactive: false }).addTo(grp);
        bounds.push([g.la, g.lo]);
      }
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13, animate: true });
    return () => { grp.remove(); lines.current = null; };
  }, [map, enabled, sel, det, detFor, meter, dev]);

  if (!enabled) return null;
  const close = () => setSel(null);
  const focus = (la: number | null, lo: number | null) => { if (map && la !== null && lo !== null) map.setView([la, lo], Math.max(map.getZoom(), 14)); };

  const devBlock = (title: string, d: GwDevice | null, color: string) => (
    <div className="gw-dev" style={{ borderLeftColor: color }}>
      <div className="gw-dev-t">{title}</div>
      {d ? (
        <>
          <div className="cell-main">{d.name}</div>
          <div className="gw-kv">
            <span>Distanță</span><b>{km(d.km)}</b>
            <span>Semnal</span><b>{d.rssi !== null ? `${d.rssi} dBm` : "—"}{d.snr !== null ? ` · SNR ${d.snr}` : ""}</b>
            <span>Mesaje prin antenă</span><b>{nf.format(d.n)}</b>
            <span>Ultimul mesaj</span><b>{when(d.last)}</b>
            <span>Volum</span><b>{d.volume !== null ? `${nf.format(d.volume)} m³` : "—"}</b>
          </div>
          <div className="map-btns">
            <button type="button" className="btn btn-sm" onClick={() => onOpen(d.id)}>Detalii</button>
            <button type="button" className="btn btn-sm" onClick={() => focus(d.la, d.lo)} disabled={d.la === null}>Pe hartă</button>
          </div>
        </>
      ) : (
        <div className="cell-sub">Nu se poate calcula (lipsesc coordonatele antenei sau ale contoarelor).</div>
      )}
    </div>
  );

  return (
    <>
      {sum && (
        <div ref={overlay} className="gw-overlay">
          {sum.rows.filter((g) => g.la !== null && g.lo !== null).map((g) => (
            <button key={g.id} type="button" data-la={g.la ?? 0} data-lo={g.lo ?? 0} className={`gw-pin gw-${g.state}${g.id === sel ? " gw-sel" : ""}`} title={`${g.name} · ${nf.format(g.devices)} contoare`} aria-label={`Antenă ${g.name}, ${nf.format(g.devices)} contoare`} onClick={() => { setSel(g.id); onPickGateway(); }}>
              <span />
            </button>
          ))}
        </div>
      )}
      {sum && (
        <div className="gw-legend" aria-label="Legenda antenelor">
          <div className="gw-leg-t">Antene: {nf.format(sum.located)} pe hartă din {nf.format(sum.total)}</div>
          {(["on", "slow", "off"] as const).map((s) => (
            <div key={s} className="map-leg-row">
              <span className={`gw-dot gw-${s}`} aria-hidden="true" />
              <span>{s === "on" ? "Activă (< 1 h)" : s === "slow" ? "Lentă (< 24 h)" : "Offline (> 24 h)"}</span>
              <span className="mono">{nf.format(sum[s])}</span>
            </div>
          ))}
          {sum.total > sum.located && <div className="cell-sub">{nf.format(sum.total - sum.located)} antene fără poziție validă (0, 0) nu pot fi puse pe hartă.</div>}
        </div>
      )}

      {sel && (
        <aside className="gw-panel" aria-label="Detalii antenă">
          <button type="button" className="map-x" aria-label="Închide" onClick={close}>×</button>
          {det && detFor === sel ? (
            <>
              <div className="cell-main" style={{ paddingRight: 20 }}>{det.gateway.name}</div>
              <div className="cell-sub">
                <span className={`gw-dot gw-${det.gateway.state}`} aria-hidden="true" /> {STATE_LABEL[det.gateway.state]} · ultimul mesaj {when(det.gateway.last)} ({ago(det.gateway.last, now)})
              </div>
              <div className="gw-stats">
                <div><b>{nf.format(det.gateway.devices)}</b><span>contoare auzite</span></div>
                <div><b>{nf.format(det.gateway.primary)}</b><span>pentru care e principală</span></div>
                <div><b>{nf.format(det.gateway.exclusive)}</b><span>auzite doar de ea</span></div>
                <div><b>{nf.format(det.gateway.n)}</b><span>mesaje</span></div>
                <div><b>{det.gateway.rssi ?? "—"}</b><span>RSSI mediu (dBm)</span></div>
                <div><b>{det.gateway.snr ?? "—"}</b><span>SNR mediu</span></div>
              </div>
              {det.gateway.la === null && <div className="cell-sub" style={{ margin: "6px 0" }}>Antena nu are poziție validă, deci distanțele nu se pot calcula.</div>}

              {devBlock("Cel mai apropiat contor", det.nearest, "#2a78d6")}
              {devBlock("Cel mai îndepărtat contor", det.farthest, "#7a3fc9")}
              {det.strongest && det.weakest && det.strongest.id !== det.nearest?.id && (
                <div className="cell-sub" style={{ margin: "6px 0" }}>
                  Cel mai bun semnal: {det.strongest.name} ({det.strongest.rssi} dBm) · cel mai slab: {det.weakest.name} ({det.weakest.rssi} dBm)
                </div>
              )}

              <div className="gw-sec">Ultimele cereri primite prin antenă</div>
              <div className="gw-recent">
                <table>
                  <thead><tr><th>Ora</th><th>Contor</th><th>RSSI</th><th>SNR</th><th>Tip</th></tr></thead>
                  <tbody>
                    {det.recent.map((r, k) => (
                      <tr key={k}>
                        <td className="mono">{when(r.t).slice(11)}<div className="cell-sub">{when(r.t).slice(0, 10)}</div></td>
                        <td><button type="button" className="link-btn" onClick={() => onOpen(r.m)}>{r.name}</button></td>
                        <td className="mono">{r.rssi ?? "—"}</td>
                        <td className="mono">{r.snr ?? "—"}</td>
                        <td>{r.ie ?? "—"}</td>
                      </tr>
                    ))}
                    {det.recent.length === 0 && <tr><td colSpan={5} className="cell-sub">Nicio cerere încă.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="cell-sub">Liniile de pe hartă merg spre {nf.format(det.devices.length)} contoare (verde = semnal bun, galben = mediu, roșu = slab).</div>
            </>
          ) : (
            <div className="cell-sub">Se încarcă…</div>
          )}
        </aside>
      )}

      {!sel && meter && dev && dev.id === meter.id && (
        <aside className="gw-panel gw-panel-sm" aria-label="Antenele contorului">
          <div className="cell-main">Antene pentru {meter.name}</div>
          {dev.list.length === 0 ? (
            <div className="cell-sub">Nu avem încă mesaje primite prin integrare pentru acest contor, deci nu știm ce antene îl aud.</div>
          ) : (
            <ul className="gw-list">
              {dev.list.map((g) => (
                <li key={g.id}>
                  <button type="button" className="link-btn" onClick={() => { setSel(g.id); onPickGateway(); }}>{g.name}</button>
                  {g.primary && <span className="gw-badge">principală</span>}
                  <div className="cell-sub">
                    <span className={`gw-dot gw-${g.state}`} aria-hidden="true" /> {km(g.km)} · {g.rssi !== null ? `${g.rssi} dBm` : "fără RSSI"}{g.snr !== null ? ` · SNR ${g.snr}` : ""} · {nf.format(g.n)} mesaje · ultimul {when(g.last)}
                    {g.la === null ? " · fără poziție" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </>
  );
}
