"use client";

import { useCallback, useEffect, useState } from "react";
import { NOTIFY_INFO, type NotifyEvent, type NotifyType } from "@/lib/notify";
import { currentSub, disablePush, enablePush, needsInstall, playAlert, pushSupported, setSoundEnabled, soundEnabled, unlockAudio } from "./notify-client";

/**
 * «Notificări»: ce primește contul, activarea pe ACEST dispozitiv (permisiune + abonament push), sunetul, o notificare de probă și lista problemelor din zona contului
 * (deschise sus, rezolvate dedesubt). Deschiderea paginii marchează totul ca văzut.
 */
type Data = { types: NotifyType[]; events: NotifyEvent[]; unread: number; seenAt: number; publicKey: string; devices: number };
const p2 = (n: number) => String(n).padStart(2, "0");
const dt = (ms: number) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

export default function NotificationsPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [here, setHere] = useState<"unknown" | "on" | "off">("unknown");
  const [perm, setPerm] = useState<string>("default");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(true);
  const [seen, setSeen] = useState(0);

  const refreshHere = useCallback(async () => {
    setPerm(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
    setHere((await currentSub()) ? "on" : "off");
  }, []);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications", { cache: "no-store" });
      if (r.status === 401) { window.location.replace("/login"); return; }
      const j = (await r.json()) as Data & { error?: string };
      if (!r.ok) throw new Error(j.error || "Nu am putut citi notificările.");
      setData(j); setErr(null);
      setSeen((s) => s || j.seenAt);
      void fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "seen" }) });
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { const t = setTimeout(() => { setSound(soundEnabled()); void load(); void refreshHere(); }, 0); const iv = setInterval(() => document.visibilityState === "visible" && void load(), 30_000); return () => { clearTimeout(t); clearInterval(iv); }; }, [load, refreshHere]);

  const on = async () => {
    if (!data) return;
    setBusy(true); setMsg(null); unlockAudio();
    const e = await enablePush(data.publicKey);
    setMsg(e ? { ok: false, text: e } : { ok: true, text: "Notificările sunt pornite pe acest dispozitiv." });
    await refreshHere(); await load(); setBusy(false);
  };
  const off = async () => { setBusy(true); setMsg(null); await disablePush(); setMsg({ ok: true, text: "Notificările sunt oprite pe acest dispozitiv." }); await refreshHere(); await load(); setBusy(false); };
  const test = async () => {
    setBusy(true); setMsg(null); unlockAudio();
    try {
      const r = await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test" }) });
      const j = (await r.json()) as { sent?: number; gone?: number; failed?: number; error?: string };
      if (!r.ok) setMsg({ ok: false, text: j.error ?? "Eroare." });
      else if (!j.sent) setMsg({ ok: false, text: j.failed || j.gone ? "Notificarea nu a putut fi trimisă dispozitivului (abonament expirat sau eroare de rețea). Oprește și pornește din nou notificările." : "Niciun dispozitiv nu e abonat. Apasă mai întâi «Pornește notificările»." });
      else setMsg({ ok: true, text: `Notificare de probă trimisă pe ${j.sent} ${j.sent === 1 ? "dispozitiv" : "dispozitive"}.` });
    } catch { setMsg({ ok: false, text: "Nu am putut contacta serverul." }); }
    setBusy(false);
  };
  const open = data?.events.filter((e) => e.resolvedAt === null) ?? [];
  const done = data?.events.filter((e) => e.resolvedAt !== null) ?? [];

  const Row = ({ e }: { e: NotifyEvent }) => (
    <li className={`nt-item nt-${e.level}${e.resolvedAt ? " nt-done" : ""}`}>
      <div className="nt-top"><span className={`badge ${e.resolvedAt ? "ok" : e.level === "crit" ? "danger" : "warn"}`}>{e.resolvedAt ? "rezolvat" : e.level === "crit" ? "grav" : "atenție"}</span>
        <b>{e.title}</b>{!e.resolvedAt && e.at > seen && <span className="badge info">nou</span>}</div>
      <div className="cell-sub" style={{ whiteSpace: "normal" }}>{e.body}</div>
      <div className="cell-sub">{NOTIFY_INFO[e.type].label} · deschis {dt(e.openedAt)}{e.resolvedAt ? ` · rezolvat ${dt(e.resolvedAt)}` : e.at !== e.openedAt ? ` · actualizat ${dt(e.at)}` : ""}{e.zones.length ? ` · zonă: ${e.zones.slice(0, 4).map((z) => z.replace("|", " · ")).join("; ")}${e.zones.length > 4 ? ` +${e.zones.length - 4}` : ""}` : ""}</div>
    </li>
  );

  return (
    <div className="page" style={{ overflow: "auto" }}>
      <section className="card" aria-label="Notificările tale">
        <header className="card-h"><div><h3>Notificări</h3><p>Primești anunțuri despre probleme (contoare care nu mai transmit, antene) doar pentru orașele pe care ai voie să le vezi și doar de tipurile bifate la contul tău.</p></div></header>
        {err && <p className="form-error" role="alert">{err}</p>}
        {data && (
          <>
            <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>{data.types.map((t) => <li key={t}><b>{NOTIFY_INFO[t].label}</b> <span className="cell-sub" style={{ whiteSpace: "normal" }}>— {NOTIFY_INFO[t].desc}</span></li>)}</ul>
            <div className="toolbar-row2" role="group" aria-label="Pe acest dispozitiv" style={{ alignItems: "center" }}>
              {here === "on" ? <button type="button" className="btn" onClick={() => void off()} disabled={busy}>Oprește notificările pe acest dispozitiv</button> : <button type="button" className="btn btn-primary" onClick={() => void on()} disabled={busy || (here === "unknown")}>Pornește notificările pe acest dispozitiv</button>}
              <button type="button" className="btn" onClick={() => void test()} disabled={busy}>Trimite o notificare de probă</button>
              <label className="chk"><input type="checkbox" checked={sound} onChange={(e) => { setSound(e.target.checked); setSoundEnabled(e.target.checked); if (e.target.checked) { unlockAudio(); playAlert("warn"); } }} /> Sunet când aplicația e deschisă</label>
              <button type="button" className="btn btn-sm" onClick={() => { unlockAudio(); playAlert("warn"); }}>Ascultă sunetul</button>
            </div>
            <p className="cell-sub" style={{ whiteSpace: "normal", margin: "8px 0 0" }}>
              Acest dispozitiv: <b>{here === "on" ? "pornit" : here === "off" ? "oprit" : "…"}</b> · permisiune browser: <b>{perm === "granted" ? "acordată" : perm === "denied" ? "blocată" : perm === "unsupported" ? "nesuportat" : "nepusă"}</b> · dispozitive pornite pe cont: <b>{data.devices}</b>
              {!pushSupported() && " · acest browser nu suportă notificări push"}
            </p>
            {needsInstall() && <p className="cell-sub" style={{ whiteSpace: "normal", color: "var(--warn)" }}>Pe iPhone / iPad notificările merg doar din aplicația instalată: în Safari apasă «Partajează» → «Adaugă pe ecranul principal», deschide Moldovagaz de pe ecranul principal și pornește notificările de acolo.</p>}
            <p className="cell-sub" style={{ whiteSpace: "normal", margin: "4px 0 0" }}>Sunetul notificării primite când aplicația e închisă e cel implicit al telefonului / calculatorului (îl schimbi din setările sistemului); cu aplicația deschisă se aude și sunetul de mai sus.</p>
            {msg && <p className={msg.ok ? "cell-sub" : "form-error"} role={msg.ok ? "status" : "alert"} style={{ whiteSpace: "normal", marginTop: 8 }}>{msg.text}</p>}
          </>
        )}
      </section>
      <section className="card" aria-label="Probleme deschise">
        <header className="card-h"><div><h3>Probleme deschise ({open.length})</h3></div></header>
        {!data && !err && <div className="skeleton" style={{ height: 80 }} aria-busy="true" />}
        {data && open.length === 0 && <p className="cell-sub">Nicio problemă deschisă în zona ta. Verificarea rulează la fiecare 10 minute.</p>}
        <ul className="nt-list">{open.map((e) => <Row key={e.id} e={e} />)}</ul>
      </section>
      {done.length > 0 && (
        <section className="card" aria-label="Rezolvate"><header className="card-h"><div><h3>Rezolvate recent ({done.length})</h3><p>ultimele 30 de zile</p></div></header><ul className="nt-list">{done.map((e) => <Row key={e.id} e={e} />)}</ul></section>
      )}
    </div>
  );
}
