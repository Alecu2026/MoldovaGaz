import { antennaIdOk } from "@/lib/antennas";
import { apiGuard } from "@/lib/guard";
import { antennaMore, antennaOverview } from "@/lib/services/antenna-overview";

/**
 * Pagina «Antene: date și hartă» (dreptul «Antene: date și hartă»; arată contoare din toate filialele, deci cere «Toate filialele»).
 *   GET /api/antennas/overview          → { rows, now }: o linie pe antenă (SCADA + integrare + legătura cu contoarele de gaz)
 *   GET /api/antennas/overview?id=<EUI> → fișa antenei, contoarele auzite și mesajele pe zi
 */
export async function GET(req: Request) {
  const guard = await apiGuard("antennaInfo");
  if ("res" in guard) return guard.res;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (id !== null) {
      const k = id.trim().toLowerCase();
      if (!antennaIdOk(k)) return Response.json({ error: "Id invalid." }, { status: 400 });
      const m = await antennaMore(k);
      return m.record ? Response.json(m, { headers }) : Response.json({ error: "Antena nu există." }, { status: 404 });
    }
    return Response.json(await antennaOverview(), { headers });
  } catch (e) {
    console.error("[antennas/overview] eșuat:", e);
    return Response.json({ error: "Nu am putut citi antenele." }, { status: 500 });
  }
}
