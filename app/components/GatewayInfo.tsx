"use client";

import type { GwDetail, GwDevice, GwState } from "@/lib/services/gateways";

/**
 * Informațiile unei antene, ca în panoul de pe hartă: stare și ultimul mesaj, contoare auzite / pentru care e principală / auzite doar de ea, mesaje, RSSI / SNR mediu,
 * cel mai apropiat și cel mai îndepărtat contor, cel mai bun / slab semnal și ultimele cereri primite prin antenă. Folosită în popup-ul din Grafice.
 */
export const nf = new Intl.NumberFormat("ro-RO");
export const STATE_LABEL: Record<GwState, string> = { on: "activă (a auzit ceva în ultima oră)", slow: "lentă (ultimul mesaj acum 1–24 h)", off: "offline (nimic de peste 24 h)" };
export const STATE_COLOR: Record<GwState, string> = { on: "#0ca30c", slow: "#fab219", off: "#d03b3b" };
export const sigColor = (r: number | null) => (r === null ? "#898781" : r >= -105 ? "#0ca30c" : r >= -115 ? "#fab219" : "#d03b3b");

const pad = (n: number) => String(n).padStart(2, "0");
export const when = (ms: number) => {
  if (!(ms > 0)) return "—";
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const ago = (ms: number, now: number) => {
  if (!(ms > 0)) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 90 ? `acum ${s} s` : s < 5400 ? `acum ${Math.round(s / 60)} min` : s < 129_600 ? `acum ${Math.round(s / 3600)} h` : `acum ${Math.round(s / 86_400)} zile`;
};
export const km = (x: number | null) => (x === null ? "—" : x < 1 ? `${Math.round(x * 1000)} m` : `${x.toFixed(1).replace(".", ",")} km`);

function DevBlock({ title, d, color, onOpen }: { title: string; d: GwDevice | null; color: string; onOpen: (id: string) => void }) {
  return (
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
          </div>
        </>
      ) : (
        <div className="cell-sub">Nu se poate calcula (lipsesc coordonatele antenei sau ale contoarelor).</div>
      )}
    </div>
  );
}

export default function GatewayInfo({ det, now, onOpen }: { det: GwDetail; now: number; onOpen: (id: string) => void }) {
  const g = det.gateway;
  return (
    <>
      <div className="cell-sub">
        <span className={`gw-dot gw-${g.state}`} aria-hidden="true" /> {STATE_LABEL[g.state]} · ultimul mesaj {when(g.last)} ({ago(g.last, now)})
      </div>
      <div className="gw-stats">
        <div><b>{nf.format(g.devices)}</b><span>contoare auzite</span></div>
        <div><b>{nf.format(g.primary)}</b><span>pentru care e principală</span></div>
        <div><b>{nf.format(g.exclusive)}</b><span>auzite doar de ea</span></div>
        <div><b>{nf.format(g.n)}</b><span>mesaje</span></div>
        <div><b>{g.rssi ?? "—"}</b><span>RSSI mediu (dBm)</span></div>
        <div><b>{g.snr ?? "—"}</b><span>SNR mediu</span></div>
      </div>
      {g.la === null && <div className="cell-sub" style={{ margin: "6px 0" }}>Antena nu are poziție validă (0, 0 sau în afara Moldovei), deci distanțele nu se pot calcula.</div>}

      <DevBlock title="Cel mai apropiat contor" d={det.nearest} color="#2a78d6" onOpen={onOpen} />
      <DevBlock title="Cel mai îndepărtat contor" d={det.farthest} color="#7a3fc9" onOpen={onOpen} />
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
    </>
  );
}
