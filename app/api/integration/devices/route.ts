import { apiGuard } from "@/lib/guard";
import { integrationDevices } from "@/lib/services/integration";
import { seenPage } from "@/lib/services/seen";

/** „De la care contoare ia date”: contoarele care au trimis prin integrare + ce s-a păstrat, cu contorul cu care se potrivește. Doar utilizatori autentificați. */
export async function GET(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    const q = new URL(req.url).searchParams;
    if (q.has("skip")) return Response.json(await seenPage(Number(q.get("skip")), Number(q.get("limit")), q.get("q") ?? ""), { headers: { "Cache-Control": "private, no-store" } });
    return Response.json(await integrationDevices(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[integration/devices] eșuat:", e);
    return Response.json({ error: "Nu am putut citi lista." }, { status: 500 });
  }
}
