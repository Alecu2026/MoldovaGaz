import { apiGuard } from "@/lib/guard";
import { integrationStats } from "@/lib/services/integration";

/** Starea integrării pentru pagina /integration (doar utilizatori autentificați): ritm, cutia de intrare, ultimele mesaje. Fără token și fără conținutul mesajelor. */
export async function GET() {
  const guard = await apiGuard("integration");
  if ("res" in guard) return guard.res;
  try {
    return Response.json(await integrationStats(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/stats] eșuat:", e);
    return Response.json({ error: "Nu am putut citi starea." }, { status: 500 });
  }
}
