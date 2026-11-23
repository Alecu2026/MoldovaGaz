"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { validCoords } from "@/lib/meter-shared";
import { ColumnChart, nf, type Bar } from "./charts/primitives";

/** Harta contorului (Leaflet) se încarcă doar când se deschide detaliul. */
const MeterLocation = dynamic(() => import("./MeterLocation"), { ssr: false, loading: () => <div className="skeleton" style={{ height: 230 }} aria-busy="true" /> });

type Obj = Record<string, unknown>;
type Detail = { id: string; updatedAt: string; tb: Obj; bill: Obj | null; attrs: Obj; tel: Record<string, { t: number; v: string }>; s: Obj };
type History = { hourly: [number, number][]; transmissions: [number, number][]; days: number; fetchedAt: number; source?: "live" | "stored"; storedAt?: number };

const nf3 = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const p2 = (n: number) => String(n).padStart(2, "0");
const dt = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const text = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "da" : "nu") : typeof v === "object" ? JSON.stringify(v) : String(v));

const BILL_LABELS: Record<string, string> = {
  ENTITY_NAME: "Consumator", CITY: "Oraș", STREET: "Strada", HOUSE: "Casa", APARTMENT: "Apartament", ACCT_ID: "Cont (ACCT_ID)", NUM_RADIO: "Număr radio",
  CONTOR_ID: "ID contor", CONTOR_SN: "Serie contor", PREM_ID: "ID loc consum", SP_ID: "ID punct consum", FIL: "Filiala (cod)", OTDELEN: "Secția", KOD_AB: "Cod abonat",
  METCITIRE: "Metoda de citire", CONTROLOR: "Controlor", UPDATED_DATE: "Actualizat în facturare", REPEAT: "REPEAT", NUM_CAR: "NUM_CAR",
};
const BILL_ORDER = ["ENTITY_NAME", "CITY", "STREET", "HOUSE", "APARTMENT", "ACCT_ID", "NUM_RADIO", "CONTOR_SN", "CONTOR_ID", "PREM_ID", "SP_ID", "FIL", "OTDELEN", "KOD_AB", "METCITIRE", "CONTROLOR", "UPDATED_DATE", "REPEAT", "NUM_CAR"];
const TIME_KEYS = new Set(["lastActivityTime", "inactivityAlarmTime"]);

async function copy(s: string) {
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    /* clipboard indisponibil (http, permisiuni) */
  }
}

