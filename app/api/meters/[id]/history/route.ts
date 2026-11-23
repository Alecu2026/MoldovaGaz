import { getCurrentUser } from "@/lib/dal";
import { unpack, type Pts } from "@/lib/meter-history";
import { COLLECTIONS, col } from "@/lib/mongo";
import { tbSeries, type TsPoint } from "@/lib/thingsboard";

/**
 * Istoricul „Volume (m3)” al unui contor: Volume_m3_Total_ts (valorile orare, cu momentul real al citirii) și Volume_m3_Total (valoarea la transmisie).
 *  1. ÎNTÂI din ThingsBoard, live (doar citire, 6 s maximum);
 *  2. dacă ThingsBoard nu răspunde (ex. serverul nu îl poate accesa din rețeaua locală), din ARHIVA din baza de date (colecția meter_history, încărcată cu
 *     scripts/load-history.ts) — răspunsul spune `source: "stored"` și până când sunt datele, ca interfața să arate că nu sunt cele mai recente.
 * `?days=` (1–400, implicit 30). Se păstrează 60 s în memorie pe contor + perioadă. Serverul nu scrie nimic în ThingsBoard.
 */
const CACHE_MS = 60_000;
const LIVE_MS = 6_000;
const g = globalThis as unknown as { __mtHist?: Map<string, { at: number; body: unknown }> };
const cache = (g.__mtHist ??= new Map());

type Stored = { to: number; fetchedAt: number; h: { n: number; t: never; v: never }; x: { n: number; t: never; v: never } };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  const days = Math.max(1, Math.min(400, Number(new URL(req.url).searchParams.get("days")) || 30));
  const key = `${id}:${days}`;
  const hit = cache.get(key);
  const headers = { "Cache-Control": "private, max-age=30", Vary: "Cookie" };
  if (hit && Date.now() - hit.at < CACHE_MS) return Response.json(hit.body, { headers });

  const done = (body: unknown) => {
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    return Response.json(body, { headers });
  };

  // 1) live din ThingsBoard
  let liveError: unknown = null;
  try {
    const now = Date.now();
    const r = await Promise.race([
      tbSeries(id, ["Volume_m3_Total_ts", "Volume_m3_Total"], now - days * 86_400_000, now, 20_000, { timeoutMs: LIVE_MS, retries: 0 }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), LIVE_MS + 500)),
    ]);
    const pick = (a: TsPoint[] | undefined): Pts => (a ?? []).map((p) => [p.ts, Number(p.value)] as [number, number]).filter((p) => Number.isFinite(p[1]));
    return done({ id, days, source: "live", hourly: pick(r.Volume_m3_Total_ts), transmissions: pick(r.Volume_m3_Total), fetchedAt: now });
  } catch (e) {
    liveError = e;
  }

  // 2) arhiva din baza de date
  try {
    const d = await (await col<Stored & { _id: string }>(COLLECTIONS.history)).findOne({ _id: id });
    if (d) {
      const since = d.to - days * 86_400_000;
      const cut = (p: Pts) => p.filter((x) => x[0] >= since);
      return done({ id, days, source: "stored", hourly: cut(unpack(d.h)), transmissions: cut(unpack(d.x)), fetchedAt: d.to, storedAt: d.fetchedAt });
    }
  } catch (e) {
    console.error("[meters/history] arhiva:", (e as Error).message);
  }

  if ((liveError as { status?: number } | null)?.status === 404) return Response.json({ error: "Contorul nu există în SCADA (nu are istoric)." }, { status: 404 });
  console.error("[meters/history] eșuat:", (liveError as Error | null)?.message);
  return Response.json({ error: "Nu am putut citi istoricul (SCADA nu răspunde și contorul nu are istoric arhivat)." }, { status: 502 });
}
