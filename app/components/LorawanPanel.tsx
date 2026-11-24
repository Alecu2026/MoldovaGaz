"use client";

import { useCallback, useEffect, useState } from "react";
import { DOWNLINKS, GAS_TYPES, TYPE_LABEL, type DownlinkKey, type ModType } from "@/lib/lorawan/config";

/**
 * «Module LoRaWAN»: înregistrarea și activarea modulelor în ChirpStack, ca în SCADA (lanțul «LoraWan_register_and_activation»): înregistrare + activare, reînregistrare de urgență,
 * comandă către modul, ABP extraframe. Fiecare proces se poate SIMULA (doar citiri) înainte să fie rulat. Cheile se păstrează criptat și nu se mai afișează după salvare.
 */
type Cfg = { primary: boolean; backup: boolean; v4: boolean; mqttV4: boolean; nodered: number; secret: boolean; write: boolean };
type Run = { at: number; kind: string; dry: boolean; ok: boolean; by: string; steps: string[]; error: string | null };
type Mod = { id: string; name: string; type: ModType; activation: "OTAA" | "ABP"; status: string; applicationID: string | null; emergency: string | null; emcCount: number; step: string | null; hasKeys: { appKey: boolean }; updatedAt: number; last: Run | null };
type Kind = "register" | "emergency" | "otaa_down" | "extraframe";
const KINDS: [Kind, string][] = [["register", "Înregistrare + activare"], ["emergency", "Reînregistrare de urgență (rezervă)"], ["otaa_down", "Comandă către modul"], ["extraframe", "ABP extraframe (v4)"]];
const p2 = (n: number) => String(n).padStart(2, "0");
const dt = (ms: number) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const CSV_HEAD = "name;type;activation;devEUI;appKey;devAddr;devAaddr;appSKey;nwkSKey";
const EMPTY = { name: "", type: "Comrat_Gas_Meter_DP", activation: "OTAA", devEUI: "", appKey: "", devAddr: "", devAaddr: "", appSKey: "", nwkSKey: "" };

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const head = lines[0].split(sep).map((h) => h.trim());
  const hasHead = head.includes("devEUI") || head.includes("name");
  const cols = hasHead ? head : CSV_HEAD.split(";");
  return (hasHead ? lines.slice(1) : lines).map((l) => { const c = l.split(sep).map((x) => x.trim()); return Object.fromEntries(cols.map((k, i) => [k, c[i] ?? ""])); });
}

