import { apiGuard } from "@/lib/guard";
import { antennaDaily } from "@/lib/services/antennas";

/** Mesajele primite prin antenă, pe zile (ultimele 30), pentru graficul din ecranul instalatorului de antene. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  const { id } = await ctx.params;
  try {
    return Response.json({ days: await antennaDaily(id.toLowerCase(), 30) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[antennas] statistici eșuate:", e);
    return Response.json({ error: "Nu am putut citi mesajele." }, { status: 500 });
  }
}
