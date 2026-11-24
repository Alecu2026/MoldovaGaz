"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ACTIONS, ACTION_LABEL, PAGES, PRESETS, cityKey, grantable, pageDef, type Access, type Action, type Can, type PageKey } from "@/lib/access";
import { NOTIFY_INFO, NOTIFY_TYPES, type NotifyType } from "@/lib/notify";

/**
 * Utilizatorii aplicației: creezi conturi și bifezi ce poate face fiecare — pe fiecare pagină SEPARAT: vizualizare, editare, ștergere (și descărcare / rulare unde au sens) —
 * și zona (toate filialele, filiale întregi sau orașe dintr-o filială). Un cont fără nimic bifat nu vede nimic. Administratorii pot orice; ceilalți (cu dreptul «Utilizatori»)
 * pot da doar drepturi pe care le au ei înșiși.
 */
type User = { id: string; email: string; name: string; admin: boolean; disabled: boolean; access: Access; notify: NotifyType[]; createdAt: number | null; manage: boolean; self: boolean; imp: boolean };
type Branch = { fil: string; label: string; count: number; cities: { city: string; count: number }[]; /** doar o parte din orașele filialei pot fi date (limita celui care dă drepturile) */ partial?: boolean };
type Me = { id: string; admin: boolean; access: Access };
type DPerms = Record<string, Set<Action>>;
type Draft = { id: string | null; email: string; name: string; password: string; admin: boolean; disabled: boolean; perms: DPerms; allZones: boolean; branches: Set<string>; cities: Set<string>; notify: Set<NotifyType> };
const nf = new Intl.NumberFormat("ro-RO");
const empty = (): Draft => ({ id: null, email: "", name: "", password: "", admin: false, disabled: false, perms: { meters: new Set<Action>(["view"]) }, allZones: false, branches: new Set(), cities: new Set(), notify: new Set() });
const fromUser = (u: User): Draft => ({ id: u.id, email: u.email, name: u.name, password: "", admin: u.admin, disabled: u.disabled, perms: Object.fromEntries(Object.entries(u.access.perms).map(([k, v]) => [k, new Set(v)])), allZones: u.access.allZones, branches: new Set(u.access.branches), cities: new Set(u.access.cities), notify: new Set(u.notify) });
const toggle = <T,>(s: Set<T>, v: T, on: boolean): Set<T> => { const n = new Set(s); if (on) n.add(v); else n.delete(v); return n; };

/** setarea unui drept: acțiunile se leagă logic (orice acțiune cere Vizualizare; Rulare cere și Editare); o pagină «globală» cere «Toate filialele» */
function setPerm(d: Draft, page: PageKey, action: Action, on: boolean): Draft {
  const cur = new Set(d.perms[page] ?? []);
  if (on) { cur.add(action); if (action === "run") cur.add("edit"); if (action !== "view") cur.add("view"); }
  else { cur.delete(action); if (action === "view") cur.clear(); if (action === "edit") cur.delete("run"); }
  const perms = { ...d.perms, [page]: cur };
  if (!cur.size) delete perms[page];
  return { ...d, perms, allZones: d.allZones || (on && pageDef(page).zone === "global") };
}
const toAccess = (d: Draft): Access => ({ perms: Object.fromEntries(Object.entries(d.perms).map(([k, v]) => [k, ACTIONS.filter((x) => v.has(x))])), allZones: d.allZones, branches: [...d.branches], cities: [...d.cities] });

function summary(u: User, branches: Branch[]): string {
  if (u.admin) return "Tot (administrator)";
  const pages = PAGES.filter((p) => u.access.perms[p.key]?.length).map((p) => { const a = u.access.perms[p.key] ?? []; return a.length === 1 ? p.label : `${p.label} (${a.map((x) => ACTION_LABEL[x].toLowerCase()).join(", ")})`; });
  if (!pages.length) return "Nicio pagină";
  const lab = (fil: string) => branches.find((b) => b.fil === fil)?.label ?? fil;
  const zone = u.access.allZones ? ["toate filialele"] : [...u.access.branches.map((f) => `${lab(f)} (toată)`), ...u.access.cities.map((c) => { const [f, ...r] = c.split("|"); return `${lab(f).replace(/^\d+ · /, "")}: ${r.join("|")}`; })];
  return `${pages.join("; ")} · ${zone.length ? (zone.length > 3 ? `${zone.slice(0, 3).join("; ")} +${zone.length - 3}` : zone.join("; ")) : "nicio zonă bifată"}`;
}

