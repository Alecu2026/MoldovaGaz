import { apiGuard } from "@/lib/guard";
import { scopeKey } from "@/lib/access";
import { cachedJson } from "@/lib/http-cache";
import { parsePeriod } from "@/lib/meter-msgs";
import { msgsAll, msgsForIds, msgsRanking } from "@/lib/services/meter-msgs";

/**
 * Mesaje trimise de contoare (de câte ori a trimis fiecare date; din contorul de cadre fCnt, vezi lib/meter-msgs.ts). Doar contoarele din zona utilizatorului.
 * Perioada `p`: today · yesterday · AAAA-LL-ZZ · 3d / 7d / 30d (ultimele zile întregi) · r:AAAA-LL-ZZ:AAAA-LL-ZZ (interval ales).
 *   GET /api/meters/messages?p=…&ids=a,b,c      → { counts: { id: [total, zile] | null } }  (coloana din tabel; cel mult 150 de id-uri)
 *   GET /api/meters/messages?p=…&all=1           → valorile tuturor contoarelor, pe poziție în lista utilizatorului (pentru sortarea tabelului)
 *   GET /api/meters/messages?p=…&min=N&limit=N&q=text → clasamentul: contoarele cu cele mai multe mesaje pe zi (media pe perioadă), cu seria pe zile
 */
export async function GET(req: Request) {
  const guard = await apiGuard("meters");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  const sp = new URL(req.url).searchParams;
  const p = parsePeriod(sp.get("p") ?? sp.get("day") ?? "yesterday", Date.now());
  if (p === null) return Response.json({ error: "Perioadă invalidă." }, { status: 400 });
  const pk = sp.get("p") ?? sp.get("day") ?? "yesterday";
  try {
    const ids = sp.get("ids");
    if (ids !== null) {
      const list = ids.split(",").map((x) => x.trim()).filter((x) => /^[0-9a-zA-Z-]{8,64}$/.test(x)).slice(0, 150);
      return Response.json(await msgsForIds(user, list, p), { headers: { "Cache-Control": "private, no-store" } });
    }
    // rezultatele depind de zona utilizatorului: cheia o include
    if (sp.get("all")) return cachedJson(req, `msgsall|${scopeKey(user)}|${pk}`, { ttlMs: 60_000 }, () => msgsAll(user, p));
    const min = Math.max(0, Number(sp.get("min")) || 0), limit = Math.min(500, Math.max(1, Math.floor(Number(sp.get("limit")) || 100))), q = (sp.get("q") ?? "").slice(0, 60);
    return cachedJson(req, `msgs|${scopeKey(user)}|${pk}|${min}|${limit}|${q}`, { ttlMs: 30_000 }, () => msgsRanking(user, p, { min, limit, q }));
  } catch (e) {
    console.error("[meters/messages] eșuat:", e);
    return Response.json({ error: "Nu am putut citi mesajele." }, { status: 500 });
  }
}
