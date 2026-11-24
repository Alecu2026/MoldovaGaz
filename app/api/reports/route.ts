import { apiGuard } from "@/lib/guard";
import { localMidnight } from "@/lib/night-analysis";
import { previousMonth, thisMonthSoFar, type ReportMode, type ReportParams } from "@/lib/report-readings";
import { createReport, dir, listReports, previewNow } from "@/lib/services/reports";

/**
 * Raportul de citiri către facturare, doar pentru utilizatori autentificați.
 *   GET  /api/reports                                   → rapoartele generate + locul unde se scriu
 *   POST /api/reports { action: "preview" | "start", period: "this" | "prev" | "custom", from?, to?, mode?, onlyBilled? }
 *        from / to (pentru "custom") = AAAA-LL-ZZ, ambele zile incluse, în ora Moldovei.
 */
const DAY = 86_400_000;

function ymd(v: unknown): { y: number; m: number; d: number } | null {
  const a = String(v ?? "").split("-").map(Number);
  if (a.length !== 3 || a.some((x) => !Number.isInteger(x))) return null;
  const [y, m, d] = a;
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null;
}

function params(b: Record<string, unknown>): ReportParams | string {
  const now = Date.now();
  let r: { from: number; to: number };
  if (b.period === "prev") r = previousMonth(now);
  else if (b.period === "this") r = thisMonthSoFar(now);
  else if (b.period === "custom") {
    const a = ymd(b.from), z = ymd(b.to);
    if (!a || !z) return "Alege ambele date (de la / până la).";
    r = { from: localMidnight(a.y, a.m, a.d), to: localMidnight(z.y, z.m, z.d + 1) };
  } else return "Alege perioada.";
  if (!(r.to > r.from)) return "Perioada e goală sau „până la” e înaintea lui „de la”.";
  if (r.to - r.from > 400 * DAY) return "Perioada poate avea cel mult 400 de zile.";
  const mode: ReportMode = b.mode === "daily" ? "daily" : b.mode === "last" ? "last" : "all";
  return { ...r, mode, onlyBilled: b.onlyBilled !== false };
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
    if (b.action === "preview") return Response.json({ ...(await previewNow(p)), from: p.from, to: p.to }, { headers });
    return Response.json({ id: await createReport(p, guard.user.email) }, { headers });
  } catch (e) {
    console.error("[reports] eșuat:", e);
    return Response.json({ error: (e as Error).message || "Nu am putut genera raportul." }, { status: 500 });
  }
}
