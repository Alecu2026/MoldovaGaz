import "server-only";
import { after } from "next/server";
import { headers } from "next/headers";
import { ObjectId, type Filter } from "mongodb";
import { actionModule, actionSeverity, ACTIONS, AUDIT_COUNT_CAP, AUDIT_EXPORT_CAP, MODULE_LABELS, actionLabel, describeAgent, type AuditChange, type AuditDetails, type AuditExtra, type AuditFilterState, type AuditFull, type AuditRow, type Severity } from "../audit-meta";
import { summarizeChanges } from "../audit-diff";
import { getDb } from "../mongo";
import { csvCell, fmtLocal, localToUtc } from "../report-readings";

/**
 * JURNAL DE AUDIT (colecția `audit_log`): cine a făcut ce, când și de unde — pentru acțiunile care schimbă ceva sau contează pentru securitate (vezi lib/audit-meta.ts).
 *
 *  - Scrierea NU încetinește acțiunea: se face după ce răspunsul a plecat (`after`), iar o eroare de scriere nu o strică (doar se vede în consolă). Pentru evenimentele care se pot
 *    repeta des (acces refuzat, consultări de date) există limitare: același eveniment al aceluiași utilizator se scrie cel mult o dată pe interval.
 *  - Citirea e gândită pentru milioane de rânduri: indexuri pe (at), (uid, at), (a, at), (m, at), (oid, at), paginare cu cursor (fiecare bucată costă la fel, oricât de adânc ai fi),
 *    total plafonat și ținut în memorie ~20 s, rezumatul ținut ~30 s, textele lungi vin doar la deschiderea unui rând.
 *  - Păstrare: TTL pe `at` (AUDIT_RETENTION_DAYS, implicit 730 de zile). Jurnalul nu se poate șterge din aplicație (nu există nici măcar un drept pentru asta).
 *  - Nu se păstrează NICIODATĂ parole, chei (AppKey, NwkSKey…), tokenuri sau cookie-uri: la acestea jurnalul spune doar «schimbată».
 */
export const AUDIT = "audit_log";
type Doc = {
  _id: ObjectId; at: Date; uid: string | null; un: string; ue: string | null; ur: "admin" | "user" | "anon"; a: string; m: string;
  oid: string | null; on: string | null; ov: string | null; nv: string | null; d: AuditDetails | null; sum: string | null; nc: number;
  ok: boolean; ip: string | null; xff: string | null; ua: string | null; p: string | null; me: string | null; ms: number | null; hay: string;
};

export type AuditActor = { id: string; name: string; email: string; admin: boolean };
export type AuditInput = {
  action: string; objectId?: string | null; objectName?: string | null; oldValue?: string | null; newValue?: string | null;
  changes?: AuditChange[]; extra?: AuditExtra[]; ok?: boolean; ms?: number | null;
  /** cererea (metoda + adresa API-ului intră în jurnal) */ req?: Request;
  /** pentru evenimente fără utilizator autentificat (autentificare eșuată): numele / e-mailul încercat */ anonName?: string;
  /** altă pagină decât cea din Referer */ path?: string | null;
};

const g = globalThis as unknown as { __auditIdx?: Promise<void>; __auditOnce?: Map<string, number>; __auditMemo?: Map<string, { at: number; v: unknown; p?: Promise<unknown> }> };
const once = (g.__auditOnce ??= new Map());
const memo = (g.__auditMemo ??= new Map());

const clip = (v: string | null | undefined, n = 1500): string | null => (v === null || v === undefined ? null : v.length > n ? `${v.slice(0, n)}…` : v);
const RETENTION_DAYS = Math.max(30, Number(process.env.AUDIT_RETENTION_DAYS) || 730);