export default function UsersPanel({ can }: { can: Can }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [me, setMe] = useState<Me>({ id: "", admin: false, access: { perms: {}, allZones: false, branches: [], cities: [] } });
  const [err, setErr] = useState<string | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/users", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      const j = (await r.json()) as { users?: User[]; branches?: Branch[]; me?: Me; error?: string };
      if (!r.ok) throw new Error(j.error || "Nu am putut citi conturile.");
      setUsers(j.users ?? []); setBranches(j.branches ?? []); if (j.me) setMe(j.me); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const save = async () => {
    if (!d || busy) return;
    setBusy(true); setMsg(null);
    const access = toAccess(d);
    const notify = [...d.notify];
    const body = d.id ? { name: d.name, password: d.password, admin: d.admin, disabled: d.disabled, access, notify } : { email: d.email, name: d.name, password: d.password, admin: d.admin, access, notify };
    try {
      const r = await fetch(d.id ? `/api/users/${d.id}` : "/api/users", { method: d.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) { setMsg(j.error || "Nu am putut salva."); return; }
      setD(null); await load();
    } catch { setMsg("Nu am putut salva."); } finally { setBusy(false); }
  };
  const simulate = async (u: User) => {
    if (!window.confirm(`Intri în contul ${u.email}? Vei vedea aplicația exact ca el, 6 ore (sau până ieși din simulare). Tot ce faci apare în jurnalul de audit ca «simulat de» tine; în simulare nu se pot modifica conturi.`)) return;
    setMsg(null); setBusy(true);
    try {
      const r = await fetch("/api/simulare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: u.id }) });
      const j = (await r.json().catch(() => ({}))) as { to?: string; error?: string };
      if (!r.ok) { setErr(j.error || "Nu am putut porni simularea."); return; }
      window.location.assign(j.to ?? "/");
    } catch { setErr("Nu am putut porni simularea."); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!d?.id || busy || !window.confirm(`Ștergi contul ${d.email}? Nu se poate anula.`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/users/${d.id}`, { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) { setMsg(j.error || "Nu am putut șterge."); return; }
      setD(null); await load();
    } catch { setMsg("Nu am putut șterge."); } finally { setBusy(false); }
  };

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <section className="card" aria-label="Utilizatori">
        <header className="card-h">
          <div>
            <h3>Utilizatori</h3>
            <p>Pentru fiecare cont bifezi, pe fiecare pagină separat, ce poate face (vizualizare, editare, ștergere…) și zona de contoare: toate filialele, filiale întregi sau doar anumite orașe. Administratorii pot orice{me.admin ? "" : "; tu poți da doar drepturi pe care le ai și tu"}.</p>
          </div>
          {can.edit && <button type="button" className="btn btn-primary" onClick={() => { setD(empty()); setMsg(null); }}>Cont nou</button>}
        </header>
        {err && <p className="form-error" role="alert">{err}</p>}
        {!users && !err && <div className="skeleton" style={{ height: 120 }} aria-busy="true" />}
        {users && (
          <div style={{ overflowX: "auto" }}>
            <table className="mini">
              <thead><tr><th>Cont</th><th>Tip</th><th>Ce vede</th><th>Stare</th><th /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><div className="cell-main" style={{ overflow: "visible" }}>{u.name || u.email}</div><div className="cell-sub mono" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{u.email}</div></td>
                    <td>{u.admin ? <span className="badge ok">Administrator</span> : <span className="badge">Limitat</span>}{u.self && <div className="cell-sub">contul tău</div>}</td>
                    <td style={{ minWidth: 220 }}>{summary(u, branches)}{u.notify.length > 0 && <div className="cell-sub" style={{ whiteSpace: "normal" }}>Notificări: {u.notify.map((t) => NOTIFY_INFO[t].label).join("; ")}</div>}</td>
                    <td>{u.disabled ? <span className="badge danger">Dezactivat</span> : <span className="cell-sub">Activ</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{u.imp && <button type="button" className="btn btn-sm" style={{ marginRight: 6 }} disabled={busy} title="Simulare de login: intri în aplicație ca acest cont (6 ore)" onClick={() => void simulate(u)}>Intră în cont</button>}{(u.manage || u.self) && <button type="button" className="btn btn-sm" onClick={() => { setD(fromUser(u)); setMsg(null); }}>{u.manage || me.admin ? "Modifică" : "Parola / numele"}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {d && <Editor d={d} setD={setD} branches={branches} me={me} canDelete={can.delete && !!users?.find((x) => x.id === d.id)?.manage} busy={busy} msg={msg} self={d.id === me.id} onSave={() => void save()} onDelete={() => void remove()} onClose={() => setD(null)} />}
    </div>
  );
}

function Editor({ d, setD, branches, me, canDelete, busy, msg, self, onSave, onDelete, onClose }: { d: Draft; setD: (x: Draft) => void; branches: Branch[]; me: Me; canDelete: boolean; busy: boolean; msg: string | null; self: boolean; onSave: () => void; onDelete: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  // fără drept de administrator: nu poate schimba drepturile propriului cont și nu poate da mai mult decât are
  const locked = self && !me.admin;
  const may = (page: PageKey, a: Action) => me.admin || !!me.access.perms[page]?.includes(a);
  const mayAll = me.admin || me.access.allZones;
  const visible: Branch[] = mayAll ? branches : branches.flatMap((b) => {
    if (me.access.branches.includes(b.fil)) return [b];
    const cs = b.cities.filter((c) => me.access.cities.includes(cityKey(b.fil, c.city)));
    return cs.length ? [{ ...b, cities: cs, partial: true }] : [];
  });
  const preset = (key: string) => { const p = PRESETS.find((x) => x.key === key); if (p) set({ perms: Object.fromEntries(Object.entries(p.perms).map(([k, v]) => [k, new Set(v)])), allZones: p.allZones }); };
  const setAllZones = (on: boolean) => set({ allZones: on, perms: on ? d.perms : Object.fromEntries(Object.entries(d.perms).filter(([k]) => pageDef(k as PageKey).zone !== "global")) });
  return (
    <div className="scrim usr-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer usr-edit" role="dialog" aria-modal="true" aria-label={d.id ? "Modifică utilizatorul" : "Cont nou"}>
        <header>
          <div style={{ minWidth: 0 }}><h2>{d.id ? "Modifică utilizatorul" : "Cont nou"}</h2>{d.id && <div className="cell-sub mono" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{d.email}</div>}</div>
          <button type="button" className="btn btn-sm" onClick={onClose}>Închide</button>
        </header>
        <section>
          <div className="usr-grid">
            {!d.id && <label className="field"><span>E-mail (cu el se autentifică)</span><input className="input" type="email" value={d.email} onChange={(e) => set({ email: e.target.value })} autoComplete="off" placeholder="nume@exemplu.md" /></label>}
            <label className="field"><span>Nume afișat</span><input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" /></label>
            <label className="field"><span>{d.id ? "Parolă nouă (lasă gol ca să n-o schimbi)" : "Parolă (cel puțin 8 caractere)"}</span><input className="input" type="text" value={d.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" spellCheck={false} /></label>
          </div>
          <label className="chk" style={{ marginTop: 10 }}><input type="checkbox" checked={d.admin} disabled={self || !me.admin} onChange={(e) => set({ admin: e.target.checked })} /> Administrator — poate orice, în toată aplicația{!me.admin && " (doar un administrator poate da asta)"}</label>
          {d.id && <label className="chk" style={{ marginTop: 6 }}><input type="checkbox" checked={d.disabled} disabled={self} onChange={(e) => set({ disabled: e.target.checked })} /> Cont dezactivat (nu se mai poate autentifica)</label>}
        </section>
        <section>
          <h3>Notificări primite</h3>
          {NOTIFY_TYPES.map((t) => (
            <label key={t} className="chk" style={{ display: "flex", marginBottom: 6, alignItems: "flex-start" }}>
              <input type="checkbox" checked={d.notify.has(t)} onChange={(e) => set({ notify: toggle(d.notify, t, e.target.checked) })} style={{ marginTop: 3 }} />
              <span>{NOTIFY_INFO[t].label}<span className="cell-sub" style={{ display: "block", whiteSpace: "normal" }}>{NOTIFY_INFO[t].desc}</span></span>
            </label>
          ))}
          <p className="cell-sub" style={{ whiteSpace: "normal", margin: "6px 0 0" }}>{d.admin ? "Administratorul primește notificările bifate pentru toate orașele." : "Primește notificările bifate doar pentru orașele pe care are voie să le vadă (zona de mai jos); fiecare utilizator le pornește apoi pe telefonul / calculatorul lui."}</p>
        </section>
        {!d.admin && (
          <>
            <section>
              <h3>Ce poate face, pe fiecare pagină</h3>
              {locked && <p className="cell-sub" style={{ whiteSpace: "normal" }}>Nu îți poți schimba singur drepturile.</p>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 8px" }}>
                <span className="cell-sub" style={{ alignSelf: "center" }}>Rețete:</span>
                {PRESETS.map((p) => <button key={p.key} type="button" className="btn btn-sm" title={p.desc} disabled={locked || !grantable({ admin: me.admin, access: me.access }, { perms: p.perms, allZones: p.allZones, branches: [], cities: [] })} onClick={() => preset(p.key)}>{p.label}</button>)}
                <button type="button" className="btn btn-sm btn-ghost" disabled={locked} onClick={() => set({ perms: {}, allZones: false })}>Golește</button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="mini usr-matrix">
                  <thead><tr><th>Pagina</th>{ACTIONS.map((a) => <th key={a} style={{ textAlign: "center" }}>{ACTION_LABEL[a]}</th>)}</tr></thead>
                  <tbody>
                    {PAGES.map((p) => (
                      <tr key={p.key}>
                        <td style={{ minWidth: 200 }}><b>{p.label}</b><div className="cell-sub" style={{ whiteSpace: "normal" }}>{p.desc}{p.zone === "global" ? " Arată date din toate filialele (cere «Toate filialele»)." : ""}</div></td>
                        {ACTIONS.map((a) => (
                          <td key={a} style={{ textAlign: "center" }}>
                            {p.actions[a] ? <input type="checkbox" title={p.actions[a]} aria-label={`${p.label}: ${ACTION_LABEL[a]}`} checked={d.perms[p.key]?.has(a) ?? false} disabled={locked || !may(p.key, a)} onChange={(e) => setD(setPerm(d, p.key, a, e.target.checked))} /> : <span className="cell-sub" aria-hidden="true">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cell-sub" style={{ whiteSpace: "normal", margin: "6px 0 0" }}>Vizualizare = vede pagina și datele ei. Editare = creează / modifică. Ștergere = șterge. Descărcare = descarcă fișiere (CSV). Rulare = rulează procese care scriu în ChirpStack (cere și Editare). Orice acțiune bifează singură Vizualizare; trece cursorul peste o bifă ca să vezi exact ce permite.</p>
            </section>
            <section>
              <h3>Ce contoare vede</h3>
              <label className="chk" style={{ display: "flex", marginBottom: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={d.allZones} disabled={locked || !mayAll} onChange={(e) => setAllZones(e.target.checked)} style={{ marginTop: 3 }} />
                <span>Toate filialele și orașele<span className="cell-sub" style={{ display: "block", whiteSpace: "normal" }}>Fără limită de zonă. E nevoie de ea pentru paginile care arată date din toate filialele (consum nemăsurat, integrare, rapoarte, LoRaWAN, facturare).</span></span>
              </label>
              {!d.allZones && (
                <>
                  <p className="cell-sub" style={{ whiteSpace: "normal", margin: "0 0 8px" }}>Sau bifează o filială întreagă ori deschide-o și bifează doar orașele dorite. Fără nimic bifat nu vede niciun contor.</p>
                  <div className="usr-tree">
                    {visible.map((b) => <BranchRow key={b.fil} b={b} d={d} set={set} locked={locked} />)}
                  </div>
                </>
              )}
            </section>
          </>
        )}
        <section className="usr-foot">
          {msg && <p className="form-error" role="alert" style={{ margin: "0 0 8px" }}>{msg}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
            <div>{d.id && !self && canDelete && <button type="button" className="btn btn-sm" onClick={onDelete} disabled={busy} style={{ color: "var(--danger)" }}>Șterge contul</button>}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Anulează</button>
              <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || (!d.id && (!d.email.trim() || d.password.length < 8))}>{busy ? "Se salvează…" : "Salvează"}</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function BranchRow({ b, d, set, locked }: { b: Branch; d: Draft; set: (p: Partial<Draft>) => void; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const whole = d.branches.has(b.fil);
  const picked = useMemo(() => b.cities.filter((c) => d.cities.has(cityKey(b.fil, c.city))).length, [b, d.cities]);
  const list = useMemo(() => { const x = q.trim().toLowerCase(); return x ? b.cities.filter((c) => c.city.toLowerCase().includes(x)) : b.cities; }, [b, q]);
  const pickWhole = (on: boolean) => set({ branches: toggle(d.branches, b.fil, on), cities: new Set([...d.cities].filter((c) => !c.startsWith(`${b.fil}|`))) });
  const allShown = list.length > 0 && list.every((c) => d.cities.has(cityKey(b.fil, c.city)));
  const pickShown = (on: boolean) => { const n = new Set(d.cities); for (const c of list) { if (on) n.add(cityKey(b.fil, c.city)); else n.delete(cityKey(b.fil, c.city)); } set({ cities: n }); };
  return (
    <div className="usr-branch">
      <div className="usr-branch-h">
        <label className="chk"><input type="checkbox" checked={whole} disabled={locked || b.partial} onChange={(e) => pickWhole(e.target.checked)} /> <b>{b.label}</b> <span className="cell-sub">· {nf.format(b.count)} contoare</span></label>
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{whole ? "Toată filiala" : picked ? (picked === 1 ? "1 oraș bifat" : `${picked} orașe bifate`) : "Orașe"} {open ? "▴" : "▾"}</button>
      </div>
      {open && (
        <div className="usr-cities">
          {whole ? <p className="cell-sub" style={{ whiteSpace: "normal" }}>Toată filiala e bifată (toate orașele). Debifeaz-o ca să alegi orașe.</p> : (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                <input className="input" style={{ maxWidth: 220 }} placeholder="Caută oraș…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Caută oraș în ${b.label}`} />
                <label className="chk"><input type="checkbox" checked={allShown} onChange={(e) => pickShown(e.target.checked)} /> {q.trim() ? "Toate cele găsite" : "Toate orașele"}</label>
              </div>
              <div className="usr-citylist">
                {list.map((c) => (
                  <label key={c.city} className="chk usr-city"><input type="checkbox" checked={d.cities.has(cityKey(b.fil, c.city))} disabled={locked} onChange={(e) => set({ cities: toggle(d.cities, cityKey(b.fil, c.city), e.target.checked) })} /> {c.city === "—" ? "fără oraș în facturare" : c.city} <span className="cell-sub">· {nf.format(c.count)}</span></label>
                ))}
                {!list.length && <span className="cell-sub">Niciun oraș găsit.</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
