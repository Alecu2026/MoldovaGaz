import type { Db } from "mongodb";
import { viewerFromDoc, type Viewer } from "./access";
import { DAY, gatewayDown, gatewayDrop, silentByZone, silentProblem, type Day } from "./alert-rules";
import { cleanNotify, eventVisible, type NotifyType } from "./notify";
import { SUBS_COLLECTION, type PushSub, type Sender } from "./push";

/**
 * Verificarea periodică a problemelor (scripts/check-alerts.ts, din pm2 la câteva minute): citește din baza NOASTRĂ (nimic din SCADA), aplică regulile din lib/alert-rules.ts,
 * ține evidența problemelor în `notif_events` (o problemă = o cheie: se deschide o singură dată, se actualizează, se închide singură) și trimite notificări push
 * doar utilizatorilor care au tipul bifat și au voie să vadă zona problemei.
 */
export const EVENTS_COLLECTION = "notif_events";
const GATEWAYS = process.env.INTEGRATION_GATEWAYS_COLLECTION || "integration_gateways";
const GW_DAY = process.env.INTEGRATION_GW_DAY_COLLECTION || "integration_gw_day";
const GW_DEV = process.env.INTEGRATION_GW_DEV_COLLECTION || "integration_gw_dev";
const METERS = process.env.METERS_COLLECTION || "meters";

export type Problem = { type: NotifyType; key: string; level: "warn" | "crit"; title: string; body: string; zones: string[]; /** mărime (pentru agravare) */ size: number };
type EventDoc = { _id: string; type: NotifyType; level: "warn" | "crit"; title: string; body: string; zones: string[]; openedAt: Date; at: Date; resolvedAt: Date | null; size: number; nsize: number };
export type RunStats = { problems: number; opened: number; escalated: number; resolved: number; sent: number; gone: number; failed: number; users: number };

const nf = new Intl.NumberFormat("ro-RO");

/* ───────── problemele de acum ───────── */
export async function currentProblems(db: Db, now: number): Promise<Problem[]> {
  const out: Problem[] = [];
  // 1) contoare care au încetat să transmită, pe zone
  const metersIter = db.collection(METERS).find({}, { projection: { "s.br": 1, "s.ct": 1, "s.t": 1, "s.pf": 1 } }).batchSize(5000);
  const lite: { br: string; ct: string; t: number | null; pf: string | null }[] = [];
  for await (const d of metersIter) { const s = (d as { s?: { br?: string; ct?: string; t?: number; pf?: string } }).s; if (s) lite.push({ br: String(s.br ?? ""), ct: String(s.ct ?? ""), t: typeof s.t === "number" ? s.t : null, pf: s.pf ?? null }); }
  for (const z of silentByZone(lite, now)) {
    const p = silentProblem(z);
    if (!p) continue;
    const city = z.zone.split("|").slice(1).join("|");
    out.push({
      type: "meters_silent", key: `meters_silent|${z.zone}`, level: p.level, zones: [z.zone], size: z.lapsed,
      title: `${nf.format(z.lapsed)} contoare nu mai transmit — ${city === "—" ? `filiala ${z.zone.split("|")[0]}` : city}`,
      body: `Au transmis în ultimele 10 zile, dar ultima citire e mai veche de 36 h (${Math.round(p.ratio * 100)}% din cele ${nf.format(z.recent + z.lapsed)} care transmiteau). Cele care transmit încă: ${nf.format(z.recent)}.`,
    });
  }
  // 2) antene: fără mesaje / eficiență scăzută
  const gws = await db.collection(GATEWAYS).find({}, { projection: { name: 1, last: 1, n: 1 } }).toArray();
  const dayDocs = await db.collection(GW_DAY).find({ d: { $gte: now - 10 * DAY } }, { projection: { g: 1, d: 1, n: 1 } }).toArray();
  const daysBy = new Map<string, Day[]>();
  for (const x of dayDocs) { const g = String(x.g).toLowerCase(); const a = daysBy.get(g) ?? []; a.push({ d: Number(x.d), n: Number(x.n) || 0 }); daysBy.set(g, a); }
  const bad: { id: string; name: string; down?: ReturnType<typeof gatewayDown>; drop?: ReturnType<typeof gatewayDrop> }[] = [];
  for (const g of gws) {
    const id = String(g._id).toLowerCase(), days = daysBy.get(id) ?? [];
    const last = typeof g.last === "number" ? g.last : null;
    const down = gatewayDown(last, days, now);
    if (down.down) { bad.push({ id, name: String(g.name ?? ""), down }); continue; }
    const drop = gatewayDrop(days, now);
    if (drop.drop) bad.push({ id, name: String(g.name ?? ""), drop });
  }
  for (const b of bad) {
    const zones = await gatewayZones(db, b.id);
    const nm = b.name ? `${b.name} (${b.id})` : b.id;
    if (b.down) out.push({ type: "gw_down", key: `gw_down|${b.id}`, level: b.down.avg >= 24 ? "crit" : "warn", zones, size: b.down.silentH, title: `Antena ${nm} nu mai primește mesaje`, body: `Nu a mai auzit nimic de ${b.down.silentH} h (de obicei primește ~${Math.round(b.down.avg)} mesaje pe zi).${zones.length ? ` Aude contoare din ${zones.length} ${zones.length === 1 ? "zonă" : "zone"}.` : ""}` });
    else if (b.drop) out.push({ type: "gw_drop", key: `gw_drop|${b.id}`, level: "warn", zones, size: Math.round(100 - (b.drop.yesterday / b.drop.med) * 100), title: `Eficiență scăzută la antena ${nm}`, body: `Ieri a primit ${nf.format(b.drop.yesterday)} mesaje față de ~${nf.format(Math.round(b.drop.med))} pe zi de obicei (${Math.round(100 - (b.drop.yesterday / b.drop.med) * 100)}% mai puțin).` });
  }
  return out;
}