async function coll() {
  const db = await getDb();
  g.__auditIdx ??= Promise.all([
    db.collection(AUDIT).createIndex({ at: -1, _id: -1 }),
    db.collection(AUDIT).createIndex({ uid: 1, at: -1 }),
    db.collection(AUDIT).createIndex({ a: 1, at: -1 }),
    db.collection(AUDIT).createIndex({ m: 1, at: -1 }),
    db.collection(AUDIT).createIndex({ oid: 1, at: -1 }, { sparse: true }),
    db.collection(AUDIT).createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86_400, name: "ttl_at" }),
  ]).then(() => undefined).catch((e) => { g.__auditIdx = undefined; console.error("[audit] indexuri:", (e as Error).message); });
  await g.__auditIdx;
  return db.collection<Doc>(AUDIT);
}

/** adresa clientului: prima din X-Forwarded-For (proxy-ul din față), altfel X-Real-IP */
async function meta(req?: Request) {
  let ip: string | null = null, xff: string | null = null, ua: string | null = null, path: string | null = null, method: string | null = null;
  try {
    const h = await headers();
    xff = h.get("x-forwarded-for");
    ip = xff?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
    ua = h.get("user-agent");
    const ref = h.get("referer");
    if (ref) { try { path = new URL(ref).pathname.slice(0, 200); } catch { /* referer invalid */ } }
  } catch { /* în afara unei cereri */ }
  if (req) { try { const u = new URL(req.url); method = `${req.method} ${u.pathname}`.slice(0, 200); } catch { /* adresă invalidă */ } }
  return { ip: ip?.slice(0, 64) ?? null, xff: xff && xff.split(",").length > 1 ? xff.slice(0, 200) : null, ua: ua?.slice(0, 300) ?? null, path, method };
}

/**
 * Înregistrează o acțiune. Nu aruncă niciodată și nu așteaptă baza de date: scrierea pleacă după răspuns.
 * Fără `actor` (autentificare eșuată) se folosește `anonName`.
 */
export async function logAudit(actor: AuditActor | null, input: AuditInput): Promise<void> {
  try {
    const m = await meta(input.req);
    const changes = (input.changes ?? []).slice(0, 60).map((c) => ({ ...c, old: clip(c.old), new: clip(c.new) }));
    const extra = (input.extra ?? []).slice(0, 30).map((x) => ({ label: x.label, value: clip(x.value) ?? "" }));
    const details: AuditDetails | null = changes.length || extra.length ? { ...(changes.length ? { changes } : {}), ...(extra.length ? { extra } : {}) } : null;
    const sum = summarizeChanges(changes);
    const name = actor?.name || actor?.email || input.anonName || "necunoscut";
    const doc: Omit<Doc, "_id"> = {
      at: new Date(), uid: actor?.id ?? null, un: name.slice(0, 120), ue: (actor?.email ?? (input.anonName?.includes("@") ? input.anonName : null))?.slice(0, 200) ?? null,
      ur: actor ? (actor.admin ? "admin" : "user") : "anon", a: input.action, m: actionModule(input.action),
      oid: input.objectId ? String(input.objectId).slice(0, 120) : null, on: clip(input.objectName ?? null, 200), ov: clip(input.oldValue), nv: clip(input.newValue),
      d: details, sum, nc: changes.length, ok: input.ok !== false, ip: m.ip, xff: m.xff, ua: m.ua, p: (input.path ?? m.path) || null, me: m.method, ms: input.ms ?? null, hay: "",
    };
    doc.hay = [doc.un, doc.ue, doc.on, doc.oid, doc.ip, doc.p, doc.sum, actionLabel(doc.a), doc.a].filter(Boolean).join(" ").toLowerCase().slice(0, 600);
    const write = async () => { try { await (await coll()).insertOne(doc as Doc); } catch (e) { console.error("[audit] scrierea a eșuat:", (e as Error).message); } };
    try { after(write); } catch { void write(); }
  } catch (e) {
    console.error("[audit] jurnalul nu a putut fi pregătit:", (e as Error).message);
  }
}

