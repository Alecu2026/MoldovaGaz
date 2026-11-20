"use client";

import { useEffect, useRef, useState } from "react";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const nf = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 3 });

type Loaded = { id: string; ts: string; receivedAt: string; payload: Obj };

async function copy(s: string) {
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    /* clipboard indisponibil (http, permisiuni) */
  }
}

/** Panou lateral cu payload-ul original al mesajului. Răspunsul e imutabil și se ține în cache-ul HTTP al browserului. */
export default function UplinkDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ id: string; item: Loaded | null; error: string | null } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/uplinks/${id}`)
      .then(async (r) => {
        if (r.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!r.ok) throw new Error(r.status === 404 ? "Mesajul nu mai există." : "Nu am putut încărca mesajul.");
        const j = (await r.json()) as Loaded;
        if (alive) setData({ id, item: j, error: null });
      })
      .catch((e: Error) => alive && setData({ id, item: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [id]);

  // focus în panou, Esc închide, Tab rămâne în panou; la închidere focusul revine unde era
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !boxRef.current) return;
      const f = boxRef.current.querySelectorAll<HTMLElement>("button, a[href], summary, [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      const first = f[0],
        last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const loading = !data || data.id !== id;
  const item = !loading ? data.item : null;
  const p = item?.payload;
  const rx = p && Array.isArray(p.rxInfo) ? p.rxInfo.filter(isObj) : [];
  const tx = p && isObj(p.txInfo) ? p.txInfo : {};
  const obj = p && isObj(p.object) ? p.object : null;
  const decoded = obj && Array.isArray(obj.decoded) ? obj.decoded.filter(isObj) : [];

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" ref={boxRef}>
        <header>
          <div style={{ minWidth: 0 }}>
            <h2 id="detail-title">{p ? text(p.deviceName) || text(p.devEUI) : "Mesaj"}</h2>
            <div className="cell-sub mono">{p ? text(p.devEUI) : " "}</div>
          </div>
          <button ref={closeRef} className="btn btn-sm" onClick={onClose} aria-label="Închide detaliile">
            Închide
          </button>
        </header>

        {loading && (
          <section aria-busy="true">
            <div className="skeleton" style={{ height: 18, width: "60%", marginBottom: 10 }} />
            <div className="skeleton" style={{ height: 120 }} />
          </section>
        )}
        {!loading && data.error && (
          <section>
            <p className="form-error" role="alert">
              {data.error}
            </p>
          </section>
        )}

        {item && p && (
          <>
            <section>
              <h3>General</h3>
              <dl className="kv">
                <dt>Moment mesaj</dt>
                <dd className="mono">{new Date(item.ts).toLocaleString("ro-RO")}</dd>
                <dt>Primit de server</dt>
                <dd className="mono">{new Date(item.receivedAt).toLocaleString("ro-RO")}</dd>
                <dt>Aplicație</dt>
                <dd>{text(p.applicationName) || "—"}</dd>
                <dt>Profil dispozitiv</dt>
                <dd>{text(p.deviceProfileName) || "—"}</dd>
                <dt>fCnt / fPort</dt>
                <dd className="mono">
                  {text(p.fCnt) || "—"} / {text(p.fPort) || "—"}
                </dd>
                <dt>Frecvență / DR</dt>
                <dd className="mono">
                  {typeof tx.frequency === "number" ? `${nf.format(tx.frequency / 1e6)} MHz` : "—"} / DR{text(tx.dr) || "—"}
                  {p.adr === true ? " · ADR" : ""}
                </dd>
                {typeof p.data === "string" && (
                  <>
                    <dt>Date (base64)</dt>
                    <dd className="mono">{p.data}</dd>
                  </>
                )}
                {obj && typeof obj.hex === "string" && (
                  <>
                    <dt>Hex</dt>
                    <dd className="mono">{obj.hex}</dd>
                  </>
                )}
              </dl>
            </section>

            <section>
              <h3>Gateway-uri ({rx.length})</h3>
              {rx.length === 0 ? (
                <p className="cell-sub">Mesajul nu conține rxInfo.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="mini">
                    <thead>
                      <tr>
                        <th>Nume</th>
                        <th>RSSI</th>
                        <th>SNR</th>
                        <th>Locație</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rx.map((g, i) => {
                        const loc = isObj(g.location) ? g.location : null;
                        const lat = loc && typeof loc.latitude === "number" ? loc.latitude : null;
                        const lon = loc && typeof loc.longitude === "number" ? loc.longitude : null;
                        return (
                          <tr key={i}>
                            <td>
                              <div style={{ fontWeight: 600 }}>{text(g.name) || text(g.gatewayID)}</div>
                              <div className="cell-sub mono">{text(g.gatewayID)}</div>
                            </td>
                            <td className="mono">{text(g.rssi) || "—"}</td>
                            <td className="mono">{text(g.loRaSNR ?? g.snr) || "—"}</td>
                            <td>
                              {lat != null && lon != null ? (
                                <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-strong)" }}>
                                  {lat.toFixed(4)}, {lon.toFixed(4)}
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <h3>Date decodate ({decoded.length})</h3>
              {decoded.length === 0 && <p className="cell-sub">Mesajul nu are date decodate.</p>}
              {decoded.map((e, i) => (
                <Element key={i} e={e} />
              ))}
            </section>

            <section>
              <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Payload original (JSON)</span>
                <button className="btn btn-sm" onClick={() => copy(JSON.stringify(p, null, 2))}>
                  Copiază
                </button>
              </h3>
              <pre className="json">{JSON.stringify(p, null, 2)}</pre>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Element({ e }: { e: Obj }) {
  const { ieType, cmd, values, status, ...rest } = e;
  const rows = Array.isArray(values) ? values.filter(isObj) : [];
  const cols = Array.from(new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r))));
  return (
    <div className="el">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <strong>{text(ieType) || `cmd ${text(cmd)}`}</strong>
        {cmd != null && <span className="cell-sub mono">cmd {text(cmd)}</span>}
      </div>
      {isObj(status) && (
        <div className="badges" style={{ flexWrap: "wrap", marginBottom: 6 }}>
          {Object.entries(status).map(([k, v]) => (
            <span key={k} className={`badge ${v === true ? (k === "offline" || k === "batteryTooLowVoltage" ? "danger" : "warn") : ""}`}>
              {k}: {text(v)}
            </span>
          ))}
        </div>
      )}
      {Object.keys(rest).length > 0 && (
        <dl className="kv" style={{ gridTemplateColumns: "130px 1fr", marginBottom: rows.length ? 8 : 0 }}>
          {Object.entries(rest).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd className="mono">{text(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="mini">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 48).map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c} className="mono">
                      {text(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 48 && <p className="cell-sub">+ încă {rows.length - 48} rânduri (vezi JSON-ul de mai jos).</p>}
        </div>
      )}
    </div>
  );
}
