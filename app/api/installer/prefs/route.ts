import { apiGuard } from "@/lib/guard";
import { getFilter, setFilter } from "@/lib/services/installer";

/** „FilterDevices” din „Select Device”: filtrul de nume al listei, păstrat per utilizator. */
export async function GET() {
  const guard = await apiGuard("installer");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  return Response.json({ filter: await getFilter(user.id) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const guard = await apiGuard("installer");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  const b = (await req.json().catch(() => null)) as { filter?: unknown } | null;
  if (!b || typeof b.filter !== "string") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  await setFilter(user.id, b.filter);
  return Response.json({ filter: b.filter.slice(0, 80) });
}