export default function LorawanPanel() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [mods, setMods] = useState<Mod[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ ...EMPTY });
  const [csv, setCsv] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<Record<string, Kind>>({});
  const [cmd, setCmd] = useState<Record<string, DownlinkKey>>({});
  const [result, setResult] = useState<{ id: string; name: string; kind: Kind; dry: boolean; ok: boolean; steps: string[]; error?: string; needsConfirm?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/lorawan", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      const j = (await r.json()) as { config?: Cfg; modules?: Mod[]; error?: string };
      if (!r.ok) throw new Error(j.error || "Nu am putut citi modulele.");
      setCfg(j.config ?? null); setMods(j.modules ?? []); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const add = async (rows: unknown[]) => {
    setBusy("add"); setMsg(null);
    try {
      const r = await fetch("/api/lorawan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", modules: rows }) });
      const j = (await r.json()) as { added?: string[]; errors?: { row: number; error: string }[]; error?: string };
      if (!r.ok) { setMsg({ ok: false, text: j.error ?? "Eroare." }); return; }
      const e = j.errors ?? [];
      setMsg({ ok: e.length === 0, text: `${j.added?.length ?? 0} module adăugate${e.length ? `; ${e.length} respinse: ${e.slice(0, 5).map((x) => (x.row ? `rândul ${x.row}: ` : "") + x.error).join(" | ")}` : ""}` });
      if ((j.added?.length ?? 0) > 0) { setF({ ...EMPTY }); setCsv(""); }
      await load();
    } catch { setMsg({ ok: false, text: "Nu am putut contacta serverul." }); } finally { setBusy(null); }
  };
  const run = async (m: Mod, dry: boolean, confirmDelete = false) => {
    const k = kind[m.id] ?? "register";
    if (!dry && !window.confirm(`Rulezi «${KINDS.find((x) => x[0] === k)?.[1]}» pe ${m.name}? Se scrie în ChirpStack.`)) return;
    setBusy(m.id); setMsg(null); setResult(null);
    try {
      const r = await fetch("/api/lorawan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", id: m.id, kind: k, dry, confirmDelete, cmd: cmd[m.id] ?? "to_abp" }) });
      const j = (await r.json()) as { outcome?: { ok: boolean; error?: string; needsConfirm?: string }; steps?: string[]; error?: string };
      if (!r.ok) setMsg({ ok: false, text: j.error ?? "Eroare." });
      else setResult({ id: m.id, name: m.name, kind: k, dry, ok: j.outcome?.ok ?? false, steps: j.steps ?? [], error: j.outcome?.error, needsConfirm: j.outcome?.needsConfirm });
      await load();
    } catch { setMsg({ ok: false, text: "Nu am putut contacta serverul." }); } finally { setBusy(null); }
  };
  const del = async (m: Mod) => {
    if (!window.confirm(`Scoți ${m.name} din evidența noastră? (nu se șterge nimic din ChirpStack)`)) return;
    await fetch(`/api/lorawan?id=${m.id}`, { method: "DELETE" }); await load();
  };
  const dot = (ok: boolean, label: string) => <span className={`badge ${ok ? "ok" : "warn"}`} key={label}>{ok ? "✓" : "✗"} {label}</span>;
  const set = (k: keyof typeof EMPTY, v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <section className="card" aria-label="Module LoRaWAN">
        <header className="card-h"><div><h3>Module LoRaWAN (ChirpStack)</h3><p>Aceleași procese ca în SCADA: creează modulul în ChirpStack și îl activează (OTAA: cheia; ABP: adresa și cheile). Poți mai întâi să <b>simulezi</b> (doar citiri). Cheile se păstrează criptat.</p></div></header>
        {err && <p className="form-error" role="alert">{err}</p>}
        {cfg && (
          <div className="badges" style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {dot(cfg.primary, "server principal")}{dot(cfg.backup, "server de rezervă")}{dot(cfg.v4, "server v4")}{dot(cfg.mqttV4, "MQTT v4")}{dot(cfg.nodered > 0, `Node-RED (${cfg.nodered})`)}{dot(cfg.secret, "secret chei")}{dot(cfg.write, cfg.write ? "scriere pornită" : "scriere oprită (doar simulare)")}
          </div>
        )}
        {cfg && !cfg.write && <p className="cell-sub" style={{ whiteSpace: "normal" }}>Scrierile în ChirpStack sunt oprite pe server (lipsește <span className="mono">LORAWAN_WRITE=1</span>): «Rulează» e blocat, «Simulează» merge.</p>}
        {msg && <p className={msg.ok ? "cell-sub" : "form-error"} role={msg.ok ? "status" : "alert"} style={{ whiteSpace: "normal" }}>{msg.text}</p>}
      </section>

      <section className="card" aria-label="Adaugă module">
        <header className="card-h"><div><h3>Adaugă module</h3></div></header>
        <div className="usr-grid">
          <label className="field"><span>Nume contor (ex. S2154_00071212_2022)</span><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="off" /></label>
          <label className="field"><span>Filiala / tip</span><select className="select" value={f.type} onChange={(e) => set("type", e.target.value)}>{GAS_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
          <label className="field"><span>Activare</span><select className="select" value={f.activation} onChange={(e) => set("activation", e.target.value)}><option>OTAA</option><option>ABP</option></select></label>
          <label className="field"><span>devEUI (16 hex)</span><input className="input mono" value={f.devEUI} onChange={(e) => set("devEUI", e.target.value)} autoComplete="off" spellCheck={false} /></label>
          {f.activation === "OTAA" ? <label className="field"><span>APPKEY (32 hex)</span><input className="input mono" value={f.appKey} onChange={(e) => set("appKey", e.target.value)} autoComplete="off" spellCheck={false} /></label> : (
            <>
              <label className="field"><span>devADDR (8 hex)</span><input className="input mono" value={f.devAddr} onChange={(e) => set("devAddr", e.target.value)} autoComplete="off" spellCheck={false} /></label>
              <label className="field"><span>APPSKEY (32 hex)</span><input className="input mono" value={f.appSKey} onChange={(e) => set("appSKey", e.target.value)} autoComplete="off" spellCheck={false} /></label>
              <label className="field"><span>NWKSKEY (32 hex)</span><input className="input mono" value={f.nwkSKey} onChange={(e) => set("nwkSKey", e.target.value)} autoComplete="off" spellCheck={false} /></label>
            </>
          )}
          <label className="field"><span>devAADDR (urgență / extraframe, 9 caractere cu «A»; opțional)</span><input className="input mono" value={f.devAaddr} onChange={(e) => set("devAaddr", e.target.value)} autoComplete="off" spellCheck={false} /></label>
        </div>
        <div style={{ marginTop: 10 }}><button type="button" className="btn btn-primary" disabled={busy === "add"} onClick={() => void add([{ ...f, appKey: f.activation === "OTAA" ? f.appKey : "", ...(f.activation === "OTAA" ? { devAddr: "", appSKey: "", nwkSKey: "" } : {}) }])}>Adaugă modulul</button></div>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Mai multe deodată (lipește un tabel CSV / din Excel)</summary>
          <p className="cell-sub" style={{ whiteSpace: "normal" }}>Antet: <span className="mono">{CSV_HEAD}</span> (separator «;», virgulă sau tab). La «type» se pune tipul din SCADA, ex. <span className="mono">Comrat_Gas_Meter_DP</span>; «activation» = OTAA sau ABP.</p>
          <textarea className="input mono" style={{ height: 120, padding: 8 }} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} aria-label="Tabel CSV" />
          <div style={{ marginTop: 8 }}><button type="button" className="btn" disabled={busy === "add" || !csv.trim()} onClick={() => void add(parseCsv(csv))}>Adaugă din tabel</button></div>
        </details>
      </section>

      {result && (
        <section className="card" aria-label="Rezultat">
          <header className="card-h"><div><h3>{result.dry ? "Simulare" : "Rulare"} — {result.name}</h3><p>{KINDS.find((k) => k[0] === result.kind)?.[1]} · {result.ok ? "fără erori" : "cu probleme"}</p></div></header>
          <ol style={{ margin: 0, paddingLeft: 20 }}>{result.steps.map((s, i) => <li key={i} className="cell-sub" style={{ whiteSpace: "normal" }}>{s}</li>)}</ol>
          {result.error && <p className="form-error" role="alert" style={{ marginTop: 8 }}>{result.error}</p>}
          {result.needsConfirm === "delete" && (
            <div style={{ marginTop: 8 }}><button type="button" className="btn" style={{ color: "var(--danger)" }} onClick={() => { const m = mods?.find((x) => x.id === result.id); if (m && window.confirm(`Ștergi dispozitivul existent din ChirpStack și îl recreezi (${m.name})?`)) void run(m, false, true); }}>Confirm: șterge și recreează</button></div>
          )}
        </section>
      )}

      <section className="card" aria-label="Module">
        <header className="card-h"><div><h3>Module ({mods?.length ?? "…"})</h3></div></header>
        <div className="card-table" style={{ maxHeight: 560 }}>
          <table className="mini">
            <thead><tr><th>Modul</th><th>Activare</th><th>Stare</th><th>Urgență</th><th>Ultima rulare</th><th>Proces</th></tr></thead>
            <tbody>
              {mods?.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.name}</b><div className="cell-sub mono">{m.id} · {TYPE_LABEL[m.type] ?? m.type}</div></td>
                  <td>{m.activation}</td>
                  <td><span className={`badge ${m.status === "înregistrat" ? "ok" : m.status === "nou" ? "" : "danger"}`}>{m.status}</span>{m.applicationID && <div className="cell-sub">aplicația {m.applicationID}</div>}{m.step && <div className="cell-sub mono">{m.step}</div>}</td>
                  <td className="cell-sub mono" style={{ whiteSpace: "normal" }}>{m.emergency ?? "—"}{m.emcCount ? ` · ${m.emcCount}×` : ""}</td>
                  <td className="cell-sub" style={{ whiteSpace: "normal" }}>{m.last ? <>{dt(m.last.at)} · {m.last.dry ? "simulare" : "rulat"} · {m.last.ok ? "ok" : "eșuat"}</> : "—"}</td>
                  <td style={{ minWidth: 260 }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <select className="select" style={{ width: 200, height: 30 }} value={kind[m.id] ?? "register"} onChange={(e) => setKind((k) => ({ ...k, [m.id]: e.target.value as Kind }))} aria-label="Proces">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                      {(kind[m.id] ?? "register") === "otaa_down" && <select className="select" style={{ width: 170, height: 30 }} value={cmd[m.id] ?? "to_abp"} onChange={(e) => setCmd((c) => ({ ...c, [m.id]: e.target.value as DownlinkKey }))} aria-label="Comandă">{(Object.keys(DOWNLINKS) as DownlinkKey[]).map((k) => <option key={k} value={k}>{DOWNLINKS[k].label}</option>)}</select>}
                      <button type="button" className="btn btn-sm" disabled={busy === m.id} onClick={() => void run(m, true)}>Simulează</button>
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy === m.id || !cfg?.write} onClick={() => void run(m, false)} title={cfg?.write ? "Scrie în ChirpStack" : "Scrierea e oprită pe server"}>Rulează</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void del(m)} aria-label={`Scoate ${m.name} din evidență`}>Scoate</button>
                    </div>
                  </td>
                </tr>
              ))}
              {mods && mods.length === 0 && <tr><td colSpan={6} className="cell-sub" style={{ padding: 16 }}>Niciun modul în evidență. Adaugă primul mai sus.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
