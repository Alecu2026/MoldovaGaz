import "server-only";
import type { Document } from "mongodb";
import { col } from "../mongo";
import { SEEN, type SeenRow } from "./integration";
import { getStore } from "./meter-dataset";

/**
 * „De la care contoare vin datele”: TOATE contoarele care au trimis prin integrare, pe pagini (pentru lista derulantă din pagina /integration), cele mai recente primele.
 * Citire ușoară: index pe `last`, pagini de câteva zeci de rânduri, filtru după nume, rezultate reținute câteva secunde pe server. Doar citire.
 */
export type SeenPage = { total: number; skip: number; rows: SeenRow[] };
const TTL_MS = 4000;
const cache = new Map<string, { at: number; v: SeenPage }>();
let indexed = false;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function seenPage(skip: number, limit: number, q = ""): Promise<SeenPage> {
  const sk = Math.max(0, Math.min(5_000_000, Math.floor(skip) || 0));
  const lim = Math.max(1, Math.min(200, Math.floor(limit) || 100));
  const t = q.trim().slice(0, 60);
  const key = `${sk}|${lim}|${t}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const coll = await col<Document>(SEEN);
  if (!indexed) {
    await coll.createIndex({ last: -1 });
    indexed = true;
  }
  const filter: Document = t ? { name: new RegExp(esc(t), "i") } : {};
  const [total, docs, store] = await Promise.all([
    t ? coll.countDocuments(filter) : coll.estimatedDocumentCount(),
    coll.find(filter).sort({ last: -1 }).skip(sk).limit(lim).toArray(),
    getStore(),
  ]);
  const rows: SeenRow[] = docs.map((d) => {
    const id = String(d._id);
    const i = store.idx.get(id);
    return {
      id, name: (i !== undefined ? store.cols.nm[i] : d.name) || "", branch: i !== undefined && store.cols.br[i] >= 0 ? store.dict.br[store.cols.br[i]] ?? null : null,
      n: Number(d.n) || 0, last: Number(d.last) || 0,
    };
  });
  const v: SeenPage = { total, skip: sk, rows };
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  return v;
}