/** Zonele (filială|oraș) ale contoarelor pe care le aude o antenă — ca problema ei să ajungă doar la cei care văd acele zone. */
async function gatewayZones(db: Db, id: string): Promise<string[]> {
  const pairs = await db.collection(GW_DEV).find({ g: { $in: [id, id.toUpperCase()] } }, { projection: { m: 1, n: 1 } }).sort({ n: -1 }).limit(400).toArray();
  if (!pairs.length) return [];
  const docs = await db.collection(METERS).find({ _id: { $in: pairs.map((p) => p.m) as never[] } }, { projection: { "s.br": 1, "s.ct": 1 } }).toArray();
  const cnt = new Map<string, number>();
  for (const d of docs) { const s = (d as { s?: { br?: string; ct?: string } }).s; if (!s?.br) continue; const fil = String(s.br).split(" · ")[0].trim(); if (!/^\d{1,3}$/.test(fil)) continue; const z = `${fil}|${s.ct && s.ct !== "" ? s.ct : "—"}`; cnt.set(z, (cnt.get(z) ?? 0) + 1); }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([z]) => z);
}

/* ───────── evenimentele: deschidere / agravare / închidere ───────── */
export type Plan = { open: Problem[]; escalate: Problem[]; resolve: string[]; update: Problem[] };
/** Compară problemele de acum cu cele deschise: ce e nou, ce s-a agravat (de cel puțin 1,5 ori și cu cel puțin 10 contoare / ore), ce a dispărut. */
export function planEvents(now: Problem[], openDocs: { _id: string; type: NotifyType; level: "warn" | "crit"; nsize: number }[], knownKeys: Set<string>): Plan {
  const open = new Map(openDocs.map((d) => [d._id, d]));
  const plan: Plan = { open: [], escalate: [], resolve: [], update: [] };
  const seen = new Set<string>();
  for (const p of now) {
    seen.add(p.key);
    const o = open.get(p.key);
    if (!o) { plan.open.push(p); continue; }
    const grew = p.type === "meters_silent" ? p.size >= o.nsize * 1.5 && p.size - o.nsize >= 10 : p.type === "gw_down" ? p.size >= o.nsize * 2 && p.size - o.nsize >= 6 : false;
    if (grew || (o.level === "warn" && p.level === "crit")) plan.escalate.push(p); else plan.update.push(p);
  }
  for (const d of openDocs) if (!seen.has(d._id) && knownKeys.has(d._id)) plan.resolve.push(d._id);
  return plan;
}

