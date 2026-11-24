import { apiGuard } from "@/lib/guard";
import { parseQr } from "@/lib/installer";
import { countMeters, findByName, listMeters } from "@/lib/services/installer";

/**
 * Ecranul instalatorului (vezi lib/installer.ts), doar pentru utilizatori autentificați.
 *   GET /api/installer/meters?q=&page=0&size=10&sort=name&dir=asc   → lista paginată (ca „Device admin table”)
 *   GET /api/installer/meters?code=<text citit din codul QR>         → { name, found: { id, name } | null, total } (contorul din codul QR)
 */
export async function GET(req: Request) {
  const guard = await apiGuard("installer");
  if ("res" in guard) return guard.res;
  const user = guard.user;
  const u = new URL(req.url).searchParams;
  try {
    const code = u.get("code");
    if (code !== null) {
      const name = parseQr(code);
      return Response.json({ name, found: name ? await findByName(name, user) : null, total: await countMeters(user) }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const size = [10, 25, 50, 100].includes(Number(u.get("size"))) ? Number(u.get("size")) : 10;
    const page = Math.max(0, Math.min(100_000, Math.floor(Number(u.get("page")) || 0)));
    return Response.json(await listMeters(user, { q: u.get("q") ?? "", page, size, sort: u.get("sort") ?? "name", dir: u.get("dir") === "desc" ? -1 : 1 }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[installer] listă eșuată:", e);
    return Response.json({ error: "Nu am putut citi lista." }, { status: 500 });
  }
}
