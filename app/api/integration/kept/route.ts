import { apiGuard } from "@/lib/guard";
import { clearKept, keptDetail, keptPage, keptReasons } from "@/lib/services/kept";

/**
 * Datele păstrate pentru procesare ulterioară, doar pentru utilizatori autentificați.
 *   GET  /api/integration/kept?skip=0&limit=100&reason=…&q=…   o pagină din listă (cele mai noi primele)
 *   GET  /api/integration/kept?reasons=1                       motivele păstrării, cu numărul de mesaje
 *   GET  /api/integration/kept?id=<id>                         conținutul unui mesaj
 *   POST /api/integration/kept  { "action": "clear", "reason"?: "…" }   curăță (reia întâi ce se potrivește, apoi șterge restul)
 */
export async function GET(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const q = new URL(req.url).searchParams;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const id = q.get("id");
    if (id) {
      const d = await keptDetail(id);
      return d ? Response.json(d, { headers }) : Response.json({ error: "Mesajul nu mai există." }, { status: 404 });
    }
    if (q.get("reasons")) return Response.json({ reasons: await keptReasons() }, { headers });
    return Response.json(await keptPage(Number(q.get("skip")), Number(q.get("limit")), (q.get("reason") ?? "").slice(0, 200), q.get("q") ?? ""), { headers });
  } catch (e) {
    console.error("[integration/kept] eșuat:", e);
    return Response.json({ error: "Nu am putut citi datele păstrate." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    const b = (await req.json().catch(() => null)) as { action?: unknown; reason?: unknown } | null;
    if (b?.action !== "clear") return Response.json({ error: "Trimite { \"action\": \"clear\" }." }, { status: 400 });
    const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : "";
    return Response.json(await clearKept(reason), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/kept] curățarea a eșuat:", e);
    return Response.json({ error: "Nu am putut curăța." }, { status: 500 });
  }
}
