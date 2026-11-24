import { apiGuard } from "@/lib/guard";
import { buildDeltaFor, genFor, getStore } from "@/lib/services/meter-dataset";

type Lens = { ap: number; gw: number; ty: number; br: number; ct: number; pf: number };

/**
 * Doar ce s-a schimbat: `?gen=…&after=<seq-ul pe care îl are browserul>&ap=&gw=&ty=&br=&ct=&pf=<lungimile dicționarelor lui>`.
 * Răspunde `{full:true}` dacă generația diferă (server repornit / contoare dispărute) ⇒ browserul cere lista întreagă.
 * Fără modificări răspunsul are zero rânduri (câteva zeci de octeți) — pentru polling. Compresia (gzip) o face Next.
 */
export async function GET(req: Request) {
  const guard = await apiGuard("meters");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  const sp = new URL(req.url).searchParams;
  const int = (k: string) => {
    const n = Number(sp.get(k));
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const after = int("after");
  const l = { ap: int("ap"), gw: int("gw"), ty: int("ty"), br: int("br"), ct: int("ct"), pf: int("pf") };
  if (after == null || l.ap == null || l.gw == null || l.ty == null || l.br == null || l.ct == null || l.pf == null) {
    return Response.json({ error: "Parametri invalizi." }, { status: 400 });
  }
  try {
    const st = await getStore();
    const out = sp.get("gen") === genFor(st, user) ? buildDeltaFor(st, user, after, l as Lens) : { v: 3 as const, full: true as const };
    return Response.json(out, { headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
  } catch (e) {
    console.error("[meters/delta] eșuat:", e);
    return Response.json({ error: "Nu am putut sincroniza." }, { status: 500 });
  }
}
