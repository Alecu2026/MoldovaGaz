"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_PARAMS, NIGHTS } from "@/lib/night-analysis";
import type { SuspectResult } from "@/lib/services/night-dataset";
import MeterDetail from "./MeterDetail";

const nf = new Intl.NumberFormat("ro-RO");
const nf1 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 2 });
const p2 = (n: number) => String(n).padStart(2, "0");
const dm = (ms: number) => `${p2(new Date(ms).getDate())}.${p2(new Date(ms).getMonth() + 1)}.${new Date(ms).getFullYear()}`;
const dmt = (ms: number) => `${dm(ms)} ${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}`;

type Form = { drop: string; noDrop: boolean; from: string; to: string; nights: string; maxNight: string; minDay: string; minTemp: string; maxTemp: string; hasTemp: boolean; noTemp: boolean; tempMode: "night" | "day"; minNights: string };
const INIT: Form = { drop: "2", noDrop: true, from: String(DEFAULT_PARAMS.startHour), to: String(DEFAULT_PARAMS.endHour), nights: String(DEFAULT_PARAMS.nights), maxNight: String(DEFAULT_PARAMS.maxNight), minDay: String(DEFAULT_PARAMS.minDay), minTemp: String(DEFAULT_PARAMS.minTemp), maxTemp: "", hasTemp: false, noTemp: false, tempMode: DEFAULT_PARAMS.tempMode, minNights: String(DEFAULT_PARAMS.minNights) };

function fromUrl(): Form {
  if (typeof window === "undefined") return INIT;
  const q = new URLSearchParams(window.location.search);
  return {
    drop: q.get("drop") && q.get("drop") !== "none" ? (q.get("drop") as string) : INIT.drop, noDrop: !q.get("drop") || q.get("drop") === "none",
    from: q.get("from") ?? INIT.from, to: q.get("to") ?? INIT.to, nights: q.get("nights") ?? INIT.nights, maxNight: q.get("maxNight") ?? INIT.maxNight, minDay: q.get("minDay") ?? INIT.minDay,
    minTemp: q.has("minTemp") ? (q.get("minTemp") === "none" ? "" : (q.get("minTemp") as string)) : INIT.minTemp, noTemp: q.get("noTemp") === "1",
    maxTemp: q.get("maxTemp") && q.get("maxTemp") !== "none" ? (q.get("maxTemp") as string) : "", hasTemp: q.get("hasTemp") === "1",
    tempMode: q.get("tempMode") === "day" ? "day" : "night", minNights: q.get("minNights") ?? INIT.minNights,
  };
}
const toQuery = (f: Form): string => {
  const p = new URLSearchParams({ drop: f.noDrop ? "none" : f.drop, from: f.from, to: f.to, nights: f.nights, maxNight: f.maxNight, minDay: f.minDay, minTemp: f.noTemp || f.minTemp.trim() === "" ? "none" : f.minTemp, tempMode: f.tempMode, minNights: f.minNights });
  if (f.maxTemp.trim() !== "" && !f.noTemp) p.set("maxTemp", f.maxTemp);
  if (f.noTemp) p.set("noTemp", "1");
  if (f.hasTemp) p.set("hasTemp", "1");
  return p.toString();
};

/**
 * „Consum nemăsurat”: contoare care noaptea (00–06, ora Moldovei) nu înregistrează consum (sau foarte puțin), deși ziua consumă și temperatura din jurul lor
 * nu scade. E un INDICIU: poate însemna gaz care trece pe lângă contor, dar și o locuință cu alt mod de încălzire sau un contor montat în exterior.
 * Parametrii se pot edita; lista se recalculează pe server, doar din datele noastre (fără SCADA).
 */
