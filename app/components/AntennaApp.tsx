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
import { AMSG, A_COLUMNS, fdtA, parseAntennaQr, queryAntennas, type AntennaList, type AntennaRecord, type AntennaRow } from "@/lib/antennas";
import { MSG } from "@/lib/installer";
import { ICON, type IconName } from "./tbicons";
import { clearMeterCaches } from "./useMeterStore";

const QrScanner = dynamic(() => import("./QrScanner"), { ssr: false });
const CameraDialog = dynamic(() => import("./CameraDialog"), { ssr: false });
const PhotoViewer = dynamic(() => import("./PhotoViewer"), { ssr: false });
const ModuleMap = dynamic(() => import("./ModuleMap"), { ssr: false, loading: () => <div className="tbx-map" /> });
const AntennasMap = dynamic(() => import("./AntennasMap"), { ssr: false, loading: () => <div className="tbx-map" /> });

/**
 * Ecranul instalatorului de antene: varianta noastră a aplicației din SCADA „Gateway_App” (dashboardul „Gateways_Lorawan_App”): Gateway admin table, Select Device, Gateway Update,
 * Instalation Photo, Installation foto, Harta_Instalator, Meters Location și mesajele primite pe zi; aceleași câmpuri, butoane și mesaje.
 * Datele introduse se salvează doar în baza noastră (nu în SCADA). Aspectul urmează tema ThingsBoard (clase `.tbx*` în globals.css, aceleași ca la ecranul contoarelor).
 */
