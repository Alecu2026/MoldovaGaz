import { getCurrentUser } from "@/lib/dal";
import { getUplinkPayload } from "@/lib/services/uplink-dataset";

/** Payload-ul original al unui mesaj (panoul de detalii). Mesajele sunt imutabile ⇒ răspunsul se poate ține în cache-ul browserului o zi. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{24}$/.test(id)) return Response.json({ error: "Id invalid." }, { status: 400 });
  const etag = `"${id}"`;
  const headers = { ETag: etag, "Cache-Control": "private, max-age=86400, immutable", Vary: "Cookie" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  try {
    const d = await getUplinkPayload(id);
    if (!d) return Response.json({ error: "Mesajul nu există." }, { status: 404 });
    return Response.json({ id, ts: d.ts, receivedAt: d.receivedAt, payload: d.payload }, { headers });
  } catch (e) {
    console.error("[uplinks/detail] eșuat:", e);
    return Response.json({ error: "Nu am putut încărca mesajul." }, { status: 500 });
  }
}
