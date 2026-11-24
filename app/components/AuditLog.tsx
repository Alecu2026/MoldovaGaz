"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACTION_OPTIONS, AUDIT_FIRST_CHUNK, AUDIT_NEXT_CHUNK, AUDIT_MODULES, EMPTY_AUDIT_FILTERS, MODULE_LABELS, actionLabel, actionSeverity, actionShort, auditFiltersToParams, countAuditFilters, describeAgent, moduleLabel, objectHref,
  type AuditFilterState, type AuditFull, type AuditRow, type Severity,
} from "@/lib/audit-meta";
import type { AuditSummary } from "@/lib/services/audit";

/**
 * Jurnalul de audit: sus rezumatul (24 h, grafic pe 14 zile, cei mai activi), apoi filtrele și lista — virtualizată (se desenează doar rândurile vizibile) și adusă pe bucăți cu cursor,
 * deci rămâne rapidă și cu sute de mii de rânduri; un rând se deschide într-un panou cu tot ce știm (cine, de unde, ce obiect, ce s-a schimbat pe câmpuri).
 * Doar citire (jurnalul nu se poate modifica sau șterge din aplicație); exportul CSV cere dreptul «Descărcare».
 */
const ROW_H = 46;
const STORE = "mg-audit-filters";
const nf = new Intl.NumberFormat("ro-RO");
const p2 = (n: number) => String(n).padStart(2, "0");
const dmy = (ms: number) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`; };
const hms = (ms: number) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const ago = (ms: number, now: number) => { const s = Math.max(0, Math.round((now - ms) / 1000)); return s < 60 ? `acum ${s} s` : s < 3600 ? `acum ${Math.round(s / 60)} min` : s < 86_400 ? `acum ${Math.round(s / 3600)} h` : `acum ${Math.round(s / 86_400)} zile`; };
const SEV_COLOR: Record<Severity, string> = { info: "var(--st-good)", warn: "var(--st-warning)", crit: "var(--st-critical)" };
const SEV_LABEL: Record<Severity, string> = { info: "obișnuit", warn: "atenție", crit: "grav" };
const ROLE_LABEL = { admin: "administrator", user: "utilizator", anon: "necunoscut" } as const;
const GROUPS = AUDIT_MODULES.map((m) => ({ module: m, items: ACTION_OPTIONS.filter((a) => a.module === m) })).filter((g) => g.items.length);

export default function AuditLog({ canExport }: { canExport: boolean }) {
  const [f, setF] = useState<AuditFilterState>(EMPTY_AUDIT_FILTERS);
  const [qDraft, setQDraft] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [count, setCount] = useState<{ n: number; capped: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sum, setSum] = useState<AuditSummary | null>(null);
  const [fresh, setFresh] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [h, setH] = useState(560);
  const [top, setTop] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const gen = useRef(0);
  const busy = useRef(false);
  const ready = useRef(false);

  const qs = useCallback((x: AuditFilterState, extra: Record<string, string> = {}) => { const p = auditFiltersToParams(x); for (const [k, v] of Object.entries(extra)) p.set(k, v); return p.toString(); }, []);

  /* filtrele păstrate între vizite (doar comoditate; serverul verifică totul) */
  useEffect(() => {
    const t = setTimeout(() => {
      try { const raw = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<AuditFilterState> | null; if (raw && typeof raw === "object") { const m = { ...EMPTY_AUDIT_FILTERS, ...raw }; setF(m); setQDraft(m.q); } } catch { /* fără stocare locală */ }
      ready.current = true; setFresh((x) => !x);
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const apply = useCallback((patch: Partial<AuditFilterState>) => setF((cur) => { const n = { ...cur, ...patch }; try { localStorage.setItem(STORE, JSON.stringify(n)); } catch { /* fără stocare locală */ } return n; }), []);
  useEffect(() => { const t = setTimeout(() => { if (qDraft.trim() !== f.q) apply({ q: qDraft.trim() }); }, 350); return () => clearTimeout(t); }, [qDraft, f.q, apply]);

  /* rezumatul */
  const loadSum = useCallback(async (force = false) => {
    try { const r = await fetch(`/api/audit?summary=1${force ? "&fresh=1" : ""}`, { cache: "no-store" }); if (r.status === 401) { window.location.replace("/login"); return; } if (r.ok) setSum((await r.json()) as AuditSummary); } catch { /* rămâne ce era */ }
  }, []);
  useEffect(() => { const t = setTimeout(() => void loadSum(), 0); const iv = setInterval(() => document.visibilityState === "visible" && void loadSum(), 60_000); return () => { clearTimeout(t); clearInterval(iv); }; }, [loadSum]);

  /* prima bucată + totalul, la fiecare schimbare de filtru */
  useEffect(() => {
    if (!ready.current) return;
    const my = ++gen.current;
    const t = setTimeout(async () => {
      setLoading(true); setErr(null); setTop(0); if (box.current) box.current.scrollTop = 0;
      try {
        const fr = fresh ? "&fresh=1" : "";
        const [r, c] = await Promise.all([fetch(`/api/audit?${qs(f, { limit: String(AUDIT_FIRST_CHUNK) })}${fr}`, { cache: "no-store" }), fetch(`/api/audit?${qs(f, { count: "1" })}${fr}`, { cache: "no-store" })]);
        if (r.status === 401) { window.location.replace("/login"); return; }
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { rows: AuditRow[]; next: string | null };
        if (my !== gen.current) return;
        setRows(j.rows); setNext(j.next); setNow(Date.now());
        if (c.ok) setCount((await c.json()) as { n: number; capped: boolean });
      } catch { if (my === gen.current) setErr("Nu am putut citi jurnalul."); } finally { if (my === gen.current) setLoading(false); }
    }, 0);
    return () => clearTimeout(t);
  }, [f, fresh, qs]);

  const more = useCallback(async () => {
    if (!next || busy.current) return;
    busy.current = true; const my = gen.current;
    try {
      const r = await fetch(`/api/audit?${qs(f, { cursor: next, limit: String(AUDIT_NEXT_CHUNK) })}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { rows: AuditRow[]; next: string | null };
      if (my === gen.current) { setRows((cur) => cur.concat(j.rows)); setNext(j.next); }
    } catch { if (my === gen.current) setErr("Nu am putut citi mai departe."); } finally { busy.current = false; }
  }, [next, f, qs]);

  /* evenimente noi: la 20 s se întreabă doar dacă primul rând s-a schimbat */
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const iv = setInterval(async () => {
      if (document.visibilityState !== "visible" || !rows.length) return;
      try { const r = await fetch(`/api/audit?${qs(f, { limit: "1", fresh: "1" })}`, { cache: "no-store" }); if (r.ok) { const j = (await r.json()) as { rows: AuditRow[] }; if (j.rows[0] && j.rows[0].id !== rows[0].id) setNewer(true); } } catch { /* la următoarea rundă */ }
    }, 20_000);
    return () => clearInterval(iv);
  }, [f, rows, qs]);
  const reload = () => { setNewer(false); setFresh((x) => !x); void loadSum(true); };

  /* virtualizare */
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setH(el.clientHeight || 560)); ro.observe(el); return () => ro.disconnect(); }, []);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => { const el = e.currentTarget; setTop(el.scrollTop); if (el.scrollHeight - el.scrollTop - el.clientHeight < 900) void more(); };
  const start = Math.max(0, Math.floor(top / ROW_H) - 8), end = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + 8);
  const slice = useMemo(() => rows.slice(start, end), [rows, start, end]);

  const active = countAuditFilters(f);
  const chartMax = Math.max(1, ...(sum?.days.map((d) => d.n) ?? [1]));
  const exportHref = `/api/audit/export?${qs(f)}`;

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <section className="stats auto" aria-label="Rezumat jurnal">
        <div className="stat"><div className="k">Evenimente în 24 h</div><div className="v">{sum ? nf.format(sum.last24h) : "—"}</div><div className="s">{sum ? `${nf.format(sum.total)} în total` : ""}</div></div>
        <div className="stat"><div className="k">Utilizatori activi (24 h)</div><div className="v">{sum ? nf.format(sum.users24h) : "—"}</div><div className="s">au făcut cel puțin o acțiune</div></div>
        <div className={`stat ${sum && sum.failedLogins24h > 0 ? "alert" : ""}`}><div className="k">Autentificări eșuate (24 h)</div><div className="v">{sum ? nf.format(sum.failedLogins24h) : "—"}</div><div className="s">parolă sau cont greșit</div></div>
        <div className={`stat ${sum && sum.denied24h > 0 ? "alert" : ""}`}><div className="k">Acces refuzat (24 h)</div><div className="v">{sum ? nf.format(sum.denied24h) : "—"}</div><div className="s">au cerut ceva fără drept</div></div>
        <div className={`stat ${sum && sum.crit24h > 0 ? "alert" : ""}`}><div className="k">De atenție / grave (24 h)</div><div className="v">{sum ? `${nf.format(sum.warn24h)} / ${nf.format(sum.crit24h)}` : "—"}</div><div className="s">ștergeri, drepturi, eșecuri</div></div>
      </section>

      <section className="card" aria-label="Activitate">
        <header className="card-h"><div><h3>Activitate pe ultimele 14 zile</h3><p>Fiecare coloană = o zi (ora Moldovei); partea colorată = evenimentele de atenție sau grave.</p></div></header>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }} className="aud-top">
          {sum && sum.days.length > 0 ? (
            <svg viewBox={`0 0 ${sum.days.length * 24} 110`} preserveAspectRatio="none" style={{ width: "100%", height: 110 }} role="img" aria-label="Evenimente pe zi">
              {sum.days.map((d, i) => { const hh = (d.n / chartMax) * 92, wh = (d.warn / chartMax) * 92; return (
                <g key={d.day}><rect x={i * 24 + 2} width={20} y={100 - hh} height={hh} fill="var(--series-1)"><title>{`${d.day.split("-").reverse().join(".")}: ${nf.format(d.n)} evenimente, ${nf.format(d.warn)} de atenție`}</title></rect>
                  {wh > 0 && <rect x={i * 24 + 2} width={20} y={100 - wh} height={wh} fill="var(--st-warning)" />}
                  <text x={i * 24 + 12} y={109} textAnchor="middle" fontSize="7" fill="var(--muted)">{d.day.slice(8)}</text></g>); })}
            </svg>
          ) : <p className="cell-sub">Încă nu sunt evenimente.</p>}
          <div><div className="cell-sub" style={{ marginBottom: 4 }}>Cele mai dese acțiuni (7 zile)</div>{sum?.topActions.map((a) => <button key={a.action} type="button" className="btn btn-sm btn-ghost" style={{ display: "flex", width: "100%", justifyContent: "space-between" }} onClick={() => apply({ action: a.action })}><span>{actionShort(a.action)}</span><b>{nf.format(a.n)}</b></button>)}</div>
          <div><div className="cell-sub" style={{ marginBottom: 4 }}>Cei mai activi (7 zile)</div>{sum?.topUsers.map((u) => <button key={`${u.userId}|${u.name}`} type="button" className="btn btn-sm btn-ghost" style={{ display: "flex", width: "100%", justifyContent: "space-between" }} disabled={!u.userId} onClick={() => u.userId && apply({ user: u.userId })}><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span><b>{nf.format(u.n)}</b></button>)}</div>
        </div>
      </section>

      <section className="card" aria-label="Jurnal">
        <header className="card-h"><div><h3>Jurnal de audit</h3><p>Cine a făcut ce, când și de unde. Rândurile nu se pot modifica sau șterge din aplicație; se păstrează ani de zile. Parolele și cheile nu se scriu niciodată aici.</p></div></header>
        <div className="toolbar-row2" role="group" aria-label="Filtre" style={{ marginBottom: 8, flexWrap: "wrap" }}>
          <label className="field"><span>Caută</span><input className="input" type="search" value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="utilizator, e-mail, obiect, IP, pagină…" /></label>
          <label className="field"><span>Utilizator</span><select className="select" value={f.user} onChange={(e) => apply({ user: e.target.value })}><option value="">Toți</option>{sum?.users.map((u) => <option key={u.id} value={u.id}>{u.name && u.name !== u.email ? `${u.name} (${u.email})` : u.email}</option>)}</select></label>
          <label className="field"><span>Modul</span><select className="select" value={f.module} onChange={(e) => apply({ module: e.target.value, action: "" })}><option value="">Toate</option>{AUDIT_MODULES.map((m) => <option key={m} value={m}>{MODULE_LABELS[m]}</option>)}</select></label>
          <label className="field"><span>Acțiune</span><select className="select" value={f.action} onChange={(e) => apply({ action: e.target.value })}><option value="">Toate</option>{GROUPS.filter((g) => !f.module || g.module === f.module).map((g) => <optgroup key={g.module} label={MODULE_LABELS[g.module]}>{g.items.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</optgroup>)}</select></label>
          <label className="field"><span>Gravitate</span><select className="select" value={f.severity} onChange={(e) => apply({ severity: e.target.value as AuditFilterState["severity"] })}><option value="">Toate</option><option value="info">Obișnuite</option><option value="warn">De atenție</option><option value="crit">Grave</option></select></label>
          <label className="field"><span>Rezultat</span><select className="select" value={f.status} onChange={(e) => apply({ status: e.target.value as AuditFilterState["status"] })}><option value="">Toate</option><option value="ok">Reușite</option><option value="fail">Eșuate</option></select></label>
          <label className="field"><span>De la</span><input className="input" type="date" value={f.from} max={f.to || undefined} onChange={(e) => apply({ from: e.target.value })} /></label>
          <label className="field"><span>Până la</span><input className="input" type="date" value={f.to} min={f.from || undefined} onChange={(e) => apply({ to: e.target.value })} /></label>
          <label className="chk" style={{ alignSelf: "center" }}><input type="checkbox" checked={f.changes} onChange={(e) => apply({ changes: e.target.checked })} /> Doar cu modificări pe câmpuri</label>
          <label className="chk" style={{ alignSelf: "center" }}><input type="checkbox" checked={f.sim} onChange={(e) => apply({ sim: e.target.checked })} /> Doar în simulare de login</label>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <span className="cell-sub" aria-live="polite">{loading && !rows.length ? "Se încarcă…" : count ? `${nf.format(count.n)}${count.capped ? "+" : ""} evenimente${active ? " (cu filtrele alese)" : ""}${rows.length < count.n ? ` · încărcate ${nf.format(rows.length)}` : ""}` : ""}</span>
          <span style={{ flex: 1 }} />
          {active > 0 && <button type="button" className="btn btn-sm" onClick={() => { setQDraft(""); apply({ ...EMPTY_AUDIT_FILTERS }); }}>Resetează filtrele ({active})</button>}
          <button type="button" className="btn btn-sm" onClick={reload}>Reîmprospătează</button>
          {canExport && <a className="btn btn-sm" href={exportHref} download>Exportă CSV{active ? " (filtrat)" : ""}</a>}
        </div>
        {newer && <button type="button" className="btn btn-sm btn-primary" style={{ marginBottom: 8 }} onClick={reload}>Sunt evenimente noi — arată-le</button>}
        {err && <p className="form-error" role="alert">{err}</p>}

        <div className="aud-head" aria-hidden="true"><span>Când</span><span>Cine</span><span>Ce a făcut</span><span className="aud-ob">Obiect</span><span className="aud-ip">IP</span></div>
        <div ref={box} className="aud-box" onScroll={onScroll} role="list" aria-label="Evenimente" aria-busy={loading}>
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {slice.map((r, i) => {
              const sev = actionSeverity(r.action, r.ok);
              return (
                <div key={r.id} role="listitem" className={`aud-row${open === r.id ? " sel" : ""}`} style={{ top: (start + i) * ROW_H, height: ROW_H }} tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(r.id); } }}>
                  <span className="aud-t"><b>{hms(r.at)}</b><span className="cell-sub">{dmy(r.at)}</span></span>
                  <span className="aud-u"><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.userName}</span><span className="cell-sub" style={r.simBy ? { color: "var(--danger)" } : undefined}>{r.simBy ? `simulat de ${r.simBy}` : ROLE_LABEL[r.role]}</span></span>
                  <span className="aud-a"><span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}><i className="aud-dot" style={{ background: SEV_COLOR[sev] }} title={SEV_LABEL[sev]} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actionShort(r.action)}{!r.ok && <b style={{ color: "var(--danger)" }}> · eșuat</b>}</span></span><span className="cell-sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.summary ?? moduleLabel(r.module)}</span></span>
                  <span className="aud-ob cell-sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.objectName ?? "—"}</span>
                  <span className="aud-ip cell-sub mono">{r.ip ?? "—"}</span>
                </div>
              );
            })}
          </div>
          {!loading && !rows.length && !err && <p className="cell-sub" style={{ padding: 16 }}>Niciun eveniment pentru filtrele alese.</p>}
        </div>
        {next && <p className="cell-sub" style={{ margin: "6px 0 0" }}>Derulează în jos ca să se încarce și evenimentele mai vechi.</p>}
      </section>

      {open && <Detail id={open} now={now} onClose={() => setOpen(null)} onFilter={(p) => { setQDraft(p.q ?? qDraft); apply(p); setOpen(null); }} />}
    </div>
  );
}

