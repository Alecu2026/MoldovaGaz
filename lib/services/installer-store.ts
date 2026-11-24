import "server-only";
import { createHash } from "node:crypto";
import { allowsMeter, scopeKey, type Viewer } from "../access";
import type { InstWire } from "../installer";
import { COLLECTIONS, col } from "../mongo";

/**
 * Lista ecranului instalatorului, în memoria serverului, coloanar și MICĂ (doar ce arată tabelul: nume, ContorNr, ultima activitate, Volume_m3_Total, Instalation_Litres,
 * Volume_Liters, ModuleInitialValue + filiala și orașul pentru zona utilizatorului). Browserul o descarcă o dată (ETag ⇒ 304 la redeschidere), apoi caută, sortează și
 * paginează LOCAL, instant — ca tabelul din pagina Contoare — și se pune la zi doar cu rândurile schimbate (`since`).
 * Se construiește din colecția `meters` (doar citire) și se reîmprospătează incremental după `updatedAt`.
 */
const REFRESH_MS = 20_000;
const REBUILD_MS = 30 * 60_000; // contoarele dispărute din sursă ies din listă la reconstruirea completă
const OVERLAP_MS = 120_000;

type Doc = {
  _id: unknown; updatedAt?: Date; tb?: { name?: string }; s?: { n?: string; br?: string; ct?: string };
  attrs?: { lastActivityTime?: unknown; Instalation_Litres?: unknown; ModuleInitialValue?: unknown; ContorNr?: unknown };
  tel?: { Volume_m3_Total?: { v?: unknown }; Volume_Liters?: { v?: unknown } };
};
type Store = {
  gen: string; head: number; builtAt: number; refreshedAt: number;
  idx: Map<string, number>;
  id: string[]; nm: string[]; cn: string[]; ia: (number | null)[]; vol: (number | null)[]; il: (number | null)[]; vl: (number | null)[]; mi: (number | null)[]; upd: number[];
  br: string[]; ct: string[];
};
const g = globalThis as unknown as { __instStore?: Store; __instBuild?: Promise<Store>; __instJson?: Map<string, string> };

const PROJ = { updatedAt: 1, "tb.name": 1, "s.n": 1, "s.br": 1, "s.ct": 1, "attrs.lastActivityTime": 1, "attrs.Instalation_Litres": 1, "attrs.ModuleInitialValue": 1, "attrs.ContorNr": 1, "tel.Volume_m3_Total.v": 1, "tel.Volume_Liters.v": 1 } as const;
const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const x = typeof v === "number" ? v : Number(String(v).replace(",", ".")); return Number.isFinite(x) ? x : null; };

function put(st: Store, d: Doc): void {
  const id = String(d._id);
  let i = st.idx.get(id);
  if (i === undefined) { i = st.id.length; st.idx.set(id, i); st.id.push(id); }
  const a = d.attrs ?? {};
  st.nm[i] = String(d.tb?.name ?? d.s?.n ?? id);
  st.cn[i] = a.ContorNr === undefined || a.ContorNr === null ? "" : String(a.ContorNr);
  st.ia[i] = num(a.lastActivityTime); st.vol[i] = num(d.tel?.Volume_m3_Total?.v); st.il[i] = num(a.Instalation_Litres); st.vl[i] = num(d.tel?.Volume_Liters?.v); st.mi[i] = num(a.ModuleInitialValue);
  st.br[i] = String(d.s?.br ?? ""); st.ct[i] = String(d.s?.ct ?? "");
  const u = d.updatedAt instanceof Date ? d.updatedAt.getTime() : 0;
  st.upd[i] = u;
  if (u > st.head) st.head = u;
}

const empty = (): Store => ({ gen: createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 10), head: 0, builtAt: Date.now(), refreshedAt: Date.now(), idx: new Map(), id: [], nm: [], cn: [], ia: [], vol: [], il: [], vl: [], mi: [], upd: [], br: [], ct: [] });

