import { apiGuard, apiMeterGuard } from "@/lib/guard";
import { DAY, MAX_DAYS } from "@/lib/gateway-stats";
import { parseQuery } from "@/lib/gw-filter";
import { cachedJson } from "@/lib/http-cache";
import { deviceGateways, gatewayDetail, gatewayMatches, gatewayStats, gatewaySummary } from "@/lib/services/gateways";

/**
 * Antenele (gateway-uri LoRaWAN) din mesajele primite prin integrare, doar pentru utilizatori autentificați.
 *   GET /api/integration/gateways               → lista antenelor cu eficiența fiecăreia
 *   GET /api/integration/gateways?id=<antenă>   → detalii: ultimele cereri, cel mai apropiat / îndepărtat contor, liniile spre contoare (până la 10 000, compact), contoarele auzite;
 *                                               cu lite=1 (harta) fără lista completă a contoarelor
 *   GET /api/integration/gateways?device=<id>   → antenele care aud un contor
 *   GET /api/integration/gateways?stats=1&from=&to=&state=&q=&min=&sort=&gw=   → eficiența antenelor pe perioadă, pe zile (from / to = AAAA-LL-ZZ sau ms)
 *   GET /api/integration/gateways?match=1&kmin=&kmax=&pf=&pt=   → { counts }: câte contoare din filtru (rază în km + perioadă în ms) are fiecare antenă (cele cu 0 lipsesc)
 * Filtrul (kmin, kmax, pf, pt) se poate adăuga și la ?id= (liniile, numărătorile și lista contoarelor se restrâng) și la ?stats=1 (kmin / kmax: contoarele auzite din rază).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const device = q.get("device");
  const guard = device ? await apiMeterGuard("any", device.slice(0, 80)) : await apiGuard("integration");
  if ("res" in guard) return guard.res;
  const headers = { "Cache-Control": "private, no-store" };
  // răspunsuri reținute pe server (un calcul pentru toți), cu ETag / 304 și reîmprospătare în fundal; cheia = cale + filtru
  const url = new URL(req.url);
  const key = `gw|${[...url.searchParams].filter(([k]) => k !== "_").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&")}`;
  try {
    const f = parseQuery(q);
    if (q.get("match")) return cachedJson(req, key, { ttlMs: 10_000 }, async () => ({ counts: await gatewayMatches(f) }));
    if (q.get("stats")) {
      const when = (k: string, d: number) => {
        const v = q.get(k) ?? "";
        const t = /^[0-9]{10,}$/.test(v) ? Number(v) : Date.parse(v);
        return Number.isFinite(t) ? t : d;
      };
      const to = when("to", Date.now());
      const from = Math.min(Math.max(when("from", to - 6 * DAY), to - (MAX_DAYS - 1) * DAY), to);
      const state = ["on", "slow", "off"].includes(q.get("state") ?? "") ? (q.get("state") as string) : "";
      return cachedJson(req, key, { ttlMs: 10_000 }, () => gatewayStats({ from, to, state, q: (q.get("q") ?? "").slice(0, 60), minDevices: Math.max(0, Math.floor(Number(q.get("min")) || 0)), sort: (q.get("sort") ?? "devices").slice(0, 12), gw: (q.get("gw") ?? "").slice(0, 120), kmin: f.kmin, kmax: f.kmax }));
    }
    const id = q.get("id");
    if (id) {
      return cachedJson(req, key, { ttlMs: 10_000, missing: "Antena nu există." }, () => gatewayDetail(id.slice(0, 120), q.get("lite") === "1", f));
    }
    if (device) return Response.json({ gateways: await deviceGateways(device.slice(0, 80)) }, { headers });
    return cachedJson(req, key, { ttlMs: 10_000 }, () => gatewaySummary());
  } catch (e) {
    console.error("[integration/gateways] eșuat:", e);
    return Response.json({ error: "Nu am putut citi antenele." }, { status: 500 });
  }
}
