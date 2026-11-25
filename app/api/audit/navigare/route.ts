import { actorOf } from "@/lib/audit-actor";
import { pageName } from "@/lib/audit-meta";
import { getCurrentUser } from "@/lib/dal";
import { hit } from "@/lib/rate-limit";
import { logAuditMany, type AuditInput } from "@/lib/services/audit";

/**
 * Navigarea în aplicație, pentru jurnalul de audit: fiecare pagină deschisă, cât timp a stat utilizatorul pe ea, filtrele / vederea schimbate și clicurile pe butoane, linkuri, file.
 * Browserul trimite evenimentele în grupuri mici (sendBeacon). Pentru orice cont autentificat (nu cere drepturi: e jurnalul propriilor pași), cu limită pe cont.
 *   POST /api/audit/navigare { events: [{ t: "view" | "leave" | "query" | "click", p, ago, … }] }   (cel mult 40 de evenimente, 20 KB)
 * Nu se păstrează conținutul câmpurilor (parole, text scris), ci doar textul butoanelor / linkurilor și adresele paginilor.
 */
const NOT_SECRET = (k: string) => !/pass|parol|token|secret|key|cheie|auth/i.test(k);
const str = (v: unknown, n: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n) : "");
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
const PATH = /^\/[A-Za-z0-9/_\-.]{0,120}$/;
const path = (v: unknown): string | null => { const t = str(v, 140); return PATH.test(t) ? t : null; };
/** adresa fără valori sensibile (alte nume de parametri rămân, valorile lungi se taie) */
const query = (v: unknown): string => {
  const t = str(v, 400).replace(/^\?/, "");
  if (!t) return "";
  try { const u = new URLSearchParams(t); const o = new URLSearchParams(); for (const [k, val] of u) if (NOT_SECRET(k)) o.set(k, val.slice(0, 120)); return o.toString().slice(0, 300); } catch { return ""; }
};
const dur = (s: number): string => (s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);
const NAVTYPE: Record<string, string> = { load: "încărcare directă (adresă / link)", app: "navigare în aplicație", reload: "reîncărcare (F5)", back: "înapoi / înainte" };

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Autentificare necesară." }, { status: 401 });
  if (!hit(`nav|${user.id}`, 240, 60_000)) return Response.json({ error: "Prea multe cereri." }, { status: 429 });
  const raw = await req.text().catch(() => "");
  if (raw.length > 20_000) return Response.json({ error: "Cerere prea mare." }, { status: 413 });
  let b: { events?: unknown } | null = null;
  try { b = JSON.parse(raw) as { events?: unknown }; } catch { /* corp invalid */ }
  if (!b || !Array.isArray(b.events)) return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  const now = Date.now();
  const out: AuditInput[] = [];
  for (const e of b.events.slice(0, 40) as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const p = path(e.p);
    if (!p) continue;
    const atMs = now - (num(e.ago, 0, 600_000) ?? 0);
    const base = { path: p, atMs, objectId: p };
    if (e.t === "view") {
      const q = query(e.q), ref = path(e.ref), ti = str(e.ti, 120), d = e.dev && typeof e.dev === "object" ? (e.dev as Record<string, unknown>) : null;
      const extra = [{ label: "Pagină", value: pageName(p) }, { label: "Adresă", value: q ? `${p}?${q}` : p }, ...(ti ? [{ label: "Titlul filei", value: ti }] : []), { label: "Venit din", value: ref ? `${pageName(ref)} (${ref})` : "— (deschidere directă)" }, { label: "Cum a ajuns", value: NAVTYPE[str(e.nav, 8)] ?? "navigare" }];
      if (d) extra.push({ label: "Ecran / fereastră", value: `${num(d.sw, 0, 20000) ?? "?"}×${num(d.sh, 0, 20000) ?? "?"} / ${num(d.vw, 0, 20000) ?? "?"}×${num(d.vh, 0, 20000) ?? "?"} px · densitate ${num(d.dpr, 0, 10) ?? "?"}`, }, { label: "Limbă · fus orar", value: `${str(d.lang, 20)} · ${str(d.tz, 40)}` }, { label: "Conexiune", value: str(d.conn, 40) || "—" });
      out.push({ ...base, action: "nav.view", objectName: pageName(p), summary: q ? `${p}?${q}` : p, extra });
    } else if (e.t === "leave") {
      const s = num(e.s, 0, 86_400) ?? 0, w = num(e.w, 0, 86_400) ?? s;
      out.push({ ...base, action: "nav.leave", objectName: pageName(p), ms: s * 1000, summary: `a stat ${dur(s)}`, extra: [{ label: "Pagină", value: pageName(p) }, { label: "Timp cu pagina vizibilă", value: dur(s) }, { label: "Timp total deschisă", value: dur(w) }, ...(str(e.why, 12) ? [{ label: "Motiv", value: ({ nav: "a trecut pe altă pagină", hide: "a închis / a ascuns fila", exit: "a ieșit din aplicație" } as Record<string, string>)[str(e.why, 12)] ?? str(e.why, 12) }] : [])] });
    } else if (e.t === "query") {
      const q = query(e.q), pq = query(e.pq);
      out.push({ ...base, action: "nav.query", objectName: `${pageName(p)}${q ? ` ?${q}` : " (fără filtre)"}`.slice(0, 200), oldValue: pq || null, newValue: q || null, summary: `${p} → ${q || "fără filtre"}`, extra: [{ label: "Pagină", value: pageName(p) }, { label: "Filtre / vedere acum", value: q || "— (fără)" }] });
    } else if (e.t === "click") {
      const x = str(e.x, 90), k = str(e.k, 20), h = str(e.h, 160);
      if (!x && !h) continue;
      out.push({ ...base, action: "nav.click", objectId: null, objectName: x || h, summary: `pe ${pageName(p)}${h ? ` → ${h}` : ""}`, extra: [{ label: "Pe pagina", value: `${pageName(p)} (${p})` }, { label: "Element", value: k || "—" }, ...(h ? [{ label: "Duce la", value: h }] : [])] });
    }
  }
  await logAuditMany(actorOf(user), out);
  return Response.json({ ok: true, n: out.length }, { headers: { "Cache-Control": "no-store" } });
}