const Ico = ({ n, s = 24 }: { n: IconName; s?: number }) => <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" aria-hidden="true"><path d={ICON[n]} /></svg>;
const Btn = ({ n, label, onClick, disabled, className = "" }: { n: IconName; label: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; className?: string }) => (
  <button type="button" className={`tbx-iconbtn ${className}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}><Ico n={n} /></button>
);
const SIZES = [10, 20, 50, 100, 0];
const COL_KEY = "mg-antenna-cols";
const TITLE = "Gateway_App";
const fnum = (v: number | null) => (v === null ? "" : String(v));

type Dlg = { kind: "alert"; title: string } | { kind: "scan" } | { kind: "camera" } | null;
type Form = { id: string; NumeInstalator: string; lat: string; lon: string; Instalta: boolean; Antena_mobila: boolean; NrTel_SIM: string; ip_address: string; Comments: string; Client: string };
const toForm = (r: AntennaRecord): Form => ({ id: r.id, NumeInstalator: r.NumeInstalator, lat: fnum(r.latitude), lon: fnum(r.longitude), Instalta: r.Instalta, Antena_mobila: r.Antena_mobila, NrTel_SIM: r.NrTel_SIM, ip_address: r.ip_address, Comments: r.Comments, Client: r.Client });
const parseNum = (s: string): number | null => { const t = s.trim().replace(",", "."); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

export type AntennaInitial = { filter: string; list: AntennaList | null };

export default function AntennaApp({ canHome = false, canEdit = true, initial }: { canHome?: boolean; /** poate salva (date, locație, poză)? fără — ecranul e doar de vizualizare */ canEdit?: boolean; initial?: AntennaInitial }) {
  /* ───────── lista (Gateway admin table) ───────── */
  const [list, setList] = useState<AntennaList | null>(initial?.list ?? null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState(initial?.filter ?? "");
  const [filterDraft, setFilterDraft] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(20);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc"; user?: boolean }>({ key: "active", dir: "desc" });
  const [hidden, setHidden] = useState<string[]>(() => A_COLUMNS.filter((c) => c.show === false).map((c) => c.key));
  const [colMenu, setColMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const eff = q.trim() || filter.trim();
  useEffect(() => { const t = setTimeout(() => { try { const v = JSON.parse(localStorage.getItem(COL_KEY) ?? "null") as string[] | null; if (Array.isArray(v)) setHidden(v); } catch { /* fără stocare locală */ } }, 0); return () => clearTimeout(t); }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await fetch("/api/antennas", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      if (!r.ok) throw new Error(String(r.status));
      setList((await r.json()) as AntennaList); setListErr(null);
    } catch { setListErr((cur) => cur ?? "Nu am putut citi lista."); }
  }, []);
  useEffect(() => {
    const t0 = setTimeout(() => void loadList(), 0);
    const iv = setInterval(() => document.visibilityState === "visible" && void loadList(), 60_000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [loadList]);

  /* ───────── antena aleasă (formularul + poza + harta) ───────── */
  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<{ id: string; rec: AntennaRecord | null; err: string | null } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [pv, setPv] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; ok: boolean; n: number; ms: number } | null>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [view, setView] = useState(false);
  const [camFor, setCamFor] = useState<string | null>(null);
  const [days, setDays] = useState<{ id: string; d: { d: number; n: number }[] } | null>(null);
  const fileDrop = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLElement>(null);

  const toast = useCallback((text: string, ok = true, ms = 3000) => setToastMsg({ text, ok, ms, n: Date.now() }), []);
  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), toastMsg.ms); return () => clearTimeout(t); }, [toastMsg]);

  const adopt = useCallback((r: AntennaRecord) => { setRec({ id: r.id, rec: r, err: null }); setForm(toForm(r)); setTouched({}); }, []);
  useEffect(() => {
    if (!sel) return;
    const ac = new AbortController();
    void fetch(`/api/antennas/${sel}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); adopt((await r.json()) as AntennaRecord); })
      .catch((e: Error) => { if (e.name !== "AbortError") setRec({ id: sel, rec: null, err: "Nu am putut citi antena." }); });
    void fetch(`/api/antennas/${sel}/stats`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (r.ok) setDays({ id: sel, d: ((await r.json()) as { days: { d: number; n: number }[] }).days }); })
      .catch(() => undefined);
    return () => ac.abort();
  }, [sel, adopt]);
  const cur = rec && rec.id === sel ? rec.rec : null;
  const f = form && cur && form.id === cur.id ? form : null;
  const dirty = !!f && !!cur && (f.NumeInstalator !== cur.NumeInstalator || f.lat !== fnum(cur.latitude) || f.lon !== fnum(cur.longitude) || f.Instalta !== cur.Instalta || f.Antena_mobila !== cur.Antena_mobila || f.NrTel_SIM !== cur.NrTel_SIM || f.ip_address !== cur.ip_address || f.Comments !== cur.Comments || f.Client !== cur.Client);
  const valid = !!f && !!cur && f.NumeInstalator.trim() !== "" && parseNum(f.lat) !== null && parseNum(f.lon) !== null && cur.hasPhoto;

  const post = useCallback(async (id: string, body: unknown): Promise<AntennaRecord> => {
    const r = await fetch(`/api/antennas/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as AntennaRecord & { error?: string };
    if (!r.ok) throw new Error(j.error ?? "Eroare.");
    return j;
  }, []);
  const keep = useCallback((r: AntennaRecord) => setRec({ id: r.id, rec: r, err: null }), []);

  /* ───────── acțiuni: locație, poză, QR ───────── */
  const saveLocation = useCallback((id: string) => {
    if (!canEdit) return;
    if (!navigator.geolocation) { toast(MSG.geoUnsupported, false, 4000); return; }
    toast(MSG.gpsAccess, true, 2000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { void post(id, { Gateways_latitude: pos.coords.latitude, Gateways_longitude: pos.coords.longitude }).then((r) => { adopt(r); void loadList(); toast("Location saved!\nМестоположение сохранено!"); }).catch((e: Error) => toast(MSG.locationSaveFailed + e.message, false, 4000)); },
      (e) => toast(e.code === 1 ? MSG.geoDenied : e.code === 2 ? MSG.geoUnavailable : e.code === 3 ? MSG.geoTimeout : MSG.geoDefault, false, 4000),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }, [post, toast, adopt, loadList, canEdit]);

  const uploadPhoto = useCallback(async (id: string, blob: Blob) => {
    const r = await fetch(`/api/antennas/${id}/photo`, { method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob });
    const j = (await r.json().catch(() => ({}))) as AntennaRecord & { error?: string };
    if (!r.ok) throw new Error(j.error ?? "Eroare la salvarea atributului.");
    keep(j); setPv((n) => n + 1); void loadList();
  }, [keep, loadList]);
  const onDropFile = async (file: File | undefined) => {
    if (!canEdit) return;
    const id = sel; if (!file || !id) return;
    try { await uploadPhoto(id, file); toast(MSG.imageSaved); } catch (e) { toast((e as Error).message, false, 4000); }
  };
  const openCamera = (id: string | null) => { if (!id || !canEdit) return; setCamFor(id); setSel(id); setDlg({ kind: "camera" }); };

  const onScan = useCallback((text: string) => {
    setDlg(null);
    const id = parseAntennaQr(text);
    if (!id) { setDlg({ kind: "alert", title: AMSG.qrNotFound }); return; }
    const found = list?.rows.find((r) => r.id === id);
    if (!found) { setDlg({ kind: "alert", title: AMSG.qrNotInDb(id) }); return; }
    setFilter(id); setQ(""); setPage(0); setSel(id);
    void fetch("/api/antennas/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: id }) });
  }, [list]);

  /* ───────── formularul: Salvează / Anulează Ultima Comandă ───────── */
  const update = async () => {
    if (!canEdit) return;
    if (!cur || !f || !valid || !dirty) return;
    setBusy(true);
    try {
      adopt(await post(cur.id, { NumeInstalator: f.NumeInstalator, Gateways_latitude: parseNum(f.lat), Gateways_longitude: parseNum(f.lon), Instalta: f.Instalta, Antena_mobila: f.Antena_mobila, NrTel_SIM: f.NrTel_SIM, ip_address: f.ip_address, Comments: f.Comments, Client: f.Client }));
      toast(MSG.updated); void loadList();
    } catch (x) { toast(`${MSG.updateFailed}: ${(x as Error).message}`, false, 4000); }
    setBusy(false);
  };
  const undo = () => { if (cur) { setForm(toForm(cur)); setTouched({}); } };

  /* ───────── tabelul: căutare / sortare / paginare locale ───────── */
  const all = useMemo(() => list?.rows ?? [], [list]);
  const ordered = useMemo(() => queryAntennas(all, eff, sort.key, sort.dir), [all, eff, sort.key, sort.dir]);
  const total = ordered.length;
  const lastPage = size ? Math.max(0, Math.ceil(total / size) - 1) : 0;
  const pg = Math.min(page, lastPage);
  const rows = size ? ordered.slice(pg * size, (pg + 1) * size) : ordered;
  const from = total === 0 ? 0 : size ? pg * size + 1 : 1, to = size ? Math.min(total, (pg + 1) * size) : total;
  const loading = !list && !listErr;
  const cols = useMemo(() => A_COLUMNS.filter((c) => !hidden.includes(c.key)), [hidden]);
  const toggleCol = (k: string) => setHidden((h) => { const n = h.includes(k) ? h.filter((x) => x !== k) : [...h, k]; try { localStorage.setItem(COL_KEY, JSON.stringify(n)); } catch { /* fără stocare locală */ } return n; });
  const sortBy = (k: string) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc", user: true }));
  const draft = filterDraft ?? filter;
  const filterDirty = filterDraft !== null && filterDraft !== filter;
  const photoUrl = cur?.hasPhoto ? `/api/antennas/${cur.id}/photo?v=${pv}` : null;
  const cell = (r: AntennaRow, k: string): React.ReactNode => {
    switch (k) {
      case "id": return r.id;
      case "active": return <span className="tbx-dot" style={{ background: r.active ? "rgb(39, 134, 34)" : "rgb(255, 0, 0)" }} role="img" aria-label={r.active ? "active" : "inactive"} />;
      case "Comments": return r.Comments;
      case "Client": return r.Client;
      case "Gateways_name_A": return r.name;
      case "CounterMessages": return String(r.msgs);
      case "lastActivityTime": return fdtA(r.last);
      case "NrTel_SIM": return r.NrTel_SIM;
      case "ip_address": return r.ip_address;
      case "NumeInstalator": return r.NumeInstalator;
      case "Gateways_latitude": return fnum(r.latitude);
      case "Gateways_longitude": return fnum(r.longitude);
      case "Instalta": return r.Instalta ? "true" : "";
      case "Antena_mobila": return r.Antena_mobila ? "true" : "";
      case "image": return r.hasPhoto ? "Image attached" : "";
      default: return "";
    }
  };
  const cleared = useRef(false);
  const logout = async (e: React.FormEvent<HTMLFormElement>) => { if (cleared.current) return; e.preventDefault(); const fm = e.currentTarget; await clearMeterCaches(); cleared.current = true; fm.requestSubmit(); };
  const mapLabel = cur ? `${cur.name || cur.id}${cur.last ? `, ${fdtA(cur.last)}` : ""}` : "";
  const toSelect = () => { selectRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); selectRef.current?.querySelector("input")?.focus(); };
  const chart = days && days.id === sel ? days.d : null;
  const chartMax = chart ? Math.max(1, ...chart.map((x) => x.n)) : 1;

  const field = (k: "NumeInstalator" | "NrTel_SIM" | "ip_address" | "Comments" | "Client", label: string, o: { req?: boolean; max?: number } = {}) => {
    const val = f ? f[k] : "";
    const bad = !!o.req && !!touched[k] && val.trim() === "";
    return (
      <label className={`tbx-ff${bad ? " bad" : ""}`} key={k}>
        <input value={val} maxLength={o.max} placeholder=" " aria-required={o.req} aria-invalid={bad} onChange={(e) => f && setForm({ ...f, [k]: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, [k]: true }))} />
        <span>{label}{o.req ? " *" : ""}</span><i />
        {bad && <em>Required</em>}
      </label>
    );
  };
  const numField = (k: "lat" | "lon", label: string) => {
    const val = f ? f[k] : "";
    const bad = !!touched[k] && parseNum(val) === null;
    return (
      <label className={`tbx-ff${bad ? " bad" : ""}`} key={k}>
        <input value={val} inputMode="decimal" placeholder=" " aria-required="true" aria-invalid={bad} onChange={(e) => f && setForm({ ...f, [k]: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, [k]: true }))} />
        <span>{label} *</span><i />
        {bad && <em>Required</em>}
      </label>
    );
  };
  const check = (k: "Instalta" | "Antena_mobila", label: string) => (
    <label className="tbx-cb" key={k}><input type="checkbox" checked={!!f?.[k]} onChange={(e) => f && setForm({ ...f, [k]: e.target.checked })} /><i aria-hidden="true" /><span>{label}</span></label>
  );

  return (
    <div className="tbx" onClick={() => { setColMenu(false); setRowMenu(null); setMenu(false); }}>
      <header className="tbx-tool">
        <div className="tbx-tool-row1">
          <h1>{TITLE}</h1>
          <div className="tbx-rel" style={{ display: "flex", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
            <form action={logoutAction} onSubmit={logout}><button type="submit" className="tbx-iconbtn tbx-white" aria-label="Ieșire" title="Ieșire / Sign out"><Ico n="logout" /></button></form>
            <Btn n="more_vert" label="Meniu" className="tbx-white" onClick={() => setMenu(!menu)} />
            {menu && (
              <div className="tbx-menu tbx-menu-r" role="menu">
                {canHome && <Link className="tbx-mi" href="/" role="menuitem"><Ico n="home" /> Moldovagaz</Link>}
                <Link className="tbx-mi" href="/securitate" role="menuitem"><Ico n="visibility" /> Securitate (parola)</Link>
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

      <div className="tbx-grid tbx-ant">
        {/* Select Device */}
        <section className="tbx-w tbx-w-select" aria-label="Select Device" ref={selectRef}>
          <header className="tbx-wh"><h3>Select Device</h3></header>
          <div className="tbx-wb">
            <label className="tbx-ff"><input value={draft} onChange={(e) => setFilterDraft(e.target.value)} placeholder=" " aria-label="FilterDevices" /><span>FilterDevices</span><i /></label>
            <div className="tbx-actions">
              <button type="button" className="tbx-btn" disabled={!filterDirty} onClick={() => setFilterDraft(null)}>{MSG.undo}</button>
              <button type="button" className="tbx-btn tbx-raised tbx-primary" disabled={!filterDirty} onClick={() => {
                const v = (filterDraft ?? "").trim(); setFilter(v); setFilterDraft(null); setPage(0);
                void fetch("/api/antennas/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: v }) }).then(() => toast(MSG.updated));
              }}>{MSG.save}</button>
            </div>
          </div>
        </section>

        {/* Gateway admin table */}
        <section className={`tbx-w tbx-w-table${full === "table" ? " tbx-full" : ""}`} aria-label="Gateway admin table">
          <header className="tbx-wh">
            {searchOpen ? <input className="tbx-search" autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search" aria-label="Search" /> : <h3>Gateway admin table</h3>}
            <span className="tbx-spacer" />
            <Btn n="qr_code_scanner" label="ScanQR" onClick={() => setDlg({ kind: "scan" })} />
            <Btn n={searchOpen ? "close" : "search"} label={searchOpen ? "Close search" : "Search"} onClick={() => { if (searchOpen) setQ(""); setSearchOpen(!searchOpen); }} />
            <div className="tbx-rel" onClick={(e) => e.stopPropagation()}>
              <Btn n="view_column" label="Select columns to display" onClick={() => setColMenu(!colMenu)} />
              {colMenu && <div className="tbx-menu tbx-menu-r" role="menu">{A_COLUMNS.map((c) => <label key={c.key} className="tbx-mi tbx-mi-chk"><input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}</label>)}</div>}
            </div>
            <Btn n={full === "table" ? "fullscreen_exit" : "fullscreen"} label={full === "table" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "table" ? null : "table")} />
          </header>
          <div className="tbx-table-wrap">
            <table className="tbx-table">
              <thead><tr>
                {cols.map((c) => (
                  <th key={c.key} className={c.num ? "num" : ""} onClick={() => sortBy(c.key)} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <span>{c.label}</span>{sort.user && sort.key === c.key && <span className={`tbx-sort ${sort.dir}`}><Ico n="arrow_upward" s={16} /></span>}
                  </th>
                ))}
                <th className="tbx-sticky-a" aria-label="Actions" />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={sel === r.id ? "sel" : ""} onClick={() => setSel(r.id)}>
                    {cols.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{cell(r, c.key)}</td>)}
                    <td className="tbx-sticky-a" onClick={(e) => e.stopPropagation()}>
                      {canEdit && <span className="tbx-act-inline"><Btn n="visibility" label="Foto" onClick={() => openCamera(r.id)} /><Btn n="pin_drop" label="Location" onClick={() => { setSel(r.id); saveLocation(r.id); }} /></span>}
                      <span className="tbx-act-more"><Btn n="more_vert" label="Acțiuni" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setRowMenu({ id: r.id, x: b.right, y: b.bottom }); e.stopPropagation(); }} /></span>
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !listErr && <tr><td colSpan={cols.length + 1} className="tbx-empty">No entities found</td></tr>}
                {listErr && !list && <tr><td colSpan={cols.length + 1} className="tbx-empty" role="alert">{listErr}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="tbx-pager">
            <span className="tbx-ps">Items per page:</span>
            <select className="tbx-ps" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} aria-label="Items per page">{SIZES.map((n) => <option key={n} value={n}>{n === 0 ? "All" : n}</option>)}</select>
            <span className="tbx-range">{from} – {to} of {total}</span>
            <Btn n="first_page" label="First page" onClick={() => setPage(0)} disabled={pg === 0} />
            <Btn n="chevron_left" label="Previous page" onClick={() => setPage(Math.max(0, pg - 1))} disabled={pg === 0} />
            <Btn n="chevron_right" label="Next page" onClick={() => setPage(pg + 1)} disabled={to >= total} />
            <Btn n="last_page" label="Last page" onClick={() => setPage(lastPage)} disabled={to >= total} />
          </footer>
        </section>

        {/* Mesaje primite pe zi (în SCADA: „Hourly received messages” / „Total Messages Received”) */}
        <section className="tbx-w tbx-w-chart" aria-label="Received messages">
          <header className="tbx-wh"><h3>Received messages (per day)</h3></header>
          <div className="tbx-wb">
            {!sel && <p className="tbx-hint">{AMSG.noEntity}</p>}
            {sel && chart && chart.length === 0 && <p className="tbx-hint">No data to display</p>}
            {sel && chart && chart.length > 0 && (
              <svg viewBox={`0 0 ${chart.length * 12} 100`} preserveAspectRatio="none" className="tbx-bars" role="img" aria-label={`Mesaje pe zi, ${chart.length} zile`}>
                {chart.map((x, i) => <rect key={x.d} x={i * 12 + 1} width={10} y={100 - (x.n / chartMax) * 96} height={(x.n / chartMax) * 96} fill="#01695c"><title>{`${new Date(x.d).getUTCDate()}/${new Date(x.d).getUTCMonth() + 1}: ${x.n}`}</title></rect>)}
              </svg>
            )}
            {sel && chart && chart.length > 0 && <p className="tbx-hint" style={{ margin: "4px 0 0" }}>{cur?.name || sel} · {chart.reduce((a, b) => a + b.n, 0)} messages / {chart.length} days (max {chartMax}/day)</p>}
          </div>
        </section>

        {/* Gateway Update */}
        <section className="tbx-w tbx-w-update" aria-label="Gateway Update">
          <header className="tbx-wh">
            <h3>Gateway Update</h3><span className="tbx-spacer" />
            {canEdit && <Btn n="pin_drop" label="Location" onClick={() => sel && saveLocation(sel)} disabled={!sel} />}
            {canEdit && <Btn n="visibility" label="Foto" onClick={() => openCamera(sel)} disabled={!sel} />}
          </header>
          <div className="tbx-wb">
            {!sel && <p className="tbx-hint">{AMSG.noEntity}</p>}
            {sel && !cur && !rec?.err && <p className="tbx-hint">…</p>}
            {rec?.err && rec.id === sel && <p className="tbx-err" role="alert">{rec.err}</p>}
            {cur && f && (
              <form onSubmit={(e) => { e.preventDefault(); void update(); }} noValidate>
                <fieldset className="tbx-group" disabled={!canEdit}><legend>{cur.id}</legend>
                  {field("NumeInstalator", "Nume Instalator (Имя Установщика )", { req: true, max: 60 })}
                  {numField("lat", "Latitude_instalator")}
                  {numField("lon", "Longitude_instalator")}
                  <label className="tbx-ff"><input value={cur.hasPhoto ? "Image attached" : ""} readOnly placeholder=" " aria-required="true" /><span>image *</span><i /></label>
                  {check("Instalta", "Instalta")}{check("Antena_mobila", "Antena_mobila")}
                  {field("NrTel_SIM", "NrTel_SIM", { max: 40 })}
                  {field("ip_address", "ip_address", { max: 60 })}
                  {field("Comments", "Comments", { max: 2000 })}
                  {field("Client", "Client", { max: 200 })}
                  <label className="tbx-ff tbx-dis"><b className="tbx-pre" aria-hidden="true"><Ico n="event" /></b><input value={fdtA(cur.last)} disabled placeholder=" " /><span>lastActivityTime</span><i /></label>
                </fieldset>
                <div className="tbx-actions" hidden={!canEdit}>
                  <button type="button" className="tbx-btn" disabled={!dirty || busy} onClick={undo}>{MSG.undo}</button>
                  <button type="submit" className="tbx-btn tbx-raised tbx-primary" disabled={!valid || !dirty || busy}>{MSG.save}</button>
                </div>
              </form>
            )}
          </div>
        </section>

        {/* Instalation Photo */}
        <section className={`tbx-w tbx-w-photo${full === "photo" ? " tbx-full" : ""}`} aria-label="Instalation Photo">
          <header className="tbx-wh"><h3>Instalation Photo</h3><span className="tbx-spacer" /><Btn n={full === "photo" ? "fullscreen_exit" : "fullscreen"} label={full === "photo" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "photo" ? null : "photo")} /></header>
          <div className="tbx-wb tbx-photo">
            {photoUrl ? (
              <button type="button" className="tbx-photo-btn" onClick={() => setView(true)} aria-label="Zoom photo" title="Zoom">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt={`Instalation photo ${cur?.id ?? ""}`} />
              </button>
            ) : null}
          </div>
        </section>

        {/* Installation foto (doar pe ecran lat, ca în SCADA) */}
        <section className="tbx-w tbx-w-foto" aria-label="Installation foto">
          <header className="tbx-wh"><h3>Installation foto</h3></header>
          <div className="tbx-wb">
            <div className={`tbx-drop${sel && canEdit ? "" : " off"}`} role="button" tabIndex={sel && canEdit ? 0 : -1} aria-disabled={!sel || !canEdit} hidden={!canEdit}
              onClick={() => sel && fileDrop.current?.click()} onKeyDown={(e) => { if (sel && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); fileDrop.current?.click(); } }}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onDropFile(e.dataTransfer.files?.[0]); }}>
              <Ico n="add_a_photo" s={32} /><span>Drop an image here or click to select</span>
            </div>
          </div>
        </section>

        {/* Meters Location (antena aleasă pe hartă) */}
        <section className={`tbx-w tbx-w-loc${full === "loc" ? " tbx-full" : ""}`} aria-label="Meters Location">
          <header className="tbx-wh"><h3>Meters Location</h3><span className="tbx-spacer" /><Btn n={full === "loc" ? "fullscreen_exit" : "fullscreen"} label={full === "loc" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "loc" ? null : "loc")} /></header>
          <div className="tbx-wb tbx-wb0"><ModuleMap name={cur?.id ?? ""} label={mapLabel} la={cur?.latitude ?? null} lo={cur?.longitude ?? null} /></div>
        </section>

        {/* Harta_Instalator (toate antenele) */}
        <section className={`tbx-w tbx-w-allmap${full === "allmap" ? " tbx-full" : ""}`} aria-label="Harta_Instalator">
          <header className="tbx-wh"><h3>Harta_Instalator</h3><span className="tbx-spacer" /><Btn n={full === "allmap" ? "fullscreen_exit" : "fullscreen"} label={full === "allmap" ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(full === "allmap" ? null : "allmap")} /></header>
          <div className="tbx-wb tbx-wb0"><AntennasMap rows={all} selected={sel} onPick={setSel} /></div>
        </section>
      </div>

      <input ref={fileDrop} type="file" accept="image/*" hidden onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; void onDropFile(x); }} aria-label="Select image" />

      {rowMenu && (
        <div className="tbx-menu tbx-menu-fixed" style={{ top: Math.min(rowMenu.y, window.innerHeight - 120), left: Math.max(8, rowMenu.x - 220) }} role="menu" onClick={(e) => e.stopPropagation()}>
          {canEdit && <button type="button" className="tbx-mi" role="menuitem" onClick={() => { const id = rowMenu.id; setRowMenu(null); openCamera(id); }}><Ico n="visibility" /> Foto</button>}
          {canEdit && <button type="button" className="tbx-mi" role="menuitem" onClick={() => { const id = rowMenu.id; setRowMenu(null); setSel(id); saveLocation(id); }}><Ico n="pin_drop" /> Location</button>}
        </div>
      )}

      {toastMsg && <div className={`tbx-toast${toastMsg.ok ? "" : " bad"}`} role="status" key={toastMsg.n}>{toastMsg.text.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div>}

      {dlg?.kind === "scan" && <QrScanner onResult={onScan} onCancel={() => setDlg({ kind: "alert", title: `${MSG.qrEmptyTitle}\n${MSG.qrEmptyBody}` })} />}
      {dlg?.kind === "camera" && camFor && <CameraDialog onSave={(b) => uploadPhoto(camFor, b)} onClose={() => setDlg(null)} />}
      {dlg?.kind === "alert" && (
        <div className="tbx-back" role="alertdialog" aria-modal="true" aria-label={dlg.title.split("\n")[0]}>
          <div className="tbx-dialog">
            <div className="tbx-dialog-body"><h2 className="tbx-dtitle">{dlg.title.split("\n").map((l, i) => <div key={i}>{l}</div>)}</h2></div>
            <div className="tbx-dialog-actions"><button type="button" className="tbx-btn tbx-text-primary" autoFocus onClick={() => setDlg(null)}>Ok</button></div>
          </div>
        </div>
      )}
      {view && cur && <PhotoViewer id={cur.id} title={cur.id} base="/api/antennas" onClose={() => setView(false)} />}
    </div>
  );
}
