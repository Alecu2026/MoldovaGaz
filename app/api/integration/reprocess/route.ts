import { apiGuard } from "@/lib/guard";
import { reprocessKept } from "@/lib/services/integration";

/** Reia datele păstrate (integration_raw): ce se poate aplica acum merge în cutia de intrare. Doar utilizatori autentificați; apelat de butonul din pagina /integration. */
export async function POST() {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    return Response.json(await reprocessKept(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/reprocess] eșuat:", e);
    return Response.json({ error: "Nu am putut relua datele păstrate." }, { status: 500 });
  }
}
