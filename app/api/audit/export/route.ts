import { Readable } from "node:stream";
import { actorOf } from "@/lib/audit-actor";
import { auditFiltersToParams, sanitizeAuditFilters } from "@/lib/audit-meta";
import { fmtLocal } from "@/lib/report-readings";
import { apiGuard } from "@/lib/guard";
import { exportAuditCsv, logAudit } from "@/lib/services/audit";

/** Exportul jurnalului (CSV, separator «;», BOM) pentru filtrul din adresă — dreptul «Descărcare»; curge pe bucăți, deci nu ține tot jurnalul în memorie. Exportul însuși se scrie în jurnal. */
export async function GET(req: Request) {
  const guard = await apiGuard("audit", "export");
  if ("res" in guard) return guard.res;
  const f = sanitizeAuditFilters(Object.fromEntries(new URL(req.url).searchParams.entries()));
  await logAudit(actorOf(guard.user), { action: "audit.export", req, objectName: auditFiltersToParams(f).toString() || "fără filtre", extra: [{ label: "Filtre", value: auditFiltersToParams(f).toString() || "niciunul" }] });
  const it = exportAuditCsv(f);
  const stream = Readable.toWeb(Readable.from(it)) as unknown as ReadableStream;
  const name = `jurnal-audit_${fmtLocal(Date.now()).slice(0, 16).split(" ").join("_").split(":").join("")}.csv`;
  return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
