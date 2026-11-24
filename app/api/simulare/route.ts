import { apiGuard } from "@/lib/guard";
import { startImpersonation } from "@/lib/services/impersonation";

/**
 * Simulare de login (pagina «Utilizatori», dreptul «Simulare»): POST { userId } → intri în aplicație ca acel cont, 6 ore. Regulile (cine pe cine) sunt în lib/impersonation.ts.
 * Un cont aflat deja într-o simulare nu poate porni alta (nici nu trece de gardă: simulatul are drepturile contului simulat).
 */
export async function POST(req: Request) {
  const guard = await apiGuard("users", "impersonate");
  if ("res" in guard) return guard.res;
  const b = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  if (typeof b?.userId !== "string") return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  try {
    const r = await startImpersonation(guard.user, b.userId);
    return r.ok ? Response.json({ to: r.to }, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: r.error }, { status: r.status });
  } catch (e) {
    console.error("[simulare] pornire eșuată:", e);
    return Response.json({ error: "Nu am putut porni simularea." }, { status: 500 });
  }
}
