import { apiGuard } from "@/lib/guard";
import { actorOf } from "@/lib/audit-actor";
import { logAudit } from "@/lib/services/audit";
import { reprocessKept } from "@/lib/services/integration";

/** Reia datele păstrate (integration_raw): ce se poate aplica acum merge în cutia de intrare. Doar utilizatori autentificați; apelat de butonul din pagina /integration. */
export async function POST(req: Request) {
  const guard = await apiGuard("integration", "edit");
  if ("res" in guard) return guard.res;
  try {
    const r = await reprocessKept();
    await logAudit(actorOf(guard.user), { action: "integration.reprocess", req, extra: [{ label: "Rezultat", value: JSON.stringify(r) }] });
    return Response.json(r, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/reprocess] eșuat:", e);
    return Response.json({ error: "Nu am putut relua datele păstrate." }, { status: 500 });
  }
}
