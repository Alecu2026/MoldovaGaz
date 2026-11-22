import { getCurrentUser } from "@/lib/dal";
import { tbSeries, type TsPoint } from "@/lib/thingsboard";

/**
 * Istoricul „Volume (m3)” al unui contor, citit din telemetria ThingsBoard (cheia Volume_m3_Total_ts = valorile orare cu momentul real al citirii;
 * Volume_m3_Total = valoarea la momentul transmisiei). `?days=` (1–400, implicit 30). Se păstrează 60 s în memorie pe contor + perioadă.
 * Rezultatul e doar de citire: serverul nu scrie nimic în ThingsBoard.
 */
const CACHE_MS = 60_000;
const g = globalThis as unknown as { __mtHist?: Map<string, { at: number; body: unknown }> };
const cache = (g.__mtHist ??= new Map());

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
  try {
    const now = Date.now();
    const r = await tbSeries(id, ["Volume_m3_Total_ts", "Volume_m3_Total"], now - days * 86_400_000, now, 5000);
    const pick = (a: TsPoint[] | undefined) => (a ?? []).map((p) => [p.ts, Number(p.value)] as [number, number]).filter((p) => Number.isFinite(p[1]));
    const body = { id, days, hourly: pick(r.Volume_m3_Total_ts), transmissions: pick(r.Volume_m3_Total), fetchedAt: now };
    cache.set(key, { at: now, body });
    if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    return Response.json(body, { headers });
  } catch (e) {
    console.error("[meters/history] eșuat:", (e as Error).message);
    return Response.json({ error: "Nu am putut citi istoricul din ThingsBoard." }, { status: 502 });
  }
}
