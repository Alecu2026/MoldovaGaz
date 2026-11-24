import { apiGuard } from "@/lib/guard";
import { localToUtc, type ReportParams } from "@/lib/report-readings";
import { createReport, dir, listReports, previewNow } from "@/lib/services/reports";

/**
 * Raportul de citiri către facturare, doar pentru utilizatori autentificați.
 *   GET  /api/reports                                   → rapoartele generate + locul unde se scriu
 *   POST /api/reports { action: "preview" | "start", at: "AAAA-LL-ZZTHH:MM", onlyBilled? }
 *        at = data și ora aleasă (ora Moldovei): în raport intră, pentru fiecare contor, ultima citire făcută până atunci. Nu poate fi în viitor.
 */
function params(b: Record<string, unknown>): ReportParams | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(b.at ?? ""));
  if (!m) return "Alege data și ora raportului.";
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return "Data sau ora nu sunt valide.";
  const at = localToUtc(y, mo, d, h, mi);
  if (at > Date.now() + 5 * 60_000) return "Data și ora nu pot fi în viitor.";
  return { at, onlyBilled: b.onlyBilled !== false };
}

export async function GET() {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  try {
    return Response.json({ reports: await listReports(), dir: dir() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[reports] listare eșuată:", e);
    return Response.json({ error: "Nu am putut citi rapoartele." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const guard = await apiGuard("admin");
  if ("res" in guard) return guard.res;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || (b.action !== "preview" && b.action !== "start")) return Response.json({ error: "Trimite { \"action\": \"preview\" | \"start\", … }." }, { status: 400 });
  const p = params(b);
  if (typeof p === "string") return Response.json({ error: p }, { status: 400 });
  try {
    const headers = { "Cache-Control": "private, no-store" };
    if (b.action === "preview") return Response.json({ ...(await previewNow(p)), at: p.at }, { headers });
    return Response.json({ id: await createReport(p, guard.user.email) }, { headers });
  } catch (e) {
    console.error("[reports] eșuat:", e);
    return Response.json({ error: (e as Error).message || "Nu am putut genera raportul." }, { status: 500 });
  }
}