async function build(): Promise<Store> {
  const st = empty();
  const coll = await col<Doc>(COLLECTIONS.meters);
  for await (const d of coll.find({}, { projection: PROJ }).sort({ _id: 1 }).batchSize(5000)) put(st, d);
  g.__instStore = st; g.__instJson = new Map();
  return st;
}

async function refresh(st: Store): Promise<Store> {
  const coll = await col<Doc>(COLLECTIONS.meters);
  const t0 = Date.now();
  for await (const d of coll.find({ updatedAt: { $gte: new Date(Math.max(0, st.head - OVERLAP_MS)) } }, { projection: PROJ }).batchSize(5000)) put(st, d);
  st.refreshedAt = t0;
  return st;
}

/** Lista din memorie, la zi (cel mult REFRESH_MS vechime); cererile simultane împart aceeași construire / reîmprospătare. */
export async function getInstStore(): Promise<Store> {
  const cur = g.__instStore;
  if (cur && Date.now() - cur.refreshedAt < REFRESH_MS) return cur;
  if (!g.__instBuild) {
    const p: Promise<Store> = (async () => (cur && Date.now() - cur.builtAt < REBUILD_MS ? refresh(cur) : build()))().finally(() => { if (g.__instBuild === p) g.__instBuild = undefined; });
    g.__instBuild = p;
  }
  return g.__instBuild;
}

/** Indicii rândurilor din zona utilizatorului (administratorul le are pe toate). */
function allowed(st: Store, v: Viewer): number[] {
  const out: number[] = [];
  if (v.admin) { for (let i = 0; i < st.id.length; i++) out.push(i); return out; }
  const verdict = new Map<string, boolean>();
  for (let i = 0; i < st.id.length; i++) {
    const k = `${st.br[i]}\u0000${st.ct[i]}`;
    let ok = verdict.get(k);
    if (ok === undefined) { ok = allowsMeter(v, st.br[i], st.ct[i]); verdict.set(k, ok); }
    if (ok) out.push(i);
  }
  return out;
}

const tag = (v: Viewer) => createHash("sha1").update(scopeKey(v)).digest("hex").slice(0, 8);
const genFor = (st: Store, v: Viewer) => (v.admin ? st.gen : `${st.gen}-${tag(v)}`);
export const instEtag = (st: Store, v: Viewer): string => `"${genFor(st, v)}.${st.head}"`;

function wireOf(st: Store, v: Viewer, rows: number[], full: boolean): InstWire {
  const pick = <T,>(a: T[]) => rows.map((i) => a[i]);
  return { v: 1, gen: genFor(st, v), head: st.head, full, id: pick(st.id), nm: pick(st.nm), cn: pick(st.cn), ia: pick(st.ia), vol: pick(st.vol), il: pick(st.il), vl: pick(st.vl), mi: pick(st.mi) };
}

/** Lista întreagă a zonei, ca text JSON (memorat pe versiune + zonă). */
export function fullJson(st: Store, v: Viewer): string {
  const memo = (g.__instJson ??= new Map());
  const key = `${st.gen}.${st.head}.${scopeKey(v)}`;
  let s = memo.get(key);
  if (s === undefined) {
    s = JSON.stringify(wireOf(st, v, allowed(st, v), true));
    if (memo.size > 8) memo.delete(memo.keys().next().value as string);
    memo.set(key, s);
  }
  return s;
}

/** Doar rândurile din zonă schimbate după `since` (momentul `head` pe care îl are browserul). Generație diferită ⇒ browserul cere lista întreagă. */
export function deltaWire(st: Store, v: Viewer, gen: string, since: number): InstWire | { full: true } {
  if (gen !== genFor(st, v) || !(since >= 0)) return { full: true };
  const rows = allowed(st, v).filter((i) => st.upd[i] > since);
  return wireOf(st, v, rows, false);
}
