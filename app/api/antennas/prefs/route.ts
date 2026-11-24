import { apiGuard } from "@/lib/guard";
import { getAntennaFilter, setAntennaFilter } from "@/lib/services/antennas";

/** „FilterDevices” din „Select Device” (antene): filtrul de nume al listei, păstrat per utilizator. */
export async function GET() {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  return Response.json({ filter: await getAntennaFilter(guard.user.id) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const guard = await apiGuard("antennas");
  if ("res" in guard) return guard.res;
  const b = (await req.json().catch(() => null)) as { filter?: unknown } | null;
  if (!b || typeof b.filter !== "string") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  await setAntennaFilter(guard.user.id, b.filter);
  return Response.json({ filter: b.filter.slice(0, 80) });
}
