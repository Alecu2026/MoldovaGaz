import { apiGuard } from "@/lib/guard";
import { counterReport, resetCounters } from "@/lib/services/counters";

/** Verificarea continuității: ce numere (counter) au venit și ce lipsește, pe flux. Doar utilizatori autentificați. */
export async function GET() {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    return Response.json(await counterReport(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/counters] eșuat:", e);
    return Response.json({ error: "Nu am putut citi numerele." }, { status: 500 });
  }
}

/** „Test nou”: { "reset": "<flux>" | "all" } șterge contoarele urmărite. */
export async function POST(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    const b = (await req.json().catch(() => null)) as { reset?: unknown } | null;
    if (typeof b?.reset !== "string" || !b.reset) return Response.json({ error: "Trimite { \"reset\": \"all\" } sau numele fluxului." }, { status: 400 });
    await resetCounters(b.reset.slice(0, 80));
    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/counters] resetare eșuată:", e);
    return Response.json({ error: "Nu am putut șterge." }, { status: 500 });
  }
}
