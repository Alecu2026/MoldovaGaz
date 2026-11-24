import { getCurrentUser } from "@/lib/dal";
import { getFilter, setFilter } from "@/lib/services/installer";

/** „FilterDevices” din „Select Device”: filtrul de nume al listei, păstrat per utilizator. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  return Response.json({ filter: await getFilter(user.id) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { filter?: unknown } | null;
  if (!b || typeof b.filter !== "string") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  await setFilter(user.id, b.filter);
  return Response.json({ filter: b.filter.slice(0, 80) });
}
