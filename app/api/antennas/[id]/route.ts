import { apiGuard } from "@/lib/guard";
import { getAntenna, saveAntenna } from "@/lib/services/antennas";

/** Datele unei antene pentru formularul „Gateway Update” (GET) și salvarea câmpurilor trimise (POST). Se salvează doar în baza noastră, nu în SCADA. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  try {
    const r = await getAntenna(id.toLowerCase());
    return r ? Response.json(r, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: "Antena nu există." }, { status: 404 });
  } catch (e) {
    console.error("[antennas] citire eșuată:", e);
    return Response.json({ error: "Nu am putut citi antena." }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  try {
    const r = await saveAntenna(id.toLowerCase(), body, guard.user.email);
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r.record, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[antennas] salvare eșuată:", e);
    return Response.json({ error: "Nu am putut salva." }, { status: 500 });
  }
}
