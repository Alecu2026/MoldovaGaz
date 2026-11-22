/**
 * Descarcă istoricul „Volume (m³)” (Volume_m3_Total_ts + Volume_m3_Total) din ThingsBoard într-un fișier JSONL — DOAR CITIRE din ThingsBoard
 * (prin clientul care acceptă doar GET pe seriile de timp). Nu scrie în nicio bază: produce un fișier pe care `load-history.ts` îl încarcă pe server.
 *
 *   npm run history:fetch -- --ids ids.json --out history.jsonl [--days 180] [--concurrency 6] [--limit 300]
 *
 *  - ids.json = lista de ID-uri ThingsBoard (JSON: ["uuid", …]);
 *  - se poate relua: ID-urile deja din fișierul de ieșire se sar;
 *  - contoarele care nu mai există în ThingsBoard (404) sau n-au nicio valoare în perioadă se numără și nu se scriu.
 * Mediu: TB_USER, TB_PASS (+ opțional TB_URL).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pack, type HistoryLine, type Pts } from "../lib/meter-history";
import { tbSeries, type TsPoint } from "../lib/thingsboard";

const arg = (k: string, d?: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const idsFile = arg("--ids"), out = arg("--out");
  if (!idsFile || !out) throw new Error("folosește: --ids ids.json --out history.jsonl [--days 180] [--concurrency 6] [--limit N]");
  const days = Math.max(1, Math.min(400, Number(arg("--days", "180")) || 180));
  const conc = Math.max(1, Math.min(12, Number(arg("--concurrency", "6")) || 6));
  const limit = Number(arg("--limit", "0")) || 0;
  let ids = JSON.parse(readFileSync(idsFile, "utf8")) as string[];
  if (limit) ids = ids.slice(0, limit);

  const done = new Set<string>();
  if (existsSync(out)) for (const line of readFileSync(out, "utf8").split("\n")) if (line.startsWith('{"_id":"')) done.add(line.slice(8, 44));
  const todo = ids.filter((id) => !done.has(id));
  log(`${ids.length} contoare, ${done.size} deja descărcate, ${todo.length} de descărcat · ${days} zile · ${conc} în paralel`);

  const to = Date.now(), from = to - days * 86_400_000;
  const pick = (a: TsPoint[] | undefined): Pts => (a ?? []).map((p) => [p.ts, Number(p.value)] as [number, number]).filter((p) => Number.isFinite(p[1]));
  let i = 0, written = 0, missing = 0, empty = 0, failed = 0, points = 0;
  const failedIds: string[] = [];
  const t0 = Date.now();

  async function one(id: string, retry = true): Promise<void> {
    try {
      const r = await tbSeries(id, ["Volume_m3_Total_ts", "Volume_m3_Total"], from, to, 50_000, { retries: 2 });
      const h = pick(r.Volume_m3_Total_ts), x = pick(r.Volume_m3_Total);
      if (h.length === 0 && x.length === 0) { empty++; return; }
      const line: HistoryLine = { _id: id, from, to, fetchedAt: Date.now(), h: pack(h), x: pack(x) };
      appendFileSync(out!, JSON.stringify(line) + "\n");
      written++;
      points += h.length + x.length;
    } catch (e) {
      if ((e as { status?: number }).status === 404) { missing++; return; } // nu mai există în ThingsBoard
      if (retry) { await new Promise((r) => setTimeout(r, 1500)); return one(id, false); }
      failed++;
      failedIds.push(id);
    }
  }

  async function worker() {
    while (i < todo.length) {
      const id = todo[i++];
      await one(id);
      if (i % 2000 === 0) log(`${i} / ${todo.length} · scrise ${written} · inexistente în ThingsBoard ${missing} · fără valori ${empty} · eșuate ${failed} · ${Math.round(points / Math.max(1, written))} puncte/contor · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  log(`GATA: ${written} contoare cu istoric (${points} puncte), ${missing} inexistente în ThingsBoard (404), ${empty} fără valori în perioadă, ${failed} eșuate · ${Math.round((Date.now() - t0) / 1000)} s`);
  if (failedIds.length) log(`eșuate (rulează din nou comanda, se reiau): ${failedIds.slice(0, 5).join(", ")}${failedIds.length > 5 ? "…" : ""}`);
}

main().catch((e) => {
  console.error(`EROARE: ${(e as Error).message}`);
  process.exit(1);
});
