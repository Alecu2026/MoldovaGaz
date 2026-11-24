/**
 * Jurnalul de audit — părțile comune client + server (fără importuri de server): module, acțiuni cu etichete, gravitate, detalii structurate, filtre.
 * Fiecare acțiune a unui utilizator care schimbă ceva (sau care contează pentru securitate) lasă un rând în colecția `audit_log`: cine, când, de unde (IP, browser, pagină),
 * ce obiect, ce s-a schimbat (valoare veche → nouă, pe câmpuri) și dacă a reușit. Parolele, cheile și tokenurile NU se păstrează niciodată.
 */

export const AUDIT_MODULES = ["auth", "users", "reports", "lorawan", "installer", "antennas", "integration", "notifications", "data", "security"] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];
export const MODULE_LABELS: Record<AuditModule, string> = {
  auth: "Autentificare", users: "Utilizatori", reports: "Rapoarte", lorawan: "Module LoRaWAN", installer: "Instalator contoare", antennas: "Antene",
  integration: "Integrare", notifications: "Notificări", data: "Date consultate", security: "Securitate",
};

/** Gravitate: info = obișnuit, warn = merită privit (ștergeri, drepturi, eșecuri, acces refuzat), crit = serios (prea multe încercări, acces administrativ nou). */
export type Severity = "info" | "warn" | "crit";

type ActionMeta = { label: string; short: string; module: AuditModule; severity: Severity };
const A = (module: AuditModule, label: string, short: string, severity: Severity = "info"): ActionMeta => ({ module, label, short, severity });
export const ACTIONS: Record<string, ActionMeta> = {
  "auth.login": A("auth", "Autentificare reușită", "Autentificat"),
  "auth.login_failed": A("auth", "Autentificare eșuată", "Parolă / cont greșit", "warn"),
  "auth.login_blocked": A("auth", "Autentificare blocată (prea multe încercări)", "Blocat temporar", "crit"),
  "auth.logout": A("auth", "Ieșire din cont", "Deconectat"),
  "user.create": A("users", "Cont creat", "Cont creat", "warn"),
  "user.update": A("users", "Cont modificat", "Cont modificat"),
  "user.permissions_change": A("users", "Drepturi schimbate", "Drepturi schimbate", "warn"),
  "user.admin_change": A("users", "Drept de administrator schimbat", "Administrator schimbat", "crit"),
  "user.status_change": A("users", "Cont activat / dezactivat", "Stare cont", "warn"),
  "user.password_change": A("users", "Parolă schimbată de altcineva", "Parolă schimbată", "warn"),
  "user.delete": A("users", "Cont șters", "Cont șters", "warn"),
  "report.preview": A("reports", "Previzualizare raport", "Previzualizare"),
  "report.create": A("reports", "Raport generat", "Raport generat"),
  "report.download": A("reports", "Raport descărcat", "Raport descărcat"),
  "report.delete": A("reports", "Raport șters", "Raport șters", "warn"),
  "lorawan.module_add": A("lorawan", "Module adăugate în evidență", "Module adăugate"),
  "lorawan.simulate": A("lorawan", "Proces LoRaWAN simulat", "Simulare"),
  "lorawan.run": A("lorawan", "Proces LoRaWAN rulat în ChirpStack", "Rulat în ChirpStack", "warn"),
  "lorawan.module_delete": A("lorawan", "Modul scos din evidență", "Modul scos", "warn"),
  "lorawan.antenna_create": A("lorawan", "Antenă creată", "Antenă creată"),
  "lorawan.antenna_delete": A("lorawan", "Antenă scoasă din evidență", "Antenă scoasă", "warn"),
  "installer.save": A("installer", "Date de montaj salvate", "Date montaj"),
  "installer.photo": A("installer", "Poză contor salvată", "Poză contor"),
  "antenna.save": A("antennas", "Datele antenei salvate", "Date antenă"),
  "antenna.photo": A("antennas", "Poză antenă salvată", "Poză antenă"),
  "integration.reprocess": A("integration", "Date păstrate reluate", "Reluare date"),
  "integration.kept_clear": A("integration", "Date păstrate curățate", "Date curățate", "warn"),
  "integration.counters_reset": A("integration", "Contoare de continuitate resetate", "Contoare resetate", "warn"),
  "notify.subscribe": A("notifications", "Notificări pornite pe un dispozitiv", "Notificări pornite"),
  "notify.unsubscribe": A("notifications", "Notificări oprite pe un dispozitiv", "Notificări oprite"),
  "notify.test": A("notifications", "Notificare de probă trimisă", "Notificare de probă"),
  "data.view": A("data", "Date personale / de facturare consultate", "Date consultate"),
  "security.denied": A("security", "Acces refuzat (drept lipsă)", "Acces refuzat", "warn"),
  "audit.view": A("security", "Jurnalul de audit deschis", "Audit deschis"),
  "audit.export": A("security", "Jurnalul de audit exportat (CSV)", "Audit exportat", "warn"),
};
export const ACTION_OPTIONS = Object.entries(ACTIONS).map(([key, m]) => ({ key, label: m.label, module: m.module }));
export const actionLabel = (a: string): string => ACTIONS[a]?.label ?? a;
export const actionShort = (a: string): string => ACTIONS[a]?.short ?? a;
export const actionModule = (a: string): AuditModule => ACTIONS[a]?.module ?? "data";
export const actionSeverity = (a: string, ok: boolean): Severity => { const s = ACTIONS[a]?.severity ?? "info"; return !ok && s === "info" ? "warn" : s; };
export const moduleLabel = (m: string): string => (MODULE_LABELS as Record<string, string>)[m] ?? m;

