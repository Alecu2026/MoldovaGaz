"use client";

import { useEffect, useState } from "react";
import type { MsgRanking, MsgRow } from "@/lib/services/meter-msgs";
import { gwGet } from "./gw-fetch";
import MsgPeriod from "./MsgPeriod";
import { periodLabel, useMsgPeriod } from "./useMsgCounts";

/**
 * «Mesaje»: care contoare trimit cele mai multe mesaje pe zi (un contor care transmite des își descarcă repede bateria). Ziua se alege (azi, ieri, oricare din ultimele 14 zile),
 * iar lista arată contoarele în ordine descrescătoare, cu seria pe zile (se vede dacă e o problemă de azi sau veche), bateria și semnalul. Doar contoarele din zona ta.
 * Mesajele se numără din contorul de cadre (fCnt) la fiecare sincronizare, de la prima rulare; zilele dinainte nu se pot reconstitui.
 */
const nf = new Intl.NumberFormat("ro-RO");
const SIZES = [50, 100, 200, 500];

function Spark({ s, days, inP }: { s: (number | null)[]; days: string[]; inP: (i: number) => boolean }) {
  const max = Math.max(1, ...s.map((x) => x ?? 0));
  const w = 6, g = 2, h = 26;
  return (
    <svg width={s.length * (w + g)} height={h} role="img" aria-label={`Mesaje pe zi, ultimele ${s.length} zile: ${s.map((x) => x ?? "–").join(", ")}`}>
      {s.map((x, i) => {
        const bh = x === null ? 0 : Math.max(x > 0 ? 2 : 0, Math.round((x / max) * (h - 2)));
        return (
          <g key={i}>
            <title>{`${days[i].split("-").reverse().join(".")}: ${x === null ? "nemăsurat" : `${nf.format(x)} mesaje`}`}</title>
            <rect x={i * (w + g)} y={0} width={w} height={h} fill="transparent" />
            <rect x={i * (w + g)} y={h - bh} width={w} height={bh} rx={1.5} fill={inP(i) ? "var(--accent, #2a78d6)" : "var(--muted, #8a94a6)"} opacity={inP(i) ? 1 : 0.55} />
          </g>
        );
      })}
    </svg>
  );
}

