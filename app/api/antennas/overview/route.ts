import { antennaIdOk } from "@/lib/antennas";
import { parseQuery } from "@/lib/gw-filter";
import { cachedJson } from "@/lib/http-cache";
import { apiGuard } from "@/lib/guard";
import { antennaMore, antennaOverview } from "@/lib/services/antenna-overview";

/**
 * Pagina «Antene: date și hartă» (dreptul «Antene: date și hartă»; arată contoare din toate filialele, deci cere «Toate filialele»).
 *   GET /api/antennas/overview          → { rows, now }: o linie pe antenă (SCADA + integrare + legătura cu contoarele de gaz)
 *   GET /api/antennas/overview?id=<EUI> → fișa antenei, contoarele auzite și mesajele pe zi; cu filtrul kmin / kmax (rază, km) și pf / pt (perioadă, ms) doar contoarele și zilele din filtru
 */
export async function GET(req: Request) {
  const guard = await apiGuard("antennaInfo");
  if ("res" in guard) return guard.res;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (id !== null) {
      const k = id.trim().toLowerCase();
      if (!antennaIdOk(k)) return Response.json({ error: "Id invalid." }, { status: 400 });
      const sp = new URL(req.url).searchParams, f = parseQuery(sp);
      return cachedJson(req, `ant|${k}|${sp.get("kmin") ?? ""}|${sp.get("kmax") ?? ""}|${sp.get("pf") ?? ""}|${sp.get("pt") ?? ""}`, { ttlMs: 10_000, missing: "Antena nu există." }, async () => { const m = await antennaMore(k, f); return m.record ? m : null; });
    }
    return cachedJson(req, "ant|overview", { ttlMs: 10_000 }, () => antennaOverview());
  } catch (e) {
    console.error("[antennas/overview] eșuat:", e);
    return Response.json({ error: "Nu am putut citi antenele." }, { status: 500 });
  }
}