/** Ca `logAudit`, dar cel mult o dată pe `ttlMs` pentru aceeași cheie (acces refuzat repetat, consultări de date la fiecare reîncărcare). */
export async function logAuditOnce(key: string, ttlMs: number, actor: AuditActor | null, input: AuditInput): Promise<void> {
  const now = Date.now(), last = once.get(key);
  if (last && now - last < ttlMs) return;
  once.set(key, now);
  if (once.size > 5000) for (const [k, t] of once) if (now - t > 3_600_000) once.delete(k);
  await logAudit(actor, input);
}

/** Accesul refuzat unui utilizator autentificat (403): ce pagină / acțiune a cerut. Cel mult o dată pe minut pentru aceeași cerere. */
export async function logDenied(actor: AuditActor, need: string, action: string, req?: Request): Promise<void> {
  await logAuditOnce(`denied|${actor.id}|${need}|${action}|${req ? new URL(req.url).pathname : ""}`, 60_000, actor, { action: "security.denied", ok: false, objectName: `${need} → ${action}`, extra: [{ label: "Pagină cerută", value: need }, { label: "Acțiune cerută", value: action }], req });
}

/* ───────── citire ───────── */
const memoQ = <T,>(key: string, ttl: number, fresh: boolean, run: () => Promise<T>): Promise<T> => {
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.v as T);
  if (!fresh && hit?.p) return hit.p as Promise<T>;
  const p = run().then((v) => { memo.set(key, { at: Date.now(), v }); return v; }).catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { at: hit?.at ?? 0, v: hit?.v, p });
  if (memo.size > 150) memo.delete(memo.keys().next().value as string);
  return p;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nextDay = (ymd: string): string => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const dayStart = (ymd: string): number => { const [y, m, d] = ymd.split("-").map(Number); return localToUtc(y, m, d, 0, 0); };
const actionsWith = (sev: Severity): string[] => Object.entries(ACTIONS).filter(([, m]) => m.severity === sev).map(([k]) => k);

function buildFilter(f: AuditFilterState): Filter<Doc> {
  const and: Filter<Doc>[] = [];
  if (f.user) and.push({ uid: f.user });
  if (f.module) and.push({ m: f.module });
  if (f.action) and.push({ a: f.action });
  if (f.status) and.push({ ok: f.status === "ok" });
  if (f.severity === "crit") and.push({ a: { $in: actionsWith("crit") } });
  else if (f.severity === "warn") and.push({ $or: [{ a: { $in: actionsWith("warn") } }, { ok: false, a: { $in: actionsWith("info") } }] });
  else if (f.severity === "info") and.push({ a: { $in: actionsWith("info") }, ok: true });
  if (f.from || f.to) and.push({ at: { ...(f.from ? { $gte: new Date(dayStart(f.from)) } : {}), ...(f.to ? { $lt: new Date(dayStart(nextDay(f.to))) } : {}) } });
  if (f.changes) and.push({ nc: { $gt: 0 } });
  for (const w of f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)) and.push({ hay: { $regex: esc(w.slice(0, 40)) } });
  return and.length ? { $and: and } : {};
}

const PROJECT = { _id: 1, at: 1, uid: 1, un: 1, ue: 1, ur: 1, a: 1, m: 1, oid: 1, on: 1, sum: 1, ok: 1, ip: 1, p: 1, nc: 1 } as const;
type Slim = Pick<Doc, "_id" | "at" | "uid" | "un" | "ue" | "ur" | "a" | "m" | "oid" | "on" | "sum" | "ok" | "ip" | "p" | "nc">;
const toRow = (d: Slim): AuditRow => ({ id: String(d._id), at: d.at.getTime(), userId: d.uid, userName: d.un, userEmail: d.ue, role: d.ur, action: d.a, module: d.m, objectId: d.oid, objectName: d.on, summary: d.sum, ok: d.ok, ip: d.ip, path: d.p, nChanges: d.nc });

const encCursor = (d: Slim) => Buffer.from(`${d.at.getTime()}_${String(d._id)}`).toString("base64url");
function decCursor(c: string | undefined): Filter<Doc> | null {
  if (!c || c.length > 80) return null;
  const m = /^(\d{10,14})_([0-9a-f]{24})$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  return m ? { $or: [{ at: { $lt: new Date(Number(m[1])) } }, { at: new Date(Number(m[1])), _id: { $lt: new ObjectId(m[2]) } }] } : null;
}

