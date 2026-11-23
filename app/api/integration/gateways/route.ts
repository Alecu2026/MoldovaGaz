import { getCurrentUser } from "@/lib/dal";
import { deviceGateways, gatewayDetail, gatewaySummary } from "@/lib/services/gateways";

/**
 * Antenele (gateway-uri LoRaWAN) din mesajele primite prin integrare, doar pentru utilizatori autentificați.
 *   GET /api/integration/gateways               → lista antenelor cu eficiența fiecăreia
 *   GET /api/integration/gateways?id=<antenă>   → detalii: ultimele cereri, cel mai apropiat / îndepărtat contor, contoarele auzite
 *   GET /api/integration/gateways?device=<id>   → antenele care aud un contor
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const id = q.get("id"), device = q.get("device");
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
