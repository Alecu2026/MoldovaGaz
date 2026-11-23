import "server-only";
import { ObjectId, type Document } from "mongodb";
import { col } from "../mongo";
import { RAW, reprocessKept } from "./integration";

/**
 * Datele PĂSTRATE pentru procesare ulterioară (`integration_raw`): listă pe pagini pentru pagina /integration (fereastră derulantă, doar rândurile vizibile),
 * conținutul unui mesaj și curățarea. Citirile sunt ușoare: proiecție pe câteva câmpuri (nu se aduce tot mesajul), rezultate reținute câteva secunde pe server.
 * Curățarea NU pierde nimic aplicabil: mai întâi se reiau mesajele care se potrivesc acum cu un contor, apoi se șterge DOAR ce era păstrat înainte de curățare.
 */
export type KeptRow = { id: string; at: number; reason: string; dev: string; eui: string; app: string };
export type KeptPage = { total: number; skip: number; rows: KeptRow[] };
export type KeptReason = { reason: string; n: number };
export type KeptDetail = { id: string; at: number; reason: string; truncated: boolean; text: string };

const TTL_MS = 4000;
const MAX_LIMIT = 200;
const RAW_PREVIEW_CHARS = 100_000;
const cache = new Map<string, { at: number; v: unknown }>();
const memo = async <T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 80) cache.delete(cache.keys().next().value as string);
  return v;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function filterOf(reason: string, q: string): Document {
  const f: Document = {};
  if (reason) f.reason = reason;
  const t = q.trim().slice(0, 60);
  if (t) {
    const rx = new RegExp(esc(t), "i");
    f.$or = [{ "raw.deviceName": rx }, { "raw.devEUI": rx }, { "raw.applicationName": rx }];
  }
  return f;
}

const str = (x: unknown): string => (typeof x === "string" ? x.slice(0, 120) : typeof x === "number" ? String(x) : "");

/** O pagină din lista păstrată, cele mai noi primele. */
export async function keptPage(skip: number, limit: number, reason = "", q = ""): Promise<KeptPage> {
  const sk = Math.max(0, Math.min(5_000_000, Math.floor(skip) || 0));
  const lim = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || 100));
  const filter = filterOf(reason, q);
  return memo(`p|${sk}|${lim}|${reason}|${q.trim()}`, TTL_MS, async () => {
    const coll = await col<Document>(RAW);
    const plain = Object.keys(filter).length === 0;
    const [total, docs] = await Promise.all([
      plain ? coll.estimatedDocumentCount() : memo(`c|${reason}|${q.trim()}`, 10_000, () => coll.countDocuments(filter)),
      coll.find(filter, { projection: { at: 1, reason: 1, "raw.deviceName": 1, "raw.devEUI": 1, "raw.applicationName": 1 } }).sort({ _id: -1 }).skip(sk).limit(lim).toArray(),
    ]);
    const rows: KeptRow[] = docs.map((d) => {
      const raw = (d.raw && typeof d.raw === "object" ? d.raw : {}) as Record<string, unknown>;
      return { id: String(d._id), at: Number(d.at) || 0, reason: String(d.reason ?? ""), dev: str(raw.deviceName), eui: str(raw.devEUI), app: str(raw.applicationName) };
    });
    return { total, skip: sk, rows };
  });
}

/** Motivele păstrării, cu câte mesaje are fiecare (pentru filtru și pentru curățare). */
export async function keptReasons(): Promise<KeptReason[]> {
  return memo("reasons", 10_000, async () => {
    const r = await (await col<Document>(RAW)).aggregate([{ $group: { _id: "$reason", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 30 }]).toArray();
    return r.map((x) => ({ reason: String(x._id ?? ""), n: Number(x.n) || 0 }));
  });
}

/** Conținutul unui mesaj păstrat, ca text (tăiat dacă e foarte mare). */
export async function keptDetail(id: string): Promise<KeptDetail | null> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  const d = await (await col<Document>(RAW)).findOne({ _id: new ObjectId(id) as never });
  if (!d) return null;
  let text: string;
  try {
    text = typeof d.raw === "string" ? d.raw : JSON.stringify(d.raw, null, 2) ?? "";
  } catch {
    text = String(d.raw);
  }
  const truncated = text.length > RAW_PREVIEW_CHARS || d.truncated === true;
  return { id, at: Number(d.at) || 0, reason: String(d.reason ?? ""), truncated, text: text.slice(0, RAW_PREVIEW_CHARS) };
}

/**
 * Curăță: reia mai întâi ce se potrivește acum cu un contor (se aplică, nu se pierde), apoi șterge ce era păstrat ÎNAINTE de curățare
 * (cu motivul dat, sau tot). Mesajele care sosesc între timp nu se ating.
 */
export async function clearKept(reason = ""): Promise<{ reprocessed: number; deleted: number; remaining: number }> {
  const coll = await col<Document>(RAW);
  const newest = await coll.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next();
  if (!newest) return { reprocessed: 0, deleted: 0, remaining: 0 };
  const moved = await reprocessKept();
  const filter: Document = { _id: { $lte: newest._id } };
  if (reason) filter.reason = reason;
  const r = await coll.deleteMany(filter);
  cache.clear();
  return { reprocessed: moved.moved, deleted: r.deletedCount ?? 0, remaining: await coll.countDocuments({}) };
}
