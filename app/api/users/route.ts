import { apiGuard } from "@/lib/guard";
import { createUser, listUsers, scopeOptions } from "@/lib/services/users";

/**
 * Conturile aplicației, doar pentru administratori.
 *   GET  /api/users   → { users, branches } (conturile + filialele / orașele care se pot bifa)
 *   POST /api/users   → creează un cont { email, name, password, admin, access: { pages, branches, cities } }
 */
const H = { "Cache-Control": "private, no-store" };

export async function GET() {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    const [users, branches] = await Promise.all([listUsers(), scopeOptions()]);
    return Response.json({ users, branches, me: guard.user.id }, { headers: H });
  } catch (e) {
    console.error("[users] listă eșuată:", e);
    return Response.json({ error: "Nu am putut citi conturile." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  try {
    const r = await createUser(body);
    return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r.user, { status: 201, headers: H });
  } catch (e) {
    console.error("[users] creare eșuată:", e);
    return Response.json({ error: "Nu am putut crea contul." }, { status: 500 });
  }
}