/** O bucată din listă (cele mai noi primele), cu cursor: `next` = cursorul pentru bucata următoare (null = s-a terminat). */
export async function listAudit(f: AuditFilterState, o: { cursor?: string; limit: number; fresh?: boolean }): Promise<{ rows: AuditRow[]; next: string | null }> {
  const limit = Math.min(1000, Math.max(1, Math.floor(o.limit)));
  const cur = decCursor(o.cursor);
  const base = buildFilter(f);
  const filter: Filter<Doc> = cur ? { $and: [base, cur] } : base;
  return memoQ(`list|${JSON.stringify(f)}|${o.cursor ?? ""}|${limit}`, 4_000, !!o.fresh, async () => {
    const docs = await (await coll()).find(filter, { projection: PROJECT }).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray() as unknown as Slim[];
    const more = docs.length > limit;
    const page = more ? docs.slice(0, limit) : docs;
    return { rows: page.map(toRow), next: more ? encCursor(page[page.length - 1]) : null };
  });
}

/** Câte rânduri are un filtru (și fără filtru): plafonat — peste AUDIT_COUNT_CAP se arată «50.000+», ca să nu se numere tot jurnalul —, ținut ~20 s. */
export async function countAudit(f: AuditFilterState, fresh = false): Promise<{ n: number; capped: boolean }> {
  return memoQ(`count|${JSON.stringify(f)}`, 20_000, fresh, async () => {
    const c = await coll();
    const filter = buildFilter(f);
    const n = await c.countDocuments(filter, { limit: AUDIT_COUNT_CAP + 1 });
    return n > AUDIT_COUNT_CAP ? { n: AUDIT_COUNT_CAP, capped: true } : { n, capped: false };
  });
}

export async function getAudit(id: string): Promise<AuditFull | null> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  const d = await (await coll()).findOne({ _id: new ObjectId(id) });
  return d ? { ...toRow(d), ua: d.ua, xff: d.xff, method: d.me, ms: d.ms, oldValue: d.ov, newValue: d.nv, details: d.d } : null;
}

