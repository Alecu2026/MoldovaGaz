import { actorOf } from "@/lib/audit-actor";
import { AUDIT_FIRST_CHUNK, AUDIT_NEXT_CHUNK, sanitizeAuditFilters } from "@/lib/audit-meta";
import { apiGuard } from "@/lib/guard";
import { auditSummary, countAudit, getAudit, listAudit, logAuditOnce } from "@/lib/services/audit";

/**
 * Jurnalul de audit (pagina «Jurnal de audit»; arată activitatea tuturor utilizatorilor, deci cere «Toate filialele»).
 *   GET /api/audit?summary=1                    → rezumatul din antet (24 h, grafic pe 14 zile, cei mai activi) + lista utilizatorilor pentru filtru
 *   GET /api/audit?id=<id>                      → un rând întreg (user-agent, valori, modificări pe câmpuri)
 *   GET /api/audit?count=1&<filtre>             → { n, capped } totalul pentru filtru (plafonat)
 *   GET /api/audit?<filtre>&cursor=…&limit=…    → { rows, next } o bucată din listă, cele mai noi primele
 * Filtre: user, module, action, severity, status, from, to (AAAA-LL-ZZ, ora Moldovei), q, changes=1. `fresh=1` ocolește memoria de ~secunde.
 */
export async function GET(req: Request) {
  const guard = await apiGuard("audit");
  if ("res" in guard) return guard.res;
  const q = new URL(req.url).searchParams;
  const headers = { "Cache-Control": "private, no-store" };
  const fresh = q.get("fresh") === "1";
  try {
    // cine deschide jurnalul rămâne în jurnal (cel mult o dată la 10 minute)
    if (q.get("summary")) await logAuditOnce(`audit-view|${guard.user.id}`, 600_000, actorOf(guard.user), { action: "audit.view", req });
    if (q.get("summary")) return Response.json(await auditSummary(fresh), { headers });
    const id = q.get("id");
    if (id !== null) { const r = await getAudit(id); return r ? Response.json(r, { headers }) : Response.json({ error: "Rândul nu există." }, { status: 404 }); }
    const f = sanitizeAuditFilters(Object.fromEntries(q.entries()));
    if (q.get("count")) return Response.json(await countAudit(f, fresh), { headers });
    const cursor = q.get("cursor") ?? undefined;
    const limit = Math.min(AUDIT_NEXT_CHUNK, Math.max(1, Math.floor(Number(q.get("limit")) || (cursor ? AUDIT_NEXT_CHUNK : AUDIT_FIRST_CHUNK))));
    return Response.json(await listAudit(f, { cursor, limit, fresh }), { headers });
  } catch (e) {
    console.error("[audit] citire eșuată:", e);
    return Response.json({ error: "Nu am putut citi jurnalul." }, { status: 500 });
  }
}