export default function MessagesPanel({ onOpenMeter }: { onOpenMeter: (id: string) => void }) {
  const [day] = useMsgPeriod();
  const [min, setMin] = useState("");
  const [limit, setLimit] = useState(100);
  const [qIn, setQIn] = useState("");
  const [q, setQ] = useState("");
  const [now] = useState(() => Date.now());
  const [res, setRes] = useState<{ key: string; v: MsgRanking | null } | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(qIn.trim()), 300); return () => clearTimeout(t); }, [qIn]);
  const qs = new URLSearchParams({ p: day, min: min || "0", limit: String(limit), q }).toString();
  useEffect(() => {
    const ac = new AbortController();
    void gwGet<MsgRanking>(`/api/meters/messages?${qs}`, ac.signal, 20_000).then((v) => { if (!ac.signal.aborted) setRes({ key: qs, v }); });
    return () => ac.abort();
  }, [qs]);
  const loading = !res || res.key !== qs;
  const d = res?.v ?? null;
  const label = periodLabel(day, now);
  const multi = !!d && d.from !== d.to;
  // în grafic se evidențiază ziua (sau zilele) perioadei
  const inPeriod = (i: number) => !!d && d.days[i] >= d.from && d.days[i] <= d.to;
  const noData = !!d && d.measured === 0;

  return (
    <div className="msgs">
      <div className="toolbar-row2" role="group" aria-label="Filtre mesaje" style={{ marginBottom: 10 }}>
        <div className="field"><span>Perioada (UTC)</span><MsgPeriod /></div>
        <label className="field"><span>Cel puțin (mesaje / zi)</span><input className="input" type="number" min={0} inputMode="numeric" value={min} placeholder="0" onChange={(e) => setMin(e.target.value)} style={{ width: 120 }} /></label>
        <label className="field"><span>Caută contor</span><input className="input" type="search" value={qIn} placeholder="nume, adresă…" onChange={(e) => setQIn(e.target.value)} /></label>
        <label className="field"><span>Afișează</span>
          <select className="select" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{SIZES.map((n) => <option key={n} value={n}>primele {n}</option>)}</select>
        </label>
      </div>
      <p className="cell-sub" style={{ margin: "0 0 10px", whiteSpace: "normal" }}>
        De câte ori a trimis fiecare contor date (mesaje către antenă) în perioada aleasă; pe mai multe zile se arată media pe zi. Zilele încep la miezul nopții UTC (02:00 / 03:00 ora Moldovei); perioadele de 3 / 7 / 30 de zile sunt zile întregi, fără azi. Un contor care transmite foarte des își descarcă repede bateria; sus sunt cele mai active.
        Numărătoarea pornește de la prima sincronizare cu această funcție{d ? ` (${d.since.split("-").reverse().join(".")})` : ""}; zilele dinainte nu se pot reconstitui.
      </p>

      {d && (
        <div className="stats auto" style={{ opacity: loading ? 0.6 : 1, marginBottom: 12 }} aria-live="polite">
          <div className="stat"><div className="k">Contoare urmărite</div><div className="v">{nf.format(d.tracked)}</div><div className="s">{nf.format(d.measured)} cu valoare pentru {label.toLowerCase()}</div></div>
          <div className="stat"><div className="k">Mesaje în total</div><div className="v">{nf.format(d.sum)}</div><div className="s">{d.measured ? `în medie ${(d.sum / d.measured).toFixed(1).replace(".", ",")} pe contor${multi ? " în perioadă" : ""}` : "—"}</div></div>
          {d.above.map((a) => (
            <div className="stat" key={a.min}>
              <div className="k">Cel puțin {a.min} mesaje / zi</div>
              <div className="v"><button type="button" className="link-btn" onClick={() => setMin(String(a.min))} title="Arată doar aceste contoare" style={{ font: "inherit", fontWeight: 700 }}>{nf.format(a.n)}</button></div>
              <div className="s">contoare</div>
            </div>
          ))}
        </div>
      )}

      {noData && !loading && <p className="gwf-note">Încă nu avem mesaje numărate pentru această zi. Numărătoarea pornește de la prima sincronizare după punerea în funcțiune și se completează pe parcurs (alege «Azi» sau revino mai târziu).</p>}

      <div className="card-table" style={{ maxHeight: 640, opacity: loading ? 0.6 : 1 }}>
        <table className="mini">
          <thead><tr><th className="num">#</th><th>Contor</th><th className="num">{multi ? "Mesaje / zi (medie)" : "Mesaje"} · {label}</th><th>Ultimele {d?.days.length ?? 14} zile</th><th className="num" title="Mesaje primite prin integrare de la început (ca în pagina Integrare)">Total primit</th><th className="num">Baterie</th><th className="num">Semnal</th></tr></thead>
          <tbody>
            {d?.rows.map((r: MsgRow, i) => (
              <tr key={r.id} onClick={() => onOpenMeter(r.id)} style={{ cursor: "pointer" }} title="Click: detaliile contorului">
                <td className="num mono">{i + 1}</td>
                <td><button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); onOpenMeter(r.id); }}><b>{r.name}</b></button><div className="cell-sub">{[r.branch, r.city].filter(Boolean).join(" · ")}</div></td>
                <td className="num mono"><b className={r.n >= 48 ? "low" : undefined}>{nf.format(r.n)}</b>{multi && <div className="cell-sub">{nf.format(r.total)} în {r.days} zile</div>}</td>
                <td><Spark s={r.s} days={d.days} inP={inPeriod} /></td>
                <td className="num mono">{r.life !== null ? nf.format(r.life) : "—"}</td>
                <td className={`num mono ${r.battery !== null && r.battery < 20 ? "low" : ""}`}>{r.battery !== null ? `${Math.round(r.battery)}%` : "—"}</td>
                <td className="num mono">{r.rssi !== null ? `${r.rssi} dBm` : "—"}</td>
              </tr>
            ))}
            {d && d.rows.length === 0 && !noData && <tr><td colSpan={7} className="cell-sub" style={{ padding: 16 }}>Niciun contor cu cel puțin {min || "0"} mesaje pe zi în perioada aleasă.</td></tr>}
            {!d && <tr><td colSpan={7} className="cell-sub" style={{ padding: 16 }}>{loading ? "se încarcă…" : "Nu am putut citi mesajele."}</td></tr>}
          </tbody>
        </table>
      </div>
      {d && d.total > d.rows.length && <p className="cell-sub">Primele {nf.format(d.rows.length)} din {nf.format(d.total)} contoare care trec de filtru (mărește «Afișează» ca să vezi mai multe).</p>}
    </div>
  );
}