export type AuditSummary = {
  at: number; total: number; last24h: number; users24h: number; failedLogins24h: number; denied24h: number; warn24h: number; crit24h: number;
  days: { day: string; n: number; warn: number }[];
  topActions: { action: string; n: number }[];
  topUsers: { userId: string | null; name: string; n: number }[];
  users: { id: string; name: string; email: string }[];
};
/** Rezumatul din antet: ultimele 24 h, graficul pe 14 zile, acțiunile și utilizatorii cei mai activi (7 zile). Ținut ~30 s; un singur calcul pentru toți. */
export async function auditSummary(fresh = false): Promise<AuditSummary> {
  return memoQ("summary", 30_000, fresh, async () => {
    const c = await coll(), now = Date.now(), d1 = new Date(now - 86_400_000), d7 = new Date(now - 7 * 86_400_000), d14 = new Date(now - 14 * 86_400_000);
    const warnSet = [...actionsWith("warn"), ...actionsWith("crit")];
    const [total, h24, days, top, topU, users] = await Promise.all([
      c.estimatedDocumentCount(),
      c.aggregate<{ _id: null; n: number; users: string[]; failed: number; denied: number; warn: number; crit: number }>([
        { $match: { at: { $gte: d1 } } },
        { $group: { _id: null, n: { $sum: 1 }, users: { $addToSet: "$uid" }, failed: { $sum: { $cond: [{ $eq: ["$a", "auth.login_failed"] }, 1, 0] } }, denied: { $sum: { $cond: [{ $eq: ["$a", "security.denied"] }, 1, 0] } }, warn: { $sum: { $cond: [{ $in: ["$a", warnSet] }, 1, 0] } }, crit: { $sum: { $cond: [{ $in: ["$a", actionsWith("crit")] }, 1, 0] } } } },
      ]).toArray(),
      c.aggregate<{ _id: string; n: number; warn: number }>([
        { $match: { at: { $gte: d14 } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "Europe/Chisinau" } }, n: { $sum: 1 }, warn: { $sum: { $cond: [{ $in: ["$a", warnSet] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      c.aggregate<{ _id: string; n: number }>([{ $match: { at: { $gte: d7 } } }, { $group: { _id: "$a", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]).toArray(),
      c.aggregate<{ _id: { u: string | null; n: string }; n: number }>([{ $match: { at: { $gte: d7 } } }, { $group: { _id: { u: "$uid", n: "$un" }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]).toArray(),
      (await getDb()).collection("users").find({}, { projection: { email: 1, name: 1 } }).sort({ email: 1 }).limit(2000).toArray(),
    ]);
    const h = h24[0];
    return {
      at: now, total, last24h: h?.n ?? 0, users24h: h ? h.users.filter(Boolean).length : 0, failedLogins24h: h?.failed ?? 0, denied24h: h?.denied ?? 0, warn24h: h?.warn ?? 0, crit24h: h?.crit ?? 0,
      days: days.map((x) => ({ day: x._id, n: x.n, warn: x.warn })), topActions: top.map((x) => ({ action: x._id, n: x.n })), topUsers: topU.map((x) => ({ userId: x._id.u, name: x._id.n, n: x.n })),
      users: users.map((u) => ({ id: String(u._id), name: String(u.name ?? u.email ?? ""), email: String(u.email ?? "") })),
    };
  });
}

/* ───────── export CSV ───────── */
const inj = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const cell = (v: unknown): string => csvCell(inj(v === null || v === undefined ? "" : String(v)));
const HEAD = ["Data și ora (ora Moldovei)", "Utilizator", "E-mail", "Rol", "Modul", "Acțiune", "Cod acțiune", "Obiect", "Id obiect", "Modificări (câmp: vechi → nou)", "Valoare veche", "Valoare nouă", "Rezultat", "Gravitate", "Adresă IP", "Pagină", "Cerere", "Browser", "Sistem", "Dispozitiv"];
/** CSV-ul rândurilor filtrate, pe bucăți (memorie mică, oricât de mare e jurnalul), cel mult AUDIT_EXPORT_CAP rânduri. Separator «;» și BOM, ca să se deschidă corect în Excel cu setări românești. */
export async function* exportAuditCsv(f: AuditFilterState): AsyncGenerator<string> {
  yield "﻿" + HEAD.map(cell).join(";") + "\n";
  const c = await coll();
  const base = buildFilter(f);
  let cursor: string | undefined, sent = 0;
  while (sent < AUDIT_EXPORT_CAP) {
    const cur = decCursor(cursor);
    const docs = await c.find(cur ? { $and: [base, cur] } : base).sort({ at: -1, _id: -1 }).limit(Math.min(2000, AUDIT_EXPORT_CAP - sent)).toArray();
    if (!docs.length) break;
    let out = "";
    for (const d of docs) {
      const ag = describeAgent(d.ua);
      out += [fmtLocal(d.at.getTime()), d.un, d.ue, d.ur === "admin" ? "administrator" : d.ur === "user" ? "utilizator" : "necunoscut", MODULE_LABELS[d.m as keyof typeof MODULE_LABELS] ?? d.m, actionLabel(d.a), d.a, d.on, d.oid,
        (d.d?.changes ?? []).map((x) => `${x.label}: ${x.old ?? "∅"} → ${x.new ?? "∅"}`).join(" | "), d.ov, d.nv, d.ok ? "reușit" : "eșuat", actionSeverity(d.a, d.ok), d.ip, d.p, d.me, ag?.browser, ag?.os, ag?.device].map(cell).join(";") + "\n";
    }
    sent += docs.length;
    yield out;
    if (docs.length < 2000) break;
    cursor = encCursor(docs[docs.length - 1] as unknown as Slim);
  }
}
