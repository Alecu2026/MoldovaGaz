import { apiMeterGuard } from "@/lib/guard";
import { getMeterDoc } from "@/lib/services/meter-dataset";

/** Documentul complet al unui contor (facturare, atribute, ultima telemetrie) pentru panoul de detalii. Se revalidează (ETag = momentul ultimei modificări). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await apiMeterGuard("any", id);
  if ("res" in guard) return guard.res;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  try {
    const d = await getMeterDoc(id);
    if (!d) return Response.json({ error: "Contorul nu există." }, { status: 404 });
    const etag = `"${String(d.updatedAt instanceof Date ? d.updatedAt.getTime() : 0)}"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return Response.json({ id, updatedAt: d.updatedAt, tb: d.tb, bill: d.bill, attrs: d.attrs, tel: d.tel, s: d.s }, { headers });
  } catch (e) {
    console.error("[meters/detail] eșuat:", e);
    return Response.json({ error: "Nu am putut încărca contorul." }, { status: 500 });
  }
}
