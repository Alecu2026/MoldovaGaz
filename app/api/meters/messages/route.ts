import { apiGuard } from "@/lib/guard";
import { scopeKey } from "@/lib/access";
import { cachedJson } from "@/lib/http-cache";
import { dayLabel, parseDay } from "@/lib/meter-msgs";
import { msgsForIds, msgsRanking } from "@/lib/services/meter-msgs";

/**
 * Mesaje trimise pe zi de contoare (din contorul de cadre fCnt, vezi lib/meter-msgs.ts). Doar contoarele din zona utilizatorului.
 *   GET /api/meters/messages?day=today|yesterday|AAAA-LL-ZZ&ids=a,b,c   → { day, counts: { id: mesaje | null } }  (coloana din tabel; cel mult 150 de id-uri)
 *   GET /api/meters/messages?day=…&min=N&limit=N&q=text                  → clasamentul: contoarele cu cele mai multe mesaje în ziua aleasă, cu seria pe zile
 */
export async function GET(req: Request) {
  const guard = await apiGuard("meters");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  const sp = new URL(req.url).searchParams;
  const day = parseDay(sp.get("day") ?? "yesterday", Date.now());
  if (day === null) return Response.json({ error: "Zi invalidă." }, { status: 400 });
  try {
    const ids = sp.get("ids");
    if (ids !== null) {
      const list = ids.split(",").map((x) => x.trim()).filter((x) => /^[0-9a-zA-Z-]{8,64}$/.test(x)).slice(0, 150);
      return Response.json({ day: dayLabel(day), counts: await msgsForIds(user, list, day) }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const min = Math.max(0, Math.floor(Number(sp.get("min")) || 0)), limit = Math.min(500, Math.max(1, Math.floor(Number(sp.get("limit")) || 100))), q = (sp.get("q") ?? "").slice(0, 60);
    // rezultatul depinde de zona utilizatorului: cheia o include
    return cachedJson(req, `msgs|${scopeKey(user)}|${day}|${min}|${limit}|${q}`, { ttlMs: 30_000 }, () => msgsRanking(user, day, { min, limit, q }));
  } catch (e) {
    console.error("[meters/messages] eșuat:", e);
    return Response.json({ error: "Nu am putut citi mesajele." }, { status: 500 });
  }
}
