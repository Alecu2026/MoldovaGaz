import { getCurrentUser } from "@/lib/dal";
import { integrationStats } from "@/lib/services/integration";

/** Starea integrării pentru pagina /integration (doar utilizatori autentificați): ritm, cutia de intrare, ultimele mesaje. Fără token și fără conținutul mesajelor. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  try {
    return Response.json(await integrationStats(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/stats] eșuat:", e);
    return Response.json({ error: "Nu am putut citi starea." }, { status: 500 });
  }
}