export default function NightControl() {
  const [form, setForm] = useState<Form>(INIT);
  const [res, setRes] = useState<SuspectResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const seq = useRef(0);

  // valorile din URL (link trimis cuiva) se citesc o singură dată, după montare
  useEffect(() => {
    const t = setTimeout(() => setForm(fromUrl()), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const my = ++seq.current;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const qs = toQuery(form);
        window.history.replaceState(window.history.state, "", `?${qs}`);
        const r = await fetch(`/api/control/suspects?${qs}`, { cache: "no-store", signal: ctl.signal });
        if (r.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!r.ok) throw new Error("Nu am putut calcula lista.");
        const j = (await r.json()) as SuspectResult;
        if (my === seq.current) {
          setRes(j);
          setErr(null);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // cerere înlocuită de una mai nouă
        if (my === seq.current) setErr((e as Error).message);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [form]);

  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const noTempData = !!res && res.meters > 0 && res.withTemp === 0;

  return (
    <div className="page">
      <section className="toolbar" aria-label="Parametri" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <label className="field">
          <span>Noaptea de la ora</span>
          <select className="select" value={form.from} onChange={(e) => set({ from: e.target.value })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{p2(h)}:00</option>)}
          </select>
        </label>
        <label className="field">
          <span>până la ora</span>
          <select className="select" value={form.to} onChange={(e) => set({ to: e.target.value })}>
            {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{p2(h % 24)}:00{h === 24 ? " (miezul nopții)" : ""}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Nopți analizate</span>
          <select className="select" value={form.nights} onChange={(e) => set({ nights: e.target.value, minNights: String(Math.min(Number(form.minNights), Number(e.target.value))) })}>
            {[7, 14, 21, NIGHTS].map((n) => <option key={n} value={n}>ultimele {n}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Consum noapte maxim (m³)</span>
          <input className="input" type="number" min={0} step="0.1" value={form.maxNight} onChange={(e) => set({ maxNight: e.target.value })} />
        </label>
        <label className="field">
          <span>Consum zi minim (m³, restul de 24 h)</span>
          <input className="input" type="number" min={0} step="0.5" value={form.minDay} onChange={(e) => set({ minDay: e.target.value })} />
        </label>
        <label className="field">
          <span>Temperatură minimă (°C)</span>
          <input className="input" type="number" step="0.5" placeholder="fără minim" value={form.minTemp} disabled={form.noTemp} onChange={(e) => set({ minTemp: e.target.value })} />
        </label>
        <label className="field">
          <span>Temperatură maximă (°C)</span>
          <input className="input" type="number" step="0.5" placeholder="fără limită" value={form.maxTemp} disabled={form.noTemp} onChange={(e) => set({ maxTemp: e.target.value })} />
        </label>
        <label className="field">
          <span>Temperatura de comparat</span>
          <select className="select" value={form.tempMode} disabled={form.noTemp} onChange={(e) => set({ tempMode: e.target.value as "night" | "day" })}>
            <option value="night">minima din noapte</option>
            <option value="day">media pe toată ziua</option>
          </select>
        </label>
        <label className="field">
          <span>Nopți potrivite, minim</span>
          <input className="input" type="number" min={1} max={Number(form.nights)} step="1" value={form.minNights} onChange={(e) => set({ minNights: e.target.value })} />
        </label>
        <label className="field">
          <span>Temp. noapte față de zi: scădere max (°C)</span>
          <input className="input" type="number" step="0.5" value={form.drop} disabled={form.noDrop} onChange={(e) => set({ drop: e.target.value })} aria-describedby="drop-hint" />
        </label>
        <label className="field" style={{ justifyContent: "flex-end" }}>
          <span>&nbsp;</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center", height: 36 }} id="drop-hint">
            <input type="checkbox" checked={!form.noDrop} onChange={(e) => set({ noDrop: !e.target.checked })} />
            Temperatura rămâne ca ziua
          </span>
        </label>
        <label className="field" style={{ justifyContent: "flex-end" }}>
          <span>&nbsp;</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center", height: 36 }}>
            <input type="checkbox" checked={form.hasTemp} onChange={(e) => set({ hasTemp: e.target.checked })} />
            Doar contoare cu temperatură
          </span>
        </label>
        <label className="field" style={{ justifyContent: "flex-end" }}>
          <span>&nbsp;</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center", height: 36 }}>
            <input type="checkbox" checked={form.noTemp} onChange={(e) => set({ noTemp: e.target.checked })} />
            Ignoră temperatura
          </span>
        </label>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <span>&nbsp;</span>
          <button type="button" className="btn" onClick={() => setForm(INIT)}>Valori implicite</button>
        </div>
      </section>

      <section className="stats auto" aria-label="Rezumat" aria-live="polite">
        <div className="stat"><div className="k">Contoare potrivite</div><div className="v" style={{ color: res && res.matched > 0 ? "var(--danger)" : undefined }}>{res ? nf.format(res.matched) : "—"}</div><div className="s">{res ? `se afișează ${nf.format(res.shown)}` : busy ? "se calculează…" : " "}</div></div>
        <div className="stat"><div className="k">Contoare analizate</div><div className="v">{res ? nf.format(res.meters) : "—"}</div><div className="s">cu cel puțin o noapte calculată</div></div>
        <div className="stat"><div className="k">Cu temperatură</div><div className="v">{res ? nf.format(res.withTemp) : "—"}</div><div className="s">au citiri de temperatură</div></div>
        <div className="stat"><div className="k">Perioada</div><div className="v" style={{ fontSize: 16 }}>{res?.days ? `${dm(res.days[0])} – ${dm(res.days[1])}` : "—"}</div><div className="s">{res?.analyzedAt ? `calculat ${dmt(res.analyzedAt)}` : " "}</div></div>
      </section>

      {noTempData && (
        <p className="form-error" role="status" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
          Încă nu avem temperaturi în istoricul propriu: se adună din sincronizările orare. Până atunci filtrul cu temperatură nu găsește nimic; bifează „Ignoră temperatura” ca să vezi doar condiția de consum.
        </p>
      )}
      {res && res.meters === 0 && !busy && (
        <p className="form-error" role="status" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
          Nu există încă nopți calculate. Analiza rulează după sincronizare (o dată pe zi) sau la cerere: <code>npm run analyze:nights</code>.
        </p>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}

      <section className="tablebox" aria-label="Contoare suspecte" style={{ opacity: busy ? 0.6 : 1 }}>
        <div className="vp">
          <table className="mini" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th>Contor</th><th>Filială</th><th>Oraș</th>
                <th className="num">Nopți potrivite</th><th className="num">Consum noapte mediu (m³)</th><th className="num">Consum zi mediu (m³)</th>
                <th className="num">Temp. (°C)</th><th className="num" title="media de zi − media de noapte">Scădere temp. noapte (°C)</th><th className="num">Volum (m³)</th><th>Ultima citire</th>
              </tr>
            </thead>
            <tbody>
              {res?.rows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} style={{ cursor: "pointer" }}>
                  <td><button type="button" className="dev-link" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>{r.name}</button></td>
                  <td>{r.branch ?? "—"}</td>
                  <td>{r.city && r.city !== "—" ? r.city : "—"}</td>
                  <td className="num mono"><strong>{r.matched}</strong> / {r.known}</td>
                  <td className="num mono">{r.avgNight !== null ? nf2.format(r.avgNight) : "—"}</td>
                  <td className="num mono">{r.avgDay !== null ? nf1.format(r.avgDay) : "—"}</td>
                  <td className="num mono">{r.minTemp !== null ? nf1.format(r.minTemp) : "—"}</td>
                  <td className="num mono">{r.avgDrop !== null ? nf1.format(r.avgDrop) : "—"}</td>
                  <td className="num mono">{r.volume !== null ? nf1.format(r.volume) : "—"}</td>
                  <td className="mono">{r.lastReading > 0 ? dmt(r.lastReading) : "—"}</td>
                </tr>
              ))}
              {res && res.rows.length === 0 && !busy && (
                <tr><td colSpan={10} className="cell-sub" style={{ padding: 16 }}>Niciun contor nu se potrivește cu parametrii aleși. Relaxează unul dintre ei (consum de noapte mai mare, mai puține nopți cerute, fără temperatură).</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="cell-sub" style={{ margin: 0, whiteSpace: "normal" }}>
        Un contor apare dacă, în cel puțin {form.minNights} din ultimele {form.nights} nopți, a consumat cel mult {form.maxNight} m³ între {p2(Number(form.from))}:00 și {p2(Number(form.to) % 24)}:00{Number(form.to) <= Number(form.from) ? " (ziua următoare)" : ""}
        {Number(form.minDay) > 0 ? `, a consumat cel puțin ${form.minDay} m³ ziua` : ""}
        {form.noTemp || form.minTemp.trim() === "" ? "" : ` și temperatura ${form.tempMode === "night" ? "minimă din noapte" : "medie pe zi"} a fost cel puțin ${form.minTemp} °C`}{form.noTemp || form.maxTemp.trim() === "" ? "" : ` ${form.minTemp.trim() === "" ? `și temperatura ${form.tempMode === "night" ? "minimă din noapte" : "medie pe zi"} a fost` : "și"} cel mult ${form.maxTemp} °C`}{form.hasTemp ? ", doar pentru contoarele care au temperatură măsurată" : ""}{form.noDrop ? "" : `, iar temperatura de noapte a scăzut cu cel mult ${form.drop} °C față de cea de zi (media de zi − media de noapte)`}. Consumul la începutul și la sfârșitul nopții se estimează
        prin interpolare între citirile vecine (contorul trimite la 4–6 ore); nopțile fără citiri apropiate sunt ignorate. Este un indiciu, nu o dovadă.
      </p>
      {openId && <MeterDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
