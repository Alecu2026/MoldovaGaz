"use client";

import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-ext-400.css";
import "@fontsource/roboto/latin-ext-500.css";
import "@fontsource/roboto/cyrillic-400.css";
import "@fontsource/roboto/cyrillic-500.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logoutAction } from "@/app/actions/auth";
import { LIST_COLUMNS, MSG, PAGE_SIZES, activity, qrNotInDb, type InstallerList, type InstallerRecord, type InstallerRow } from "@/lib/installer";
import { ICON, type IconName } from "./tbicons";
import { clearMeterCaches } from "./useMeterStore";

// ce nu se vede de la început (scaner QR, cameră, poză mărită, hartă) se încarcă abia când e nevoie: pagina pornește mai repede, mai ales pe telefon
const QrScanner = dynamic(() => import("./QrScanner"), { ssr: false });
const CameraDialog = dynamic(() => import("./CameraDialog"), { ssr: false });
const PhotoViewer = dynamic(() => import("./PhotoViewer"), { ssr: false });
const ModuleMap = dynamic(() => import("./ModuleMap"), { ssr: false, loading: () => <div className="tbx-map" /> });

/**
 * Ecranul instalatorului: varianta noastră a aplicației din SCADA pe care o folosesc instalatorii (dashboardul „<Filială>_Gaz_App”, starea „…_Gaz_Meter_App”), cu aceleași 6 widgeturi:
 * Select Device, Device admin table, Meter Update, Instalation Photo, Installation foto (doar pe ecran lat) și Module Location; aceleași câmpuri, butoane, culori și mesaje.
 * Datele introduse se salvează doar în baza noastră (nu în SCADA). Aspectul urmează tema ThingsBoard (clase `.tbx*` în globals.css).
 */
