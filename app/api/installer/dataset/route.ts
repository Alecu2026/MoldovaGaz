import { apiGuard } from "@/lib/guard";
import { deltaWire, fullJson, getInstStore, instEtag } from "@/lib/services/installer-store";

/**
 * Lista contoarelor pentru ecranul instalatorului (coloanar, doar zona utilizatorului), pentru tabelul care caută / sortează / paginează în browser.
 *   GET /api/installer/dataset                       → lista întreagă (ETag ⇒ 304 la redeschidere)
 *   GET /api/installer/dataset?gen=<g>&since=<head>  → doar rândurile schimbate de la `head` (sau { full: true } dacă generația nu mai e aceeași)
 */
export async function GET(req: Request) {
  const guard = await apiGuard("installer");
  if ("res" in guard) return guard.res;
  const sp = new URL(req.url).searchParams;
  try {
    const st = await getInstStore();
    if (sp.has("since")) {
      const out = deltaWire(st, guard.user, sp.get("gen") ?? "", Number(sp.get("since")));
      return Response.json(out, { headers: { "Cache-Control": "private, no-store" } });
    }
    const etag = instEtag(st, guard.user);
    const base = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });
    return new Response(fullJson(st, guard.user), { headers: { ...base, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[installer/dataset] eșuat:", e);
    return Response.json({ error: "Nu am putut citi lista." }, { status: 500 });
  }
}