/** Consumul din valori cumulative: diferența dintre citiri consecutive, atribuită intervalului în care s-a făcut a doua citire. Negativ (resetare) ⇒ 0 + contor de anomalii. */
function consumption(points: [number, number][], by: "day" | "hour", sinceMs: number): { bars: Bar[]; total: number; anomalies: number } {
  const key = (t: number) => {
    const d = new Date(t);
    return by === "day" ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
  };
  // următorul interval: pe zile calendaristice (o zi are 23 / 25 de ore la schimbarea orei), pe ore +1 h
  const next = (k: number) => (by === "day" ? new Date(new Date(k).getFullYear(), new Date(k).getMonth(), new Date(k).getDate() + 1).getTime() : k + 3_600_000);
  const sums = new Map<number, number>();
  let anomalies = 0, total = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] < sinceMs) continue;
    const dv = points[i][1] - points[i - 1][1];
    if (dv < 0) { anomalies++; continue; }
    const k = key(points[i][0]);
    sums.set(k, (sums.get(k) ?? 0) + dv);
    total += dv;
  }
  if (sums.size === 0) return { bars: [], total: 0, anomalies };
  const first = Math.max(key(sinceMs), Math.min(...sums.keys()));
  const last = Math.max(...sums.keys());
  const bars: Bar[] = [];
  for (let k = first; k <= last && bars.length < 400; k = next(k)) {
    const d = new Date(k);
    const lbl = by === "day" ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)}` : `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:00`;
    bars.push({ label: by === "day" ? `Consum în ${lbl}.${d.getFullYear()}` : `Consum în ${lbl}–${p2((d.getHours() + 1) % 24)}:00`, axis: lbl, value: Math.round((sums.get(k) ?? 0) * 1000) / 1000, ghost: 0 });
  }
  return { bars, total, anomalies };
}

/** Panou lateral cu tot ce se știe despre un contor: facturare, atribute, ultima telemetrie și istoricul Volume (m3) din SCADA. */
export default function MeterDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ id: string; item: Detail | null; error: string | null } | null>(null);
  const [days, setDays] = useState(30);
  const [by, setBy] = useState<"day" | "hour">("day");
  const [hist, setHist] = useState<{ key: string; h: History | null; error: string | null } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/meters/${id}`)
      .then(async (r) => {
        if (r.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!r.ok) throw new Error(r.status === 404 ? "Contorul nu mai există." : "Nu am putut încărca contorul.");
        const j = (await r.json()) as Detail;
        if (alive) setData({ id, item: j, error: null });
      })
      .catch((e: Error) => alive && setData({ id, item: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [id]);

  const histKey = `${id}:${days}`;
  useEffect(() => {
    let alive = true;
    fetch(`/api/meters/${id}/history?days=${days}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Istoricul nu e disponibil acum (SCADA nu răspunde).");
        const j = (await r.json()) as History;
        if (alive) setHist({ key: histKey, h: j, error: null });
      })
      .catch((e: Error) => alive && setHist({ key: histKey, h: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [id, days, histKey]);

  // focus în panou, Esc închide, Tab rămâne în panou; la închidere focusul revine unde era
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !boxRef.current) return;
      const f = boxRef.current.querySelectorAll<HTMLElement>("button, a[href], summary, select, [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
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
  const h = hist?.key === histKey ? hist.h : null;
  const histLoading = !hist || hist.key !== histKey;
  const series = useMemo(() => (h ? (h.hourly.length >= 2 ? h.hourly : h.transmissions) : []), [h]);
  // „acum” = momentul la care serverul a citit istoricul (nu Date.now() în randare)
  const at = h?.fetchedAt ?? 0;
  const cons = useMemo(() => consumption(series, by, by === "hour" ? Math.max(at - days * 86_400_000, at - 7 * 86_400_000) : at - days * 86_400_000), [series, by, at, days]);
  const last = series.length ? series[series.length - 1] : null;

  const s = item?.s as Obj | undefined;
  const bill = item?.bill;
  const tel = item?.tel ?? {};
  const attrs = item?.attrs ?? {};
  const geo = item ? validCoords(s?.la ?? attrs.latitude, s?.lo ?? attrs.longitude) : null;
  const address = bill ? [bill.CITY, bill.STREET, bill.HOUSE].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ") : "";

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" ref={boxRef} style={{ width: "min(760px, 100%)" }}>
        <header>
          <div style={{ minWidth: 0 }}>
            <h2 id="detail-title">{s ? text(s.n) : "Contor"}</h2>
            <div className="cell-sub mono">{s ? `${text(s.e)} · ${text(s.br)}` : " "}</div>
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

        {item && s && (
          <>
            <section>
              <h3>Volume (m³)</h3>
              <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 12 }}>
                <div className="stat"><div className="k">Ultima citire</div><div className="v" style={{ fontSize: 20 }}>{typeof s.v === "number" ? nf3.format(s.v) : "—"}</div><div className="s">{Number(s.t) > 0 ? dt(Number(s.t)) : "fără citiri"}</div></div>
                <div className="stat"><div className="k">Consum în perioadă</div><div className="v" style={{ fontSize: 20 }}>{series.length > 1 ? `${nf3.format(cons.total)} m³` : "—"}</div><div className="s">{series.length} citiri / {days} zile</div></div>
                <div className="stat"><div className="k">Consum zilnic (SCADA)</div><div className="v" style={{ fontSize: 20 }}>{typeof s.dc === "number" ? `${nf.format(s.dc)} L` : "—"}</div><div className="s">lunar: {typeof s.mc === "number" ? `${nf.format(s.mc)} L` : "—"}</div></div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
                <label className="field" style={{ width: 150 }}>
                  <span>Perioadă</span>
                  <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} zile</option>)}
                  </select>
                </label>
                <div className="field">
                  <span id="lbl-by">Consum pe</span>
                  <div className="seg" role="group" aria-labelledby="lbl-by">
                    <button type="button" aria-pressed={by === "day"} onClick={() => setBy("day")}>Zi</button>
                    <button type="button" aria-pressed={by === "hour"} onClick={() => setBy("hour")}>Oră (ultimele 7 zile)</button>
                  </div>
                </div>
              </div>
              {histLoading && <div className="skeleton" style={{ height: 190 }} aria-busy="true" />}
              {!histLoading && hist?.error && <p className="form-error" role="alert">{hist.error}</p>}
              {!histLoading && h && (
                cons.bars.length > 0 ? (
                  <>
                    {h.source === "stored" && (
                      <p className="cell-sub" role="note" style={{ margin: "0 0 6px", color: "var(--warn)", whiteSpace: "normal" }}>
                        Istoric din arhivă (SCADA nu poate fi interogat acum de pe server): ultima citire arhivată {dt(h.fetchedAt)}, arhivă încărcată {h.storedAt ? dt(h.storedAt) : "—"}; acoperă ultimele ~90 de zile.
                      </p>
                    )}
                    <p className="cell-sub" style={{ margin: "0 0 2px", fontWeight: 600 }}>Consum în m³, pe {by === "day" ? "zi" : "oră"}</p>
                    <ColumnChart unit="m³" bars={cons.bars} ariaLabel={`Consum pe ${by === "day" ? "zi" : "oră"} (m³)`} labelWidth={by === "day" ? 56 : 90} />
                    <p className="cell-sub" style={{ margin: "6px 0 0", whiteSpace: "normal" }}>
                      Dacă între două citiri trec mai multe zile, tot consumul acelui interval apare în ziua celei de-a doua citiri (de aici vârfurile). Consum = diferența dintre citiri consecutive ale Volume_m3_Total_ts (m³){cons.anomalies ? ` · ${cons.anomalies} scăderi ale contorului ignorate (resetare / corecție)` : ""}.
                      {h.hourly.length < 2 && h.transmissions.length >= 2 ? " Nu există citiri orare în perioadă: folosesc valorile de la transmisii." : ""}
                    </p>
                  </>
                ) : (
                  <p className="cell-sub">Nu sunt suficiente citiri în perioadă ca să calculez consumul{last ? ` (ultima citire: ${dt(last[0])})` : ""}.</p>
                )
              )}
              {!histLoading && h && series.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>Ultimele citiri ({Math.min(series.length, 48)} din {series.length})</summary>
                  <div style={{ maxHeight: 240, overflow: "auto", marginTop: 6 }}>
                    <table className="mini">
                      <thead><tr><th>Moment</th><th className="num">Volume (m³)</th><th className="num">Diferență</th></tr></thead>
                      <tbody>
                        {series.slice(-48).reverse().map((p, i, arr) => {
                          const prev = i + 1 < arr.length ? arr[i + 1] : series.length > 48 ? series[series.length - 49] : null;
                          return (
                            <tr key={p[0]}>
                              <td className="mono">{dt(p[0])}</td>
                              <td className="num mono">{nf3.format(p[1])}</td>
                              <td className="num mono">{prev ? nf3.format(p[1] - prev[1]) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </section>

            <section>
              <h3>Locație</h3>
              <MeterLocation lat={geo ? geo[0] : null} lon={geo ? geo[1] : null} name={text(s.n)} address={address} />
            </section>

            <section>
              <h3>Facturare (Moldovagaz)</h3>
              {bill ? (
                <dl className="kv">
                  {BILL_ORDER.filter((k) => k in bill).map((k) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt>{BILL_LABELS[k] ?? k}</dt>
                      <dd>{text(bill[k])}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="cell-sub">Contorul nu are rând în facturare (nu s-a găsit niciun număr radio potrivit).</p>
              )}
            </section>

            <section>
              <h3>SCADA</h3>
              <dl className="kv">
                <dt>Nume</dt><dd className="mono">{text(item.tb.name)}</dd>
                <dt>Profil</dt><dd>{text(item.tb.type)}</dd>
                <dt>ID dispozitiv</dt><dd className="mono">{item.id}</dd>
                <dt>ID client</dt><dd className="mono">{text(item.tb.customerId)}</dd>
                <dt>Creat</dt><dd className="mono">{typeof item.tb.createdTime === "number" ? dt(item.tb.createdTime) : "—"}</dd>
                <dt>Sincronizat</dt><dd className="mono">{dt(Date.parse(item.updatedAt))}</dd>
                {Array.isArray(item.tb.dupWith) && item.tb.dupWith.length > 0 && (
                  <>
                    <dt>Serie repetată</dt>
                    <dd>Același număr radio apare și la: {(item.tb.dupWith as string[]).join("; ")}</dd>
                  </>
                )}
              </dl>
            </section>

            <section>
              <h3>Ultima telemetrie ({Object.keys(tel).length})</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="mini">
                  <thead><tr><th>Cheie</th><th>Valoare</th><th>Moment</th></tr></thead>
                  <tbody>
                    {Object.entries(tel).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td className="mono" style={{ overflowWrap: "anywhere" }}>{v.v.length > 120 ? `${v.v.slice(0, 120)}…` : v.v}</td>
                        <td className="mono">{dt(v.t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3>Atribute ({Object.keys(attrs).length})</h3>
              <dl className="kv">
                {Object.entries(attrs).map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{k}</dt>
                    <dd className="mono">{TIME_KEYS.has(k) && typeof v === "number" ? dt(v) : text(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Document complet (JSON)</span>
                <button className="btn btn-sm" onClick={() => copy(JSON.stringify(item, null, 2))}>Copiază</button>
              </h3>
              <pre className="json">{JSON.stringify(item, null, 2)}</pre>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