/** O modificare pe un câmp: valoarea veche → cea nouă (text deja formatat; null = gol). */
export type AuditChange = { field: string; label: string; old: string | null; new: string | null };
/** Informații suplimentare (etichetă → valoare), ex. «Tip proces: Înregistrare + activare». */
export type AuditExtra = { label: string; value: string };
export type AuditDetails = { changes?: AuditChange[]; extra?: AuditExtra[] };

/** Un rând din jurnal, cum ajunge în browser (fără textele lungi: acelea vin la deschiderea rândului). */
export type AuditRow = {
  id: string; at: number; userId: string | null; userName: string; userEmail: string | null; role: "admin" | "user" | "anon";
  action: string; module: string; objectId: string | null; objectName: string | null; summary: string | null;
  ok: boolean; ip: string | null; path: string | null; nChanges: number;
};
/** Rândul întreg (la deschidere). */
export type AuditFull = AuditRow & { ua: string | null; xff: string | null; method: string | null; ms: number | null; oldValue: string | null; newValue: string | null; details: AuditDetails | null };

/** Descrie un user-agent pe scurt: browser · sistem · tip dispozitiv. */
export function describeAgent(ua: string | null | undefined): { browser: string; os: string; device: string } | null {
  if (!ua) return null;
  const m = (re: RegExp) => re.exec(ua)?.[1];
  const browser = m(/Edg\/(\d+)/) ? `Edge ${m(/Edg\/(\d+)/)}` : m(/OPR\/(\d+)/) ? `Opera ${m(/OPR\/(\d+)/)}` : m(/Firefox\/(\d+)/) ? `Firefox ${m(/Firefox\/(\d+)/)}`
    : m(/Chrome\/(\d+)/) ? `Chrome ${m(/Chrome\/(\d+)/)}` : /Version\/(\d+).*Safari/.test(ua) ? `Safari ${m(/Version\/(\d+)/)}` : /curl\//.test(ua) ? "curl" : /node|undici/i.test(ua) ? "script (node)" : "necunoscut";
  const os = /Windows/.test(ua) ? "Windows" : m(/Android (\d+)/) ? `Android ${m(/Android (\d+)/)}` : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "necunoscut";
  const device = /iPad|Tablet/.test(ua) ? "tabletă" : /Mobi|iPhone|Android/.test(ua) ? "telefon" : "calculator";
  return { browser, os, device };
}

/** Rezumatul într-un rând: «Date montaj: ContorNr 123 → 124 (+2)» sau, fără modificări, doar eticheta scurtă. */
export function rowSummaryText(action: string, summary: string | null): string {
  const s = actionShort(action);
  return summary ? `${s}: ${summary}` : s;
}

/** Link spre obiectul afectat (null = nu există pagină sau a fost șters). */
export function objectHref(module: string, objectId: string | null, action: string): string | null {
  if (!objectId || /delete|remove|clear|reset/.test(action)) return null;
  if (module === "installer") return null;
  if (module === "antennas") return `/date-antene`;
  if (module === "reports") return `/rapoarte`;
  if (module === "users") return `/utilizatori`;
  if (module === "lorawan") return `/module`;
  return null;
}

/* ───────── filtrele paginii (în adresă și în API) ───────── */
export type AuditFilterState = {
  /** id utilizator (24 hex) */ user: string;
  module: string; action: string; severity: "" | Severity; status: "" | "ok" | "fail";
  /** AAAA-LL-ZZ (ziua în ora Moldovei) */ from: string; to: string;
  /** text liber: utilizator, e-mail, obiect, IP, pagină, rezumat */ q: string;
  /** doar rândurile cu modificări pe câmpuri */ changes: boolean;
};
export const EMPTY_AUDIT_FILTERS: AuditFilterState = { user: "", module: "", action: "", severity: "", status: "", from: "", to: "", q: "", changes: false };

export function sanitizeAuditFilters(raw: Record<string, unknown>): AuditFilterState {
  const str = (v: unknown, max = 80) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : "");
  const sev = str(raw.severity, 6);
  const st = str(raw.status, 4);
  return {
    user: /^[0-9a-f]{24}$/i.test(str(raw.user, 30)) ? str(raw.user, 30) : "",
    module: (AUDIT_MODULES as readonly string[]).includes(str(raw.module)) ? str(raw.module) : "",
    action: /^[a-z_.]{1,60}$/.test(str(raw.action, 60)) ? str(raw.action, 60) : "",
    severity: sev === "info" || sev === "warn" || sev === "crit" ? sev : "",
    status: st === "ok" || st === "fail" ? st : "",
    from: day(raw.from), to: day(raw.to), q: str(raw.q), changes: raw.changes === "1" || raw.changes === true,
  };
}
export const countAuditFilters = (f: AuditFilterState): number => (f.user ? 1 : 0) + (f.module ? 1 : 0) + (f.action ? 1 : 0) + (f.severity ? 1 : 0) + (f.status ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.q ? 1 : 0) + (f.changes ? 1 : 0);
export function auditFiltersToParams(f: AuditFilterState): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["user", "module", "action", "severity", "status", "from", "to", "q"] as const) if (f[k]) p.set(k, f[k]);
  if (f.changes) p.set("changes", "1");
  return p;
}

/** Cât se aduce o dată (prima bucată mică = apare repede) și cât se numără cel mult. */
export const AUDIT_FIRST_CHUNK = 200;
export const AUDIT_NEXT_CHUNK = 500;
export const AUDIT_COUNT_CAP = 50_000;
/** Plafonul exportului CSV (rânduri). */
export const AUDIT_EXPORT_CAP = 200_000;
