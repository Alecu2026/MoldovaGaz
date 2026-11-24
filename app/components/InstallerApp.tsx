"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIST_COLUMNS, MSG, type InstallerList, type InstallerRecord, type InstallerRow } from "@/lib/installer";
import PhotoViewer from "./PhotoViewer";

const QrScanner = dynamic(() => import("./QrScanner"), { ssr: false });

/**
 * Ecranul instalatorului: varianta noastră a dashboardului „ChisinauGaz_Instalator_App” din SCADA (aceleași 5 widgeturi, câmpuri, butoane și mesaje).
 * Datele introduse se salvează doar în baza noastră (nu în SCADA). Aspectul urmează tema ThingsBoard (clase `.tbx*` în globals.css).
 */
const P = {
  qr: "M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8-12v8h8V3h-8zm6 6h-4V5h4v4zm0 10h2v2h-2zM13 13h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm0-4h2v2h-2zm2 2h2v2h-2z",
  eye: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  pin: "M18 8c0-3.31-2.69-6-6-6S6 4.69 6 8c0 4.5 6 11 6 11s6-6.5 6-11zm-8 0c0-1.1.9-2 2-2s2 .9 2 2-.89 2-2 2c-1.1 0-2-.9-2-2zM5 20v2h14v-2H5z",
  ext: "M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z",
  more: "M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  search: "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  cols: "M10 18h5V5h-5v13zm-6 0h5V5H4v13zM16 5v13h5V5h-5z",
  full: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  up: "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z",
  prev: "M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  next: "M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  cam: "M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z",
};
const Ico = ({ d, size = 24 }: { d: string; size?: number }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d={d} /></svg>;
const Btn = ({ d, label, onClick, disabled, className = "", children }: { d: string; label: string; onClick?: () => void; disabled?: boolean; className?: string; children?: React.ReactNode }) => (
  <button type="button" className={`tbx-iconbtn ${className}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}><Ico d={d} />{children}</button>
);

const p2 = (n: number) => String(n).padStart(2, "0");
const fdt = (ms: number | null) => { if (!ms) return ""; const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const fnum = (v: number | null) => (v === null ? "" : Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));
const cellOf = (r: InstallerRow, k: string): React.ReactNode => {
  if (k === "active") return <span className="tbx-dot" style={{ color: r.active === true ? "rgb(39, 134, 34)" : "rgb(255, 0, 0)" }} aria-label={r.active === true ? "active" : "inactive"}>&#11044;</span>;
  if (k === "lastActivityTime") return fdt(r.lastActivityTime);
  const v = (r as unknown as Record<string, unknown>)[k];
  return typeof v === "number" ? fnum(v) : String(v ?? "");
};
const COL_KEY = "mg-installer-cols";

/** Micșorează poza înainte de trimitere (telefoanele fac poze de 5–10 MB): cel mult 1800 px, JPEG. Dacă nu se poate (ex. HEIC), trimite originalul. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const b = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.86));
    return b ?? file;
  } catch { return file; }
}

type Dlg = { kind: "alert"; title: string; body?: string } | { kind: "photo"; url: string } | { kind: "scan" } | null;
type Rec = { id: string; rec: InstallerRecord | null; err: string | null };

export default function InstallerApp() {
  /* ───────── lista (Device admin table) ───────── */
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [filterDraft, setFilterDraft] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => { const t = setTimeout(() => { try { const v = JSON.parse(localStorage.getItem(COL_KEY) ?? "[]") as string[]; if (Array.isArray(v)) setHidden(v); } catch { /* fără stocare locală */ } }, 0); return () => clearTimeout(t); }, []);
  const [colMenu, setColMenu] = useState(false);
  const [list, setList] = useState<{ key: string; data: InstallerList | null; err: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const eff = q.trim() || filter.trim();
  const key = `${eff}|${page}|${size}|${sort.key}|${sort.dir}|${reload}`;

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      void fetch(`/api/installer/meters?q=${encodeURIComponent(eff)}&page=${page}&size=${size}&sort=${sort.key}&dir=${sort.dir}`, { signal: ac.signal, cache: "no-store" })
        .then(async (r) => { if (r.status === 401) { window.location.replace("/login"); return; } if (!r.ok) throw new Error(String(r.status)); setList({ key, data: (await r.json()) as InstallerList, err: null }); })
        .catch((e: Error) => { if (e.name !== "AbortError") setList({ key, data: null, err: "Nu am putut citi lista." }); });
    }, q ? 250 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [key, eff, page, size, sort.key, sort.dir, q]);

  useEffect(() => {
    void fetch("/api/installer/prefs", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: { filter?: string } | null) => { if (j?.filter) setFilter(j.filter); }).catch(() => undefined);
  }, []);

  /* ───────── contorul ales (formularul + poza) ───────── */
  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [form, setForm] = useState<{ id: string; ContorNr: string; lit: string; mod: boolean; com: string } | null>(null);
  const [pv, setPv] = useState(0);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; ok: boolean; n: number } | null>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [view, setView] = useState(false);
  const [green, setGreen] = useState(false);
  const fileHeader = useRef<HTMLInputElement>(null);
  const fileDrop = useRef<HTMLInputElement>(null);
  const targetRow = useRef<string | null>(null);

  const toast = useCallback((text: string, ok = true) => setToastMsg({ text, ok, n: Date.now() }), []);
  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), 3500); return () => clearTimeout(t); }, [toastMsg]);

  const adopt = useCallback((r: InstallerRecord) => {
    setRec({ id: r.id, rec: r, err: null });
    setForm({ id: r.id, ContorNr: r.ContorNr, lit: fnum(r.Instalation_Litres), mod: r.ModuleWriteInitial, com: r.Comments });
    setErrs({});
  }, []);
  useEffect(() => {
    if (!sel) return;
    const ac = new AbortController();
    void fetch(`/api/installer/meters/${sel}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); adopt((await r.json()) as InstallerRecord); })
      .catch((e: Error) => { if (e.name !== "AbortError") setRec({ id: sel, rec: null, err: "Nu am putut citi contorul." }); });
    return () => ac.abort();
  }, [sel, adopt]);
  const cur = rec && rec.id === sel ? rec.rec : null;
  const dirty = !!cur && !!form && form.id === cur.id && (form.ContorNr !== cur.ContorNr || form.lit !== fnum(cur.Instalation_Litres) || form.mod !== cur.ModuleWriteInitial || form.com !== cur.Comments);

  const post = useCallback(async (id: string, body: unknown): Promise<InstallerRecord | null> => {
    const r = await fetch(`/api/installer/meters/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as InstallerRecord & { error?: string };
    if (!r.ok) throw new Error(j.error ?? "Eroare.");
    return j;
  }, []);

  /* ───────── acțiuni: locație, poză, QR ───────── */
  const keep = useCallback((r: InstallerRecord | null) => { if (!r) return; setRec({ id: r.id, rec: r, err: null }); setErrs((e) => ({ ...e, latitude: "", longitude: "", image: "" })); }, []);
  const saveLocation = useCallback(async (id: string, showDialog: boolean) => {
    if (!navigator.geolocation) { setDlg({ kind: "alert", title: MSG.locationCanceled }); return; }
    const pos = await new Promise<GeolocationPosition | null>((res) => navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }));
    if (!pos) { setDlg({ kind: "alert", title: MSG.locationCanceled }); return; }
    const { latitude, longitude } = pos.coords;
    if (showDialog) setDlg({ kind: "alert", title: "Location", body: `Latitude: ${latitude}\nLongitude: ${longitude}` });
    try { keep(await post(id, { latitude, longitude })); toast(MSG.locationSaved); } catch { setDlg({ kind: "alert", title: MSG.locationFailed }); }
  }, [post, toast, keep]);

  const uploadPhoto = useCallback(async (id: string, file: File, showDialog: boolean) => {
    try {
      const blob = await shrink(file);
      const r = await fetch(`/api/installer/meters/${id}/photo`, { method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob });
      const j = (await r.json().catch(() => ({}))) as InstallerRecord & { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Eroare.");
      keep(j); setPv((n) => n + 1);
      if (showDialog) setDlg({ kind: "photo", url: URL.createObjectURL(blob) });
      toast(MSG.imageSaved);
    } catch { setDlg({ kind: "alert", title: MSG.imageFailed }); }
  }, [toast, keep]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>, showDialog: boolean) => {
    const f = e.target.files?.[0]; e.target.value = "";
    const id = targetRow.current ?? sel;
    if (f && id) void uploadPhoto(id, f, showDialog); else if (!f) setDlg({ kind: "alert", title: MSG.photoCanceled });
  };
  const pick = (id: string | null, input: React.RefObject<HTMLInputElement | null>) => { if (!id) return; targetRow.current = id; input.current?.click(); };

  const onScan = useCallback(async (text: string) => {
    setDlg(null);
    try {
      const r = await fetch(`/api/installer/meters?code=${encodeURIComponent(text)}`, { cache: "no-store" });
      const j = (await r.json()) as { name: string | null; found: { id: string; name: string } | null };
      if (!j.name) { setDlg({ kind: "alert", title: MSG.qrNotFound }); return; }
      setFilter(j.name); setQ(""); setPage(0);
      void fetch("/api/installer/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: j.name }) });
      if (!j.found) { setDlg({ kind: "alert", title: MSG.qrNotFound }); return; }
      setSel(j.found.id);
      setGreen(true); setTimeout(() => setGreen(false), 1500);
      setTimeout(() => void saveLocation(j.found!.id, false), 1000); // ca în SCADA: după scanare se salvează automat și locația
    } catch { setDlg({ kind: "alert", title: MSG.qrNotFound }); }
  }, [saveLocation]);

  /* ───────── formularul: Update / Undo ───────── */
  const update = async () => {
    if (!cur || !form) return;
    const e: Record<string, string> = {};
    if (cur.latitude === null || cur.longitude === null) { e.latitude = MSG.locationRequired; e.longitude = MSG.locationRequired; }
    if (!cur.hasPhoto) e.image = "Required";
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      adopt((await post(cur.id, { ContorNr: form.ContorNr, Instalation_Litres: form.lit === "" ? null : form.lit, ModuleWriteInitial: form.mod, Comments: form.com })) as InstallerRecord);
      toast(MSG.updated); setReload((n) => n + 1);
    } catch (x) { toast(`${MSG.updateFailed}: ${(x as Error).message}`, false); }
    setBusy(false);
  };
  const undo = () => { if (cur) { setForm({ id: cur.id, ContorNr: cur.ContorNr, lit: fnum(cur.Instalation_Litres), mod: cur.ModuleWriteInitial, com: cur.Comments }); setErrs({}); } };

  const total = list?.data?.total ?? 0;
  const rows = list?.data?.rows ?? [];
  const loading = !list || list.key !== key;
  const cols = useMemo(() => LIST_COLUMNS.filter((c) => !hidden.includes(c.key)), [hidden]);
  const toggleCol = (k: string) => setHidden((h) => { const n = h.includes(k) ? h.filter((x) => x !== k) : [...h, k]; try { localStorage.setItem(COL_KEY, JSON.stringify(n)); } catch { /* fără stocare locală */ } return n; });
  const from = total === 0 ? 0 : page * size + 1, to = Math.min(total, (page + 1) * size);
  const photoUrl = cur?.hasPhoto ? `/api/meters/${cur.id}/photo?v=${pv}` : null;
  const draft = filterDraft ?? filter;
  const [full, setFull] = useState<string | null>(null);

  return (
    <div className="tbx">
      <div className="tbx-grid">
        {/* 1. Device admin table */}
        <section className={`tbx-w tbx-w-table${full === "table" ? " tbx-full" : ""}`} aria-label="Device admin table">
          <header className="tbx-wh">
            <h3>Device admin table</h3>
            <span className="tbx-spacer" />
            {searchOpen && <input className="tbx-search" autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search" aria-label="Search" />}
            <Btn d={searchOpen ? P.close : P.search} label={searchOpen ? "Close search" : "Search"} onClick={() => { if (searchOpen) { setQ(""); } setSearchOpen(!searchOpen); }} />
            <div className="tbx-rel">
              <Btn d={P.cols} label="Select columns to display" onClick={() => setColMenu(!colMenu)} />
              {colMenu && <div className="tbx-menu" role="menu">{LIST_COLUMNS.map((c) => <label key={c.key} className="tbx-chk"><input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}</label>)}</div>}
            </div>
            <Btn d={P.qr} label="ScanQR" onClick={() => setDlg({ kind: "scan" })} />
            <Btn d={P.full} label={full === "table" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "table" ? null : "table")} />
          </header>
          <div className="tbx-table-wrap">
            <table className="tbx-table">
              <thead><tr>
                {cols.map((c) => (
                  <th key={c.key} className={c.num ? "num" : ""} onClick={() => { setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === "asc" ? "desc" : "asc" })); setPage(0); }} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <span>{c.label}</span>{sort.key === c.key && <span className={`tbx-sort ${sort.dir}`}><Ico d={P.up} size={16} /></span>}
                  </th>
                ))}
                <th className="tbx-sticky-a" aria-label="Actions" />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={sel === r.id ? "sel" : ""} onClick={() => setSel(r.id)}>
                    {cols.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{cellOf(r, c.key)}</td>)}
                    <td className="tbx-sticky-a" onClick={(e) => e.stopPropagation()}>
                      <Btn d={P.eye} label="Foto" onClick={() => { setSel(r.id); pick(r.id, fileHeader); }} />
                      <Btn d={P.pin} label="Location" onClick={() => { setSel(r.id); void saveLocation(r.id, true); }} />
                      <Btn d={P.more} label="state_row" onClick={() => setSel(r.id)} />
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && <tr><td colSpan={cols.length + 1} className="tbx-empty">No devices found</td></tr>}
                {list?.err && <tr><td colSpan={cols.length + 1} className="tbx-empty" role="alert">{list.err}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="tbx-pager">
            <span>Items per page:</span>
            <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} aria-label="Items per page">{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <span className="tbx-range">{from} – {to} of {total.toLocaleString("en-US")}</span>
            <Btn d={P.prev} label="Previous page" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} />
            <Btn d={P.next} label="Next page" onClick={() => setPage((p) => p + 1)} disabled={to >= total} />
          </footer>
        </section>

        {/* 5. Select Device */}
        <section className="tbx-w tbx-w-select" aria-label="Select Device">
          <header className="tbx-wh"><h3>Select Device</h3></header>
          <div className="tbx-wb">
            <label className="tbx-field"><span>FilterDevices</span>
              <input value={draft} onChange={(e) => setFilterDraft(e.target.value)} aria-label="FilterDevices" />
            </label>
            <div className="tbx-actions">
              <button type="button" className="tbx-btn" disabled={filterDraft === null || filterDraft === filter} onClick={() => setFilterDraft(null)}>Undo</button>
              <button type="button" className="tbx-btn tbx-primary" disabled={filterDraft === null || filterDraft === filter} onClick={() => {
                const v = (filterDraft ?? "").trim(); setFilter(v); setFilterDraft(null); setPage(0);
                void fetch("/api/installer/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: v }) }).then(() => toast(MSG.updated));
              }}>Update</button>
            </div>
          </div>
        </section>

        {/* 2. Meter Update */}
        <section className="tbx-w tbx-w-update" aria-label="Meter Update">
          <header className="tbx-wh">
            <h3>Meter Update</h3><span className="tbx-spacer" />
            <Btn d={P.pin} label="Location" onClick={() => sel && void saveLocation(sel, false)} disabled={!sel} className={green ? "tbx-green" : ""} />
            <Btn d={P.eye} label="Foto" onClick={() => pick(sel, fileHeader)} disabled={!sel} />
            <Btn d={P.ext} label="Update" onClick={() => void update()} disabled={!cur || busy} />
          </header>
          <div className="tbx-wb">
            {!sel && <p className="tbx-hint">Select a device in the table or scan its QR code.</p>}
            {sel && !cur && !rec?.err && <p className="tbx-hint">…</p>}
            {rec?.err && rec.id === sel && <p className="tbx-err" role="alert">{rec.err}</p>}
            {cur && form && (
              <form onSubmit={(e) => { e.preventDefault(); void update(); }} noValidate>
                <h4 className="tbx-group">{cur.name}</h4>
                <div className="tbx-fields">
                  <label className="tbx-field"><span>SerialMeter</span><input value={form.ContorNr} onChange={(e) => setForm({ ...form, ContorNr: e.target.value })} maxLength={40} /></label>
                  <label className="tbx-field"><span>Install_Litres</span><input inputMode="decimal" value={form.lit} onChange={(e) => setForm({ ...form, lit: e.target.value })} /></label>
                  <label className={`tbx-field${errs.latitude ? " bad" : ""}`}><span>latitude *</span><input value={fnum(cur.latitude)} readOnly aria-invalid={!!errs.latitude} />{errs.latitude && <em>{errs.latitude}</em>}</label>
                  <label className={`tbx-field${errs.longitude ? " bad" : ""}`}><span>longitude *</span><input value={fnum(cur.longitude)} readOnly aria-invalid={!!errs.longitude} />{errs.longitude && <em>{errs.longitude}</em>}</label>
                  <label className={`tbx-field${errs.image ? " bad" : ""}`}><span>image *</span><input value={cur.hasPhoto ? (cur.photoSource === "installer" ? "image saved" : "image from SCADA") : ""} readOnly aria-invalid={!!errs.image} />{errs.image && <em>{errs.image}</em>}</label>
                  <label className="tbx-field tbx-check"><input type="checkbox" checked={form.mod} onChange={(e) => setForm({ ...form, mod: e.target.checked })} /> <span>Module Calibration</span></label>
                  <label className="tbx-field"><span>Comments</span><input value={form.com} onChange={(e) => setForm({ ...form, com: e.target.value })} maxLength={2000} /></label>
                  <label className="tbx-field"><span>lastActivityTime</span><input value={fdt(cur.lastActivityTime)} disabled /></label>
                </div>
                <div className="tbx-actions">
                  <button type="button" className="tbx-btn" disabled={!dirty || busy} onClick={undo}>Undo</button>
                  <button type="submit" className="tbx-btn tbx-primary" disabled={busy}>Update</button>
                </div>
              </form>
            )}
          </div>
        </section>

        {/* 4. Instalation Photo */}
        <section className={`tbx-w tbx-w-photo${full === "photo" ? " tbx-full" : ""}`} aria-label="Instalation Photo">
          <header className="tbx-wh"><h3>Instalation Photo</h3><span className="tbx-spacer" /><Btn d={P.full} label={full === "photo" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "photo" ? null : "photo")} /></header>
          <div className="tbx-wb tbx-photo">
            {photoUrl ? (
              <button type="button" className="tbx-photo-btn" onClick={() => setView(true)} aria-label="Zoom photo" title="Zoom">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt={`Instalation photo ${cur?.name ?? ""}`} />
              </button>
            ) : <p className="tbx-hint">{sel ? "No image" : ""}</p>}
          </div>
        </section>

        {/* 3. Installation foto Update */}
        <section className="tbx-w tbx-w-foto" aria-label="Installation foto Update">
          <header className="tbx-wh"><h3>Installation foto Update</h3></header>
          <div className="tbx-wb">
            <div className={`tbx-drop${sel ? "" : " off"}`} role="button" tabIndex={sel ? 0 : -1} aria-disabled={!sel}
              onClick={() => pick(sel, fileDrop)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(sel, fileDrop); } }}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && sel) void uploadPhoto(sel, f, false); }}>
              <Ico d={P.cam} size={36} /><span>Drop an image here or click to select</span>
            </div>
            {photoUrl && (
              <div className="tbx-prev"><span className="tbx-lbl">Preview</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt="Preview" />
              </div>
            )}
          </div>
        </section>
      </div>

      <input ref={fileHeader} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e, true)} aria-label="Take photo" />
      <input ref={fileDrop} type="file" accept="image/*" hidden onChange={(e) => onFile(e, false)} aria-label="Select image" />

      {toastMsg && <div className={`tbx-toast${toastMsg.ok ? "" : " bad"}`} role="status" key={toastMsg.n}>{toastMsg.text.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div>}

      {dlg?.kind === "scan" && <QrScanner onResult={(t) => void onScan(t)} onCancel={() => { setDlg({ kind: "alert", title: MSG.qrCanceled }); }} />}
      {dlg?.kind === "alert" && (
        <div className="tbx-back" role="alertdialog" aria-modal="true" aria-label={dlg.title.split("\n")[0]}>
          <div className="tbx-dialog">
            <div className="tbx-dialog-body"><h2 className="tbx-dtitle">{dlg.title.split("\n").map((l, i) => <div key={i}>{l}</div>)}</h2>{dlg.body && <p style={{ whiteSpace: "pre-line", margin: "12px 0 0" }}>{dlg.body}</p>}</div>
            <div className="tbx-dialog-actions"><button type="button" className="tbx-btn tbx-primary" autoFocus onClick={() => setDlg(null)}>Ok</button></div>
          </div>
        </div>
      )}
      {dlg?.kind === "photo" && (
        <div className="tbx-back" role="dialog" aria-modal="true" aria-label="Photo">
          <div className="tbx-dialog">
            <div className="tbx-toolbar"><h2>Photo</h2><span style={{ flex: 1 }} /><button type="button" className="tbx-iconbtn tbx-white" aria-label="Close" onClick={() => setDlg(null)}><Ico d={P.close} /></button></div>
            <div className="tbx-dialog-body" style={{ textAlign: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={dlg.url} alt="Photo" style={{ height: 300, maxWidth: "100%", objectFit: "contain" }} />
            </div>
            <div className="tbx-dialog-actions"><button type="button" className="tbx-btn" autoFocus onClick={() => setDlg(null)}>Close</button></div>
          </div>
        </div>
      )}
      {view && cur && <PhotoViewer id={cur.id} title={cur.name} onClose={() => setView(false)} />}
    </div>
  );
}
