import { getCurrentUser } from "@/lib/dal";
import { reprocessKept } from "@/lib/services/integration";

/** Reia datele păstrate (integration_raw): ce se poate aplica acum merge în cutia de intrare. Doar utilizatori autentificați; apelat de butonul din pagina /integration. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  try {
    return Response.json(await reprocessKept(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/reprocess] eșuat:", e);
    return Response.json({ error: "Nu am putut relua datele păstrate." }, { status: 500 });
  }
}
