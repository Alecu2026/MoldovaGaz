"use client";

import { useEffect, useState } from "react";
import type { DevGateway } from "@/lib/services/gateways";

/**
 * „Trimite date către”: antenele (gateway-uri LoRaWAN) care au auzit contorul, cu săgeată de la contor spre fiecare antenă (cea cu semnalul cel mai bun = principală).
 * Datele vin din mesajele primite direct prin integrare (/api/integration/gateways?device=…); un contor care nu a trimis încă prin integrare nu are antene cunoscute.
 */
const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const when = (ms: number) => {
  if (!(ms > 0)) return "—";
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const km = (x: number | null) => (x === null ? "" : x < 1 ? `${Math.round(x * 1000)} m` : `${x.toFixed(1).replace(".", ",")} km`);
const STATE: Record<DevGateway["state"], string> = { on: "activă", slow: "lentă", off: "offline" };
const COLOR: Record<DevGateway["state"], string> = { on: "#0ca30c", slow: "#fab219", off: "#d03b3b" };

export default function MeterAntennas({ id, name }: { id: string; name: string }) {
  const [res, setRes] = useState<{ id: string; list: DevGateway[] } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void fetch(`/api/integration/gateways?device=${encodeURIComponent(id)}`, { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ gateways: DevGateway[] }>) : null))
      .then((j) => { if (j) setRes({ id, list: j.gateways }); })
      .catch(() => undefined);
    return () => ac.abort();
  }, [id]);

  const list = res && res.id === id ? res.list : null;
  return (
    <section aria-label="Antene">
      <h3>Trimite date către antene{list ? ` (${list.length})` : ""}</h3>
      {list === null ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : list.length === 0 ? (
        <p className="cell-sub" style={{ whiteSpace: "normal" }}>Nu avem încă mesaje primite direct de la acest contor, deci nu știm ce antene îl aud.</p>
      ) : (
        <ul className="ant-list">
          {list.map((g) => (
            <li key={g.id}>
              <span className="ant-flow" aria-hidden="true">
                <b>{name}</b>
                <svg width="46" height="14" viewBox="0 0 46 14"><path d="M1 7 H38" stroke={COLOR[g.state]} strokeWidth={g.primary ? 3 : 2} strokeDasharray={g.primary ? undefined : "5 4"} fill="none" /><path d="M36 2 L45 7 L36 12 Z" fill={COLOR[g.state]} /></svg>
              </span>
              <span>
                <b>{g.name}</b>
                {g.primary && <span className="gw-badge">principală</span>}
                <span className="cell-sub" style={{ display: "block" }}>
                  <span className="gw-dot" style={{ background: COLOR[g.state] }} aria-hidden="true" /> {STATE[g.state]}
                  {g.km !== null ? ` · ${km(g.km)}` : ""}{g.rssi !== null ? ` · ${g.rssi} dBm` : ""}{g.snr !== null ? ` · SNR ${g.snr}` : ""} · {nf.format(g.n)} mesaje · ultimul {when(g.last)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