function Detail({ id, now, onClose, onFilter }: { id: string; now: number; onClose: () => void; onFilter: (p: Partial<AuditFilterState>) => void }) {
  const [d, setD] = useState<{ id: string; v: AuditFull | null; err: string | null } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void fetch(`/api/audit?id=${id}`, { signal: ac.signal, cache: "no-store" }).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setD({ id, v: (await r.json()) as AuditFull, err: null }); }).catch((e: Error) => { if (e.name !== "AbortError") setD({ id, v: null, err: "Nu am putut citi rândul." }); });
    return () => ac.abort();
  }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const v = d && d.id === id ? d.v : null;
  const ag = describeAgent(v?.ua);
  const sev = v ? actionSeverity(v.action, v.ok) : "info";
  const href = v ? objectHref(v.module, v.objectId, v.action) : null;
  const copy = () => { if (v) void navigator.clipboard?.writeText(JSON.stringify(v, null, 2)).catch(() => undefined); };
  return (
    <div className="scrim usr-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer usr-edit" role="dialog" aria-modal="true" aria-label="Detaliile evenimentului">
        <header>
          <div style={{ minWidth: 0 }}><h2>{v ? actionLabel(v.action) : "Eveniment"}</h2>{v && <div className="cell-sub" style={{ whiteSpace: "normal" }}>{dmy(v.at)} {hms(v.at)} · {ago(v.at, now)}</div>}</div>
          <button type="button" className="btn btn-sm" onClick={onClose}>Închide</button>
        </header>
        {!v && !d?.err && <div className="skeleton" style={{ height: 120, margin: 16 }} aria-busy="true" />}
        {d?.err && <p className="form-error" role="alert" style={{ margin: 16 }}>{d.err}</p>}
        {v && (
          <>
            <section>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className={`badge ${sev === "info" ? "ok" : sev === "warn" ? "warn" : "danger"}`}>{SEV_LABEL[sev]}</span>
                <span className={`badge ${v.ok ? "ok" : "danger"}`}>{v.ok ? "reușit" : "eșuat / refuzat"}</span>
                <span className="badge">{moduleLabel(v.module)}</span>
              </div>
              <dl className="aud-dl">
                <dt>Cine</dt><dd>{v.userName}{v.userEmail && v.userEmail !== v.userName ? ` · ${v.userEmail}` : ""} <span className="cell-sub">({ROLE_LABEL[v.role]})</span></dd>
                {v.simBy && <><dt>Simulat de</dt><dd style={{ color: "var(--danger)" }}><b>{v.simBy}</b> <span className="cell-sub">— acțiunea a fost făcută de el, într-o simulare de login în contul de mai sus</span></dd></>}
                <dt>Obiect</dt><dd>{v.objectName ?? "—"}{v.objectId ? <span className="cell-sub mono"> · {v.objectId}</span> : null}{href && <> · <Link href={href}>deschide</Link></>}</dd>
                <dt>Adresă IP</dt><dd className="mono">{v.ip ?? "—"}{v.xff ? <span className="cell-sub"> · lanț proxy: {v.xff}</span> : null}</dd>
                <dt>Browser</dt><dd>{ag ? `${ag.browser} · ${ag.os} · ${ag.device}` : "—"}{v.ua && <div className="cell-sub mono" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{v.ua}</div>}</dd>
                <dt>Pagina</dt><dd className="mono">{v.path ?? "—"}</dd>
                <dt>Cererea</dt><dd className="mono">{v.method ?? "—"}</dd>
                <dt>Id rând</dt><dd className="mono">{v.id}</dd>
              </dl>
            </section>
            {v.details?.changes?.length ? (
              <section>
                <h3>Ce s-a schimbat ({v.details.changes.length})</h3>
                <div style={{ overflowX: "auto" }}><table className="mini"><thead><tr><th>Câmp</th><th>Înainte</th><th>După</th></tr></thead><tbody>
                  {v.details.changes.map((c) => <tr key={c.field}><td><b>{c.label}</b></td><td style={{ whiteSpace: "normal", overflowWrap: "anywhere", color: "var(--danger)" }}>{c.old ?? "∅"}</td><td style={{ whiteSpace: "normal", overflowWrap: "anywhere", color: "var(--ok)" }}>{c.new ?? "∅"}</td></tr>)}
                </tbody></table></div>
              </section>
            ) : null}
            {v.details?.extra?.length ? (
              <section>
                <h3>Informații</h3>
                <dl className="aud-dl">{v.details.extra.map((x, i) => <div key={i} style={{ display: "contents" }}><dt>{x.label}</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.value}</dd></div>)}</dl>
              </section>
            ) : null}
            {(v.oldValue || v.newValue) && (
              <section>
                <h3>Valori</h3>
                <dl className="aud-dl"><dt>Înainte</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v.oldValue ?? "∅"}</dd><dt>După</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v.newValue ?? "∅"}</dd></dl>
              </section>
            )}
            <section className="usr-foot">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {v.userId && <button type="button" className="btn btn-sm" onClick={() => onFilter({ user: v.userId ?? "" })}>Toate acțiunile lui</button>}
                {v.ip && <button type="button" className="btn btn-sm" onClick={() => onFilter({ q: v.ip ?? "" })}>Tot de la acest IP</button>}
                {v.objectId && <button type="button" className="btn btn-sm" onClick={() => onFilter({ q: v.objectId ?? "" })}>Tot despre acest obiect</button>}
                <button type="button" className="btn btn-sm" onClick={copy}>Copiază JSON</button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
