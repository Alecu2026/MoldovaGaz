import { apiGuard, apiMeterGuard } from "@/lib/guard";
import { DAY, MAX_DAYS } from "@/lib/gateway-stats";
import { deviceGateways, gatewayDetail, gatewayStats, gatewaySummary } from "@/lib/services/gateways";

/**
 * Antenele (gateway-uri LoRaWAN) din mesajele primite prin integrare, doar pentru utilizatori autentificați.
 *   GET /api/integration/gateways               → lista antenelor cu eficiența fiecăreia
 *   GET /api/integration/gateways?id=<antenă>   → detalii: ultimele cereri, cel mai apropiat / îndepărtat contor, contoarele auzite
 *   GET /api/integration/gateways?device=<id>   → antenele care aud un contor
 *   GET /api/integration/gateways?stats=1&from=&to=&state=&q=&min=&sort=&gw=   → eficiența antenelor pe perioadă, pe zile (from / to = AAAA-LL-ZZ sau ms)
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const device = q.get("device");
  const guard = device ? await apiMeterGuard("any", device.slice(0, 80)) : await apiGuard("integration");
  if ("res" in guard) return guard.res;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    if (q.get("stats")) {
      const when = (k: string, d: number) => {
        const v = q.get(k) ?? "";
        const t = /^[0-9]{10,}$/.test(v) ? Number(v) : Date.parse(v);
        return Number.isFinite(t) ? t : d;
      };
      const to = when("to", Date.now());
      const from = Math.min(Math.max(when("from", to - 6 * DAY), to - (MAX_DAYS - 1) * DAY), to);
      const state = ["on", "slow", "off"].includes(q.get("state") ?? "") ? (q.get("state") as string) : "";
      const stats = await gatewayStats({ from, to, state, q: (q.get("q") ?? "").slice(0, 60), minDevices: Math.max(0, Math.floor(Number(q.get("min")) || 0)), sort: (q.get("sort") ?? "devices").slice(0, 12), gw: (q.get("gw") ?? "").slice(0, 120) });
      return Response.json(stats, { headers });
    }
    const id = q.get("id");
    if (id) {
      const d = await gatewayDetail(id.slice(0, 120));
      return d ? Response.json(d, { headers }) : Response.json({ error: "Antena nu există." }, { status: 404 });
    }
    if (device) return Response.json({ gateways: await deviceGateways(device.slice(0, 80)) }, { headers });
    return Response.json(await gatewaySummary(), { headers });
  } catch (e) {
    console.error("[integration/gateways] eșuat:", e);
    return Response.json({ error: "Nu am putut citi antenele." }, { status: 500 });
  }
}