/* ───────── cine primește ───────── */
type UserLite = { _id: unknown; role?: string; access?: unknown; notify?: unknown; disabled?: boolean };
const viewerOfDoc = (u: UserLite): Viewer => viewerFromDoc(u);
export async function recipients(db: Db, ev: { type: NotifyType; zones: string[] }): Promise<string[]> {
  const users = await db.collection<UserLite>(process.env.USERS_COLLECTION || "users").find({ notify: ev.type, disabled: { $ne: true } }).toArray();
  const out: string[] = [];
  for (const u of users) {
    const nt = cleanNotify(u.notify);
    if (!("notify" in nt) || !nt.notify.includes(ev.type)) continue;
    if (eventVisible(viewerOfDoc(u), ev.zones)) out.push(String(u._id));
  }
  return out;
}

export type PushPayload = { title: string; body: string; url: string; tag: string; level: "warn" | "crit"; type: NotifyType };
/** Trimite o notificare tuturor abonamentelor destinatarilor; abonamentele dispărute se șterg. */
export async function deliver(db: Db, send: Sender, ev: { type: NotifyType; key: string; level: "warn" | "crit"; title: string; body: string; zones: string[] }): Promise<{ users: number; sent: number; gone: number; failed: number }> {
  const ids = await recipients(db, ev);
  const res = { users: ids.length, sent: 0, gone: 0, failed: 0 };
  if (!ids.length) return res;
  const subs = await db.collection<{ _id: unknown; userId: string } & PushSub>(SUBS_COLLECTION).find({ userId: { $in: ids } }).toArray();
  const payload = JSON.stringify({ title: ev.title, body: ev.body, url: "/notificari", tag: ev.key, level: ev.level, type: ev.type } satisfies PushPayload);
  const dead: unknown[] = [];
  for (let i = 0; i < subs.length; i += 10) {
    await Promise.all(subs.slice(i, i + 10).map(async (s) => {
      const r = await send({ endpoint: s.endpoint, keys: s.keys }, payload);
      if (r === "ok") res.sent++; else if (r === "gone") { res.gone++; dead.push(s._id); } else res.failed++;
    }));
  }
  if (dead.length) await db.collection(SUBS_COLLECTION).deleteMany({ _id: { $in: dead as never[] } });
  return res;
}

/* ───────── rularea întreagă ───────── */
export async function runAlerts(db: Db, opts: { now?: number; send: Sender; log?: (m: string) => void }): Promise<RunStats> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const coll = db.collection<EventDoc>(EVENTS_COLLECTION);
  const problems = await currentProblems(db, now);
  const openDocs = await coll.find({ resolvedAt: null }).toArray();
  const keys = new Set(openDocs.map((d) => d._id));
  const plan = planEvents(problems, openDocs, keys);
  const st: RunStats = { problems: problems.length, opened: 0, escalated: 0, resolved: 0, sent: 0, gone: 0, failed: 0, users: 0 };
  const fields = (p: Problem) => ({ type: p.type, level: p.level, title: p.title, body: p.body, zones: p.zones, size: p.size });
  const notify = async (p: Problem) => { const r = await deliver(db, opts.send, p); st.sent += r.sent; st.gone += r.gone; st.failed += r.failed; st.users += r.users; };
  for (const p of plan.open) {
    await coll.updateOne({ _id: p.key }, { $set: { ...fields(p), openedAt: new Date(now), at: new Date(now), resolvedAt: null, nsize: p.size } }, { upsert: true });
    st.opened++; await notify(p);
  }
  for (const p of plan.escalate) {
    await coll.updateOne({ _id: p.key }, { $set: { ...fields(p), at: new Date(now), nsize: p.size } });
    st.escalated++; await notify(p);
  }
  for (const p of plan.update) await coll.updateOne({ _id: p.key }, { $set: fields(p) });
  for (const key of plan.resolve) { await coll.updateOne({ _id: key }, { $set: { resolvedAt: new Date(now) } }); st.resolved++; }
  await coll.deleteMany({ resolvedAt: { $lt: new Date(now - 30 * DAY) } });
  log(`alerte: ${st.problems} probleme (${st.opened} noi, ${st.escalated} agravate, ${st.resolved} rezolvate); notificări: ${st.sent} trimise, ${st.gone} abonamente șterse, ${st.failed} eșuate, ${st.users} destinatari`);
  return st;
}
