import { getCurrentUser } from "@/lib/dal";
import { buildDelta, getStore } from "@/lib/services/uplink-dataset";

/**
 * Doar ce e nou: `?gen=…&after=<poziția pe care o are browserul>&dev=&gw=&ap=&ty=<lungimile dicționarelor lui>`.
 * Răspunde `{full:true}` dacă generația diferă (server repornit / ștergeri) sau poziția nu mai e în jurnal ⇒ browserul cere lista întreagă.
 * Fără mesaje noi răspunsul are zero rânduri (câțiva zeci de octeți) — pentru polling. Compresia (gzip) o face Next.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const int = (k: string) => {
    const n = Number(sp.get(k));
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const after = int("after");
  const lens = { dev: int("dev"), gw: int("gw"), ap: int("ap"), ty: int("ty") };
  if (after == null || lens.dev == null || lens.gw == null || lens.ap == null || lens.ty == null) {
    return Response.json({ error: "Parametri invalizi." }, { status: 400 });
  }
  try {
    const st = await getStore();
    const out = sp.get("gen") === st.gen ? buildDelta(st, after, { dev: lens.dev, gw: lens.gw, ap: lens.ap, ty: lens.ty }) : { v: 2 as const, full: true as const };
    return Response.json(out, { headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
  } catch (e) {
    console.error("[uplinks/delta] eșuat:", e);
    return Response.json({ error: "Nu am putut sincroniza." }, { status: 500 });
  }
}