const Ico = ({ n, s = 24 }: { n: IconName; s?: number }) => <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" aria-hidden="true"><path d={ICON[n]} /></svg>;
const Btn = ({ n, label, onClick, disabled, className = "" }: { n: IconName; label: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; className?: string }) => (
  <button type="button" className={`tbx-iconbtn ${className}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}><Ico n={n} /></button>
);
const ROW_H = 50, OVERSCAN = 12, WINDOW_MIN = 120;
const p2 = (n: number) => String(n).padStart(2, "0");
const fdt = (ms: number | null) => { if (!ms) return ""; const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const fnum = (v: number | null) => (v === null ? "" : String(v));
const COL_KEY = "mg-installer-cols";
const STATE_TITLE = "Moldovagaz_Meter_App";

type Dlg = { kind: "alert"; title: string; body?: string } | { kind: "scan" } | { kind: "camera" } | null;
type Form = { id: string; ContorNr: string; lit: string; Aragaz: boolean; Cazan: boolean; Incalzire: boolean; mod: boolean; loc: string; com: string };
const toForm = (r: InstallerRecord): Form => ({ id: r.id, ContorNr: r.ContorNr, lit: fnum(r.Instalation_Litres), Aragaz: r.Aragaz, Cazan: r.Cazan, Incalzire: r.Incalzire, mod: r.ModuleWriteInitial, loc: r.locationModule, com: r.Comments });

/** ce pregătește serverul odată cu pagina: filtrul păstrat al utilizatorului și prima pagină a listei (fără cereri în plus după încărcare) */
export type InstallerInitial = { filter: string; list: InstallerList | null };

export default function InstallerApp({ canHome = false, initial }: { /** are acces și la pagina Contoare: doar atunci apare legătura spre aplicația principală */ canHome?: boolean; initial?: InstallerInitial }) {
  /* ───────── lista (Device admin table) ───────── */
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState(initial?.filter ?? "");
  const [filterDraft, setFilterDraft] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc"; user?: boolean }>({ key: "name", dir: "asc" });
  const [hidden, setHidden] = useState<string[]>([]);
  const [colMenu, setColMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState(false);
  // prima pagină a listei vine odată cu pagina (aceeași cheie ca a cererii pe care ar fi făcut-o): prima pictare are deja date
  const initKey = `${(initial?.filter ?? "").trim()}|0|10|name|asc|0`;
  const [list, setList] = useState<{ key: string; data: InstallerList | null; err: string | null } | null>(initial?.list ? { key: initKey, data: initial.list, err: null } : null);
  const listNow = useRef(list);
  useEffect(() => { listNow.current = list; });
  const [reload, setReload] = useState(0);
  const [now] = useState(() => Date.now());
  const eff = q.trim() || filter.trim();
  const key = `${eff}|${page}|${size}|${sort.key}|${sort.dir}|${reload}`;
  useEffect(() => { const t = setTimeout(() => { try { const v = JSON.parse(localStorage.getItem(COL_KEY) ?? "[]") as string[]; if (Array.isArray(v)) setHidden(v); } catch { /* fără stocare locală */ } }, 0); return () => clearTimeout(t); }, []);

  useEffect(() => {
    if (listNow.current?.key === key && listNow.current.data) return; // lista pentru această cheie e deja în pagină (cea de la început)
    const ac = new AbortController();
    const t = setTimeout(() => {
      void fetch(`/api/installer/meters?q=${encodeURIComponent(eff)}&page=${page}&size=${size}&sort=${sort.key}&dir=${sort.dir}`, { signal: ac.signal, cache: "no-store" })
        .then(async (r) => { if (r.status === 401) { window.location.replace("/login"); return; } if (!r.ok) throw new Error(String(r.status)); setList({ key, data: (await r.json()) as InstallerList, err: null }); })
        .catch((e: Error) => { if (e.name !== "AbortError") setList({ key, data: null, err: "Nu am putut citi lista." }); });
    }, q ? 250 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [key, eff, page, size, sort.key, sort.dir, q]);

  /* ───────── contorul ales (formularul + poza + harta) ───────── */
  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<{ id: string; rec: InstallerRecord | null; err: string | null } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [pv, setPv] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; ok: boolean; n: number; ms: number } | null>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [view, setView] = useState(false);
  const [green, setGreen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const fileDrop = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLElement>(null);
  const [camFor, setCamFor] = useState<string | null>(null);

  const toast = useCallback((text: string, ok = true, ms = 3000) => setToastMsg({ text, ok, ms, n: Date.now() }), []);
  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), toastMsg.ms); return () => clearTimeout(t); }, [toastMsg]);

  const adopt = useCallback((r: InstallerRecord) => { setRec({ id: r.id, rec: r, err: null }); setForm(toForm(r)); setTouched({}); }, []);
  useEffect(() => {
    if (!sel) return;
    const ac = new AbortController();
    void fetch(`/api/installer/meters/${sel}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); adopt((await r.json()) as InstallerRecord); })
      .catch((e: Error) => { if (e.name !== "AbortError") setRec({ id: sel, rec: null, err: "Nu am putut citi contorul." }); });
    return () => ac.abort();
  }, [sel, adopt]);
  const cur = rec && rec.id === sel ? rec.rec : null;
  const f = form && cur && form.id === cur.id ? form : null;
  const dirty = !!f && !!cur && (f.ContorNr !== cur.ContorNr || f.lit !== fnum(cur.Instalation_Litres) || f.Aragaz !== cur.Aragaz || f.Cazan !== cur.Cazan || f.Incalzire !== cur.Incalzire || f.mod !== cur.ModuleWriteInitial || f.loc !== cur.locationModule || f.com !== cur.Comments);
  const valid = !!f && !!cur && f.ContorNr.trim() !== "" && f.lit.trim() !== "" && cur.latitude !== null && cur.longitude !== null && cur.hasPhoto;

  const post = useCallback(async (id: string, body: unknown): Promise<InstallerRecord> => {
    const r = await fetch(`/api/installer/meters/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as InstallerRecord & { error?: string };
    if (!r.ok) throw new Error(j.error ?? "Eroare.");
    return j;
  }, []);
  /** după o salvare imediată (locație / poză) se reîmprospătează datele, dar câmpurile pe care utilizatorul le editează rămân */
  const keep = useCallback((r: InstallerRecord) => setRec({ id: r.id, rec: r, err: null }), []);

  /* ───────── acțiuni: locație, poză, QR ───────── */
  const saveLocation = useCallback((id: string, withTimeseries = false) => {
    if (!navigator.geolocation) { toast(MSG.geoUnsupported, false, 4000); return; }
    toast(MSG.gpsAccess, true, 2000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { void post(id, { latitude: pos.coords.latitude, longitude: pos.coords.longitude }).then((r) => { keep(r); setReload((n) => n + 1); toast(withTimeseries ? MSG.locationUpdatedTs : MSG.locationUpdated); }).catch((e: Error) => toast(MSG.locationSaveFailed + e.message, false, 4000)); },
      (e) => toast(e.code === 1 ? MSG.geoDenied : e.code === 2 ? MSG.geoUnavailable : e.code === 3 ? MSG.geoTimeout : MSG.geoDefault, false, 4000),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }, [post, toast, keep]);

  const uploadPhoto = useCallback(async (id: string, blob: Blob) => {
    const r = await fetch(`/api/installer/meters/${id}/photo`, { method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob });
    const j = (await r.json().catch(() => ({}))) as InstallerRecord & { error?: string };
    if (!r.ok) throw new Error(j.error ?? "Eroare la salvarea atributului.");
    keep(j); setPv((n) => n + 1); setReload((n) => n + 1);
  }, [keep]);

  const onDropFile = async (file: File | undefined) => {
    const id = sel; if (!file || !id) return;
    try { await uploadPhoto(id, file); toast(MSG.imageSaved); } catch (e) { toast((e as Error).message, false, 4000); }
  };
  const openCamera = (id: string | null) => { if (!id) return; setCamFor(id); setSel(id); setDlg({ kind: "camera" }); };

  const onScan = useCallback(async (text: string) => {
    setDlg(null);
    try {
      const r = await fetch(`/api/installer/meters?code=${encodeURIComponent(text)}`, { cache: "no-store" });
      const j = (await r.json()) as { name: string | null; found: { id: string; name: string } | null; total: number };
      if (!j.name) { setDlg({ kind: "alert", title: MSG.qrNotFound }); return; }
      setFilter(j.name); setQ(""); setPage(0);
      void fetch("/api/installer/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: j.name }) });
      if (!j.found) { setDlg({ kind: "alert", title: qrNotInDb(j.name, j.total) }); return; }
      const id = j.found.id;
      setSel(id);
      void post(id, { QR_Code: text.slice(0, 500), QR_format: "QR_CODE" }).then(() => toast(MSG.qrSaved)).catch(() => undefined);
      setTimeout(() => { setGreen(true); saveLocation(id); setTimeout(() => setGreen(false), 500); }, 1000); // ca în SCADA: după scanare se salvează automat și locația
    } catch { setDlg({ kind: "alert", title: MSG.qrNotFound }); }
  }, [saveLocation, post, toast]);

  /* ───────── formularul: Salvează / Anulează Ultima Comandă ───────── */
  const update = async () => {
    if (!cur || !f || !valid || !dirty) return;
    setBusy(true);
    try {
      adopt(await post(cur.id, { ContorNr: f.ContorNr, Instalation_Litres: f.lit, Aragaz: f.Aragaz, Cazan: f.Cazan, Incalzire: f.Incalzire, ModuleWriteInitial: f.mod, locationModule: f.loc, Comments: f.com }));
      toast(MSG.updated); setReload((n) => n + 1);
    } catch (x) { toast(`${MSG.updateFailed}: ${(x as Error).message}`, false, 4000); }
    setBusy(false);
  };
  const undo = () => { if (cur) { setForm(toForm(cur)); setTouched({}); } };

  const total = list?.data?.total ?? 0;
  const rows: InstallerRow[] = list?.data?.rows ?? [];
  const loading = !list || list.key !== key;
  const cols = useMemo(() => LIST_COLUMNS.filter((c) => !hidden.includes(c.key)), [hidden]);
  const toggleCol = (k: string) => setHidden((h) => { const n = h.includes(k) ? h.filter((x) => x !== k) : [...h, k]; try { localStorage.setItem(COL_KEY, JSON.stringify(n)); } catch { /* fără stocare locală */ } return n; });
  // size 0 = «All»: toate rândurile pe o singură pagină
  const from = total === 0 ? 0 : size ? page * size + 1 : 1, to = size ? Math.min(total, (page + 1) * size) : total;
  const lastPage = size ? Math.max(0, Math.ceil(total / size) - 1) : 0;
  // liste mari (200 / 500 / 1000 / toate): se desenează doar rândurile din fereastra vizibilă (50 px fiecare), restul sunt spații goale — telefonul nu îngheață
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollRow, setScrollRow] = useState(0);
  const [viewRows, setViewRows] = useState(16);
  const syncScroll = useCallback(() => { const w = wrapRef.current; if (!w) return; setScrollRow(Math.floor(w.scrollTop / ROW_H)); setViewRows(Math.ceil(w.clientHeight / ROW_H) + 1); }, []);
  const listKey = list?.key;
  useEffect(() => { const w = wrapRef.current; if (w) w.scrollTop = 0; const t = setTimeout(syncScroll, 0); return () => clearTimeout(t); }, [listKey, syncScroll]);
  const windowed = rows.length > WINDOW_MIN;
  const w0 = windowed ? Math.max(0, scrollRow - OVERSCAN) : 0, w1 = windowed ? Math.min(rows.length, scrollRow + viewRows + OVERSCAN) : rows.length;
  const photoUrl = cur?.hasPhoto ? `/api/meters/${cur.id}/photo?v=${pv}` : null;
  const draft = filterDraft ?? filter;
  const filterDirty = filterDraft !== null && filterDraft !== filter;
  const sortKey = (k: string) => (k === "active" ? "ActiveTime" : k);
  const sortBy = (k: string) => { const s2 = sortKey(k); setSort((s) => ({ key: s2, dir: s.key === s2 && s.dir === "asc" ? "desc" : "asc", user: true })); setPage(0); };
  const cell = (r: InstallerRow, k: string): React.ReactNode => {
    if (k === "name") return r.name;
    if (k === "active") return <span className="tbx-dot" style={{ background: activity(r.lastActivityTime, now).dot }} role="img" aria-label="active" />;
    if (k === "ActiveTime") { const a = activity(r.lastActivityTime, now); return <span style={{ color: a.color }}>{a.text}</span>; }
    if (k === "lastActivityTime") return fdt(r.lastActivityTime);
    const v = (r as unknown as Record<string, number | null>)[k];
    return v === null || v === undefined ? "" : String(v);
  };
  const cleared = useRef(false);
  const logout = async (e: React.FormEvent<HTMLFormElement>) => { if (cleared.current) return; e.preventDefault(); const fm = e.currentTarget; await clearMeterCaches(); cleared.current = true; fm.requestSubmit(); };
  const mapLabel = cur ? `${cur.name}${cur.lastActivityTime ? `, ${fdt(cur.lastActivityTime)}` : ""}` : "";
  const toSelect = () => { selectRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); selectRef.current?.querySelector("input")?.focus(); };

  const field = (k: "ContorNr" | "lit" | "com", label: string, o: { req?: boolean; type?: string; max?: number } = {}) => {
    const val = f ? f[k] : "";
    const bad = !!o.req && !!touched[k] && val.trim() === "";
    return (
      <label className={`tbx-ff${bad ? " bad" : ""}`} key={k}>
        <input value={val} maxLength={o.max} inputMode={o.type === "num" ? "decimal" : undefined} placeholder=" " aria-required={o.req} aria-invalid={bad}
          onChange={(e) => f && setForm({ ...f, [k]: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, [k]: true }))} />
        <span>{label}{o.req ? " *" : ""}</span><i />
        {bad && <em>Required</em>}
      </label>
    );
  };
  const check = (k: "Aragaz" | "Cazan" | "Incalzire" | "mod", label: string) => (
    <label className="tbx-cb" key={k}><input type="checkbox" checked={!!f?.[k]} onChange={(e) => f && setForm({ ...f, [k]: e.target.checked })} /><i aria-hidden="true" /><span>{label}</span></label>
  );

  return (
    <div className="tbx" onClick={() => { setColMenu(false); setRowMenu(null); setMenu(false); }}>
      {/* bara de sus (toolbar-ul dashboardului) */}
      <header className="tbx-tool">
        <div className="tbx-tool-row1">
          <h1>{STATE_TITLE}</h1>
          <div className="tbx-rel" style={{ display: "flex", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
            {/* buton de ieșire mereu la vedere (instalatorul nu are nevoie de aplicația principală) */}
            <form action={logoutAction} onSubmit={logout}><button type="submit" className="tbx-iconbtn tbx-white" aria-label="Ieșire" title="Ieșire / Sign out"><Ico n="logout" /></button></form>
            {canHome && <Btn n="more_vert" label="Meniu" className="tbx-white" onClick={() => setMenu(!menu)} />}
            {canHome && menu && (
              <div className="tbx-menu tbx-menu-r" role="menu">
                <Link className="tbx-mi" href="/" role="menuitem"><Ico n="home" /> Moldovagaz</Link>
                <form action={logoutAction} onSubmit={logout}><button type="submit" className="tbx-mi" role="menuitem"><Ico n="logout" /> Sign out</button></form>
              </div>
            )}
          </div>
        </div>
        <div className="tbx-tool-row2">
          <Btn n="devices_other" label="Entity aliases" className="tbx-white" onClick={toSelect} />
          <Btn n="filter_list" label="Filters" className="tbx-white" onClick={toSelect} />
          <Btn n="access_time" label="Timewindow" className="tbx-white" disabled />
          <Btn n="file_download" label="Export" className="tbx-white" disabled />
        </div>
      </header>

      <div className="tbx-grid">
        {/* 5. Select Device */}
        <section className="tbx-w tbx-w-select" aria-label="Select Device" ref={selectRef}>
          <header className="tbx-wh"><h3>Select Device</h3></header>
          <div className="tbx-wb">
            <label className="tbx-ff"><input value={draft} onChange={(e) => setFilterDraft(e.target.value)} placeholder=" " aria-label="FilterDevices" /><span>FilterDevices</span><i /></label>
            <div className="tbx-actions">
              <button type="button" className="tbx-btn" disabled={!filterDirty} onClick={() => setFilterDraft(null)}>{MSG.undo}</button>
              <button type="button" className="tbx-btn tbx-raised tbx-primary" disabled={!filterDirty} onClick={() => {
                const v = (filterDraft ?? "").trim(); setFilter(v); setFilterDraft(null); setPage(0);
                void fetch("/api/installer/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: v }) }).then(() => toast(MSG.updated));
              }}>{MSG.save}</button>
            </div>
          </div>
        </section>

        {/* 1. Device admin table */}
        <section className={`tbx-w tbx-w-table${full === "table" ? " tbx-full" : ""}`} aria-label="Device admin table">
          <header className="tbx-wh">
            {searchOpen ? <input className="tbx-search" autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search" aria-label="Search" /> : <h3>Device admin table</h3>}
            <span className="tbx-spacer" />
            <Btn n="qr_code_scanner" label="QR-Scan(Web)" onClick={() => setDlg({ kind: "scan" })} />
            <Btn n={searchOpen ? "close" : "search"} label={searchOpen ? "Close search" : "Search"} onClick={() => { if (searchOpen) setQ(""); setSearchOpen(!searchOpen); }} />
            <div className="tbx-rel" onClick={(e) => e.stopPropagation()}>
              <Btn n="view_column" label="Select columns to display" onClick={() => setColMenu(!colMenu)} />
              {colMenu && <div className="tbx-menu tbx-menu-r" role="menu">{LIST_COLUMNS.map((c) => <label key={c.key} className="tbx-mi tbx-mi-chk"><input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}</label>)}</div>}
            </div>
            <Btn n={full === "table" ? "fullscreen_exit" : "fullscreen"} label={full === "table" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "table" ? null : "table")} />
          </header>
          <div className="tbx-table-wrap" ref={wrapRef} onScroll={windowed ? syncScroll : undefined}>
            <table className="tbx-table">
              <thead><tr>
                {cols.map((c) => (
                  <th key={c.key} className={c.num ? "num" : ""} onClick={() => sortBy(c.key)} aria-sort={sort.key === sortKey(c.key) ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <span>{c.label}</span>{sort.user && sort.key === sortKey(c.key) && <span className={`tbx-sort ${sort.dir}`}><Ico n="arrow_upward" s={16} /></span>}
                  </th>
                ))}
                <th className="tbx-sticky-a" aria-label="Actions" />
              </tr></thead>
              <tbody>
                {windowed && w0 > 0 && <tr aria-hidden="true"><td colSpan={cols.length + 1} style={{ height: w0 * ROW_H, padding: 0, border: 0 }} /></tr>}
                {rows.slice(w0, w1).map((r) => (
                  <tr key={r.id} className={sel === r.id ? "sel" : ""} onClick={() => setSel(r.id)}>
                    {cols.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{cell(r, c.key)}</td>)}
                    <td className="tbx-sticky-a" onClick={(e) => e.stopPropagation()}>
                      <span className="tbx-act-inline"><Btn n="photo_camera" label="Photo" onClick={() => openCamera(r.id)} /><Btn n="add_location" label="LocationBrowser" onClick={() => { setSel(r.id); saveLocation(r.id, true); }} /></span>
                      <span className="tbx-act-more"><Btn n="more_vert" label="Acțiuni" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setRowMenu({ id: r.id, x: b.right, y: b.bottom }); e.stopPropagation(); }} /></span>
                    </td>
                  </tr>
                ))}
                {windowed && w1 < rows.length && <tr aria-hidden="true"><td colSpan={cols.length + 1} style={{ height: (rows.length - w1) * ROW_H, padding: 0, border: 0 }} /></tr>}
                {!loading && rows.length === 0 && !list?.err && <tr><td colSpan={cols.length + 1} className="tbx-empty">No entities found</td></tr>}
                {list?.err && <tr><td colSpan={cols.length + 1} className="tbx-empty" role="alert">{list.err}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="tbx-pager">
            <span className="tbx-ps">Items per page:</span>
            <select className="tbx-ps" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} aria-label="Items per page">{PAGE_SIZES.map((n) => <option key={n} value={n}>{n === 0 ? "All" : n}</option>)}</select>
            <span className="tbx-range">{from} – {to} of {total}</span>
            <Btn n="first_page" label="First page" onClick={() => setPage(0)} disabled={page === 0} />
            <Btn n="chevron_left" label="Previous page" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} />
            <Btn n="chevron_right" label="Next page" onClick={() => setPage((p) => p + 1)} disabled={to >= total} />
            <Btn n="last_page" label="Last page" onClick={() => setPage(lastPage)} disabled={to >= total} />
          </footer>
        </section>

        {/* 2. Meter Update */}
        <section className="tbx-w tbx-w-update" aria-label="Meter Update">
          <header className="tbx-wh">
            <h3>Meter Update</h3><span className="tbx-spacer" />
            <Btn n="pin_drop" label="Location" onClick={() => sel && saveLocation(sel)} disabled={!sel} className={green ? "tbx-green" : ""} />
            <Btn n="visibility" label="Foto" onClick={() => setView(true)} disabled={!photoUrl} />
            <Btn n="add_location" label="LocationBrowser" onClick={() => sel && saveLocation(sel)} disabled={!sel} />
            <Btn n="add_a_photo" label="PhotoBrowser" onClick={() => openCamera(sel)} disabled={!sel} />
          </header>
          <div className="tbx-wb">
            {!sel && <p className="tbx-hint">No entity selected</p>}
            {sel && !cur && !rec?.err && <p className="tbx-hint">…</p>}
            {rec?.err && rec.id === sel && <p className="tbx-err" role="alert">{rec.err}</p>}
            {cur && f && (
              <form onSubmit={(e) => { e.preventDefault(); void update(); }} noValidate>
                <fieldset className="tbx-group"><legend>{cur.name}</legend>
                  {field("ContorNr", "Contor Serial Number (Серийный номер счетчика газа)", { req: true, max: 40 })}
                  {field("lit", "Instalation Litres (Показание при установке ,литров)", { req: true, type: "num" })}
                  <label className="tbx-ff"><input value={fnum(cur.latitude)} readOnly placeholder=" " aria-required="true" /><span>latitude *</span><i /></label>
                  <label className="tbx-ff"><input value={fnum(cur.longitude)} readOnly placeholder=" " aria-required="true" /><span>longitude *</span><i /></label>
                  <label className="tbx-ff"><input value={cur.hasPhoto ? "image" : ""} readOnly placeholder=" " aria-required="true" /><span>image *</span><i /></label>
                  {check("Aragaz", "Aragaz")}{check("Cazan", "Cazan")}{check("Incalzire", "Incalzire")}{check("mod", "Module Calibration")}
                  <label className="tbx-ff tbx-sel">
                    <select value={f.loc} onChange={(e) => setForm({ ...f, loc: e.target.value })} aria-label="Localitate"><option value="" />{cur.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                    <span>Localitate</span><i /><b aria-hidden="true"><Ico n="arrow_drop_down" /></b>
                  </label>
                  {field("com", "Comments", { max: 2000 })}
                  <label className="tbx-ff tbx-dis"><b className="tbx-pre" aria-hidden="true"><Ico n="event" /></b><input value={fdt(cur.lastActivityTime)} disabled placeholder=" " /><span>lastActivityTime</span><i /></label>
                </fieldset>
                <div className="tbx-actions">
                  <button type="button" className="tbx-btn" disabled={!dirty || busy} onClick={undo}>{MSG.undo}</button>
                  <button type="submit" className="tbx-btn tbx-raised tbx-primary" disabled={!valid || !dirty || busy}>{MSG.save}</button>
                </div>
              </form>
            )}
          </div>
        </section>

        {/* 4. Instalation Photo */}
        <section className={`tbx-w tbx-w-photo${full === "photo" ? " tbx-full" : ""}`} aria-label="Instalation Photo">
          <header className="tbx-wh"><h3>Instalation Photo</h3><span className="tbx-spacer" /><Btn n={full === "photo" ? "fullscreen_exit" : "fullscreen"} label={full === "photo" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "photo" ? null : "photo")} /></header>
          <div className="tbx-wb tbx-photo">
            {photoUrl ? (
              <button type="button" className="tbx-photo-btn" onClick={() => setView(true)} aria-label="Zoom photo" title="Zoom">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt={`Instalation photo ${cur?.name ?? ""}`} />
              </button>
            ) : null}
          </div>
        </section>

        {/* 3. Installation foto (doar pe ecran lat, ca în SCADA) */}
        <section className="tbx-w tbx-w-foto" aria-label="Installation foto">
          <header className="tbx-wh"><h3>Installation foto</h3></header>
          <div className="tbx-wb">
            <div className={`tbx-drop${sel ? "" : " off"}`} role="button" tabIndex={sel ? 0 : -1} aria-disabled={!sel}
              onClick={() => sel && fileDrop.current?.click()} onKeyDown={(e) => { if (sel && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); fileDrop.current?.click(); } }}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onDropFile(e.dataTransfer.files?.[0]); }}>
              <Ico n="add_a_photo" s={32} /><span>Drop an image here or click to select</span>
            </div>
          </div>
        </section>

        {/* 6. Module Location */}
        <section className={`tbx-w tbx-w-loc${full === "loc" ? " tbx-full" : ""}`} aria-label="Module Location">
          <header className="tbx-wh"><h3>Module Location</h3><span className="tbx-spacer" /><Btn n={full === "loc" ? "fullscreen_exit" : "fullscreen"} label={full === "loc" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "loc" ? null : "loc")} /></header>
          <div className="tbx-wb tbx-wb0"><ModuleMap name={cur?.name ?? ""} label={mapLabel} la={cur?.latitude ?? null} lo={cur?.longitude ?? null} /></div>
        </section>
      </div>

      <input ref={fileDrop} type="file" accept="image/*" hidden onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; void onDropFile(x); }} aria-label="Select image" />

      {rowMenu && (
        <div className="tbx-menu tbx-menu-fixed" style={{ top: Math.min(rowMenu.y, window.innerHeight - 120), left: Math.max(8, rowMenu.x - 220) }} role="menu" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="tbx-mi" role="menuitem" onClick={() => { const id = rowMenu.id; setRowMenu(null); openCamera(id); }}><Ico n="photo_camera" /> Photo</button>
          <button type="button" className="tbx-mi" role="menuitem" onClick={() => { const id = rowMenu.id; setRowMenu(null); setSel(id); saveLocation(id, true); }}><Ico n="add_location" /> LocationBrowser</button>
        </div>
      )}

      {toastMsg && <div className={`tbx-toast${toastMsg.ok ? "" : " bad"}`} role="status" key={toastMsg.n}>{toastMsg.text.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div>}

      {dlg?.kind === "scan" && <QrScanner onResult={(t) => void onScan(t)} onCancel={() => setDlg({ kind: "alert", title: MSG.qrEmptyTitle, body: MSG.qrEmptyBody })} />}
      {dlg?.kind === "camera" && camFor && <CameraDialog onSave={(b) => uploadPhoto(camFor, b)} onClose={() => setDlg(null)} />}
      {dlg?.kind === "alert" && (
        <div className="tbx-back" role="alertdialog" aria-modal="true" aria-label={dlg.title.split("\n")[0]}>
          <div className="tbx-dialog">
            <div className="tbx-dialog-body"><h2 className="tbx-dtitle">{dlg.title.split("\n").map((l, i) => <div key={i}>{l}</div>)}</h2>{dlg.body && <p style={{ margin: "12px 0 0" }}>{dlg.body.split("\n").map((l, i) => <span key={i}>{l}<br /></span>)}</p>}</div>
            <div className="tbx-dialog-actions"><button type="button" className="tbx-btn tbx-text-primary" autoFocus onClick={() => setDlg(null)}>Ok</button></div>
          </div>
        </div>
      )}
      {view && cur && <PhotoViewer id={cur.id} title={cur.name} onClose={() => setView(false)} />}
    </div>
  );
}
