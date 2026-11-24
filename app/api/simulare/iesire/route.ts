import { getCurrentUser } from "@/lib/dal";
import { exitImpersonation } from "@/lib/services/impersonation";

/** Ieșirea din simularea de login (butonul din bara de jos): sesiunea proprie revine, fără autentificare nouă. Poate fi apelată doar din interiorul unei simulări (sau după ce a expirat). */
export async function POST() {
  const u = await getCurrentUser();
  if (u && !u.impersonation) return Response.json({ error: "Nu ești într-o simulare de login." }, { status: 400 });
  try {
    const r = await exitImpersonation();
    return r.ok ? Response.json({ to: r.to }, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: r.error }, { status: r.status });
  } catch (e) {
    console.error("[simulare] ieșire eșuată:", e);
    return Response.json({ error: "Nu am putut ieși din simulare." }, { status: 500 });
  }
}
