import { ACTION_LABEL, PAGES, type Access, type Action } from "./access";
import type { AuditChange } from "./audit-meta";

/**
 * Compară starea de dinainte cu cea de după și întoarce DOAR câmpurile schimbate, cu valorile gata de citit (da/nu, liste cu virgulă, numere).
 * Fără importuri de server: se testează în `npm run check`. Câmpurile secrete (parole, chei, tokenuri) nu trec niciodată pe aici: la ele jurnalul spune doar «schimbată».
 */
export type DiffSpec = { key: string; label: string; fmt?: (v: unknown) => string | null };

/** O valoare, ca text scurt pentru jurnal (null = gol). */
export function fmtAuditValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "Da" : "Nu";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Array.isArray(v)) return v.length ? v.map((x) => fmtAuditValue(x) ?? "—").join(", ") : null;
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v).trim();
  return s ? s : null;
}

export function diffFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>, spec: DiffSpec[]): AuditChange[] {
  const out: AuditChange[] = [];
  for (const sp of spec) {
    if (!(sp.key in after)) continue; // câmpul nu a fost trimis la editare
    const f = sp.fmt ?? fmtAuditValue;
    const a = f(before?.[sp.key]), b = f(after[sp.key]);
    if (a !== b) out.push({ field: sp.key, label: sp.label, old: a, new: b });
  }
  return out;
}

export const INSTALLER_SPEC: DiffSpec[] = [
  { key: "ContorNr", label: "Contor nr." }, { key: "Instalation_Litres", label: "Instalation_Litres" }, { key: "latitude", label: "Latitudine" }, { key: "longitude", label: "Longitudine" },
  { key: "Aragaz", label: "Aragaz" }, { key: "Cazan", label: "Cazan" }, { key: "Incalzire", label: "Încălzire" }, { key: "ModuleWriteInitial", label: "ModuleWriteInitial" },
  { key: "locationModule", label: "Localitate" }, { key: "Comments", label: "Comentarii" },
  { key: "QR_Code", label: "Cod QR" }, { key: "QR_format", label: "Format QR" },
];
export const ANTENNA_SPEC: DiffSpec[] = [
  { key: "NumeInstalator", label: "Nume instalator" }, { key: "latitude", label: "Latitudine" }, { key: "longitude", label: "Longitudine" },
  { key: "Instalta", label: "Instalată" }, { key: "Antena_mobila", label: "Antenă mobilă" }, { key: "NrTel_SIM", label: "Nr. tel. SIM" }, { key: "ip_address", label: "Adresă IP" },
  { key: "Comments", label: "Comentarii" }, { key: "Client", label: "Client" },
];
/** formularul antenei trimite Gateways_latitude / Gateways_longitude; în înregistrare câmpurile se numesc latitude / longitude */
export const antennaBefore = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, Gateways_latitude: r.latitude, Gateways_longitude: r.longitude });
export const ANTENNA_SPEC_BODY: DiffSpec[] = ANTENNA_SPEC.map((s) => (s.key === "latitude" ? { ...s, key: "Gateways_latitude" } : s.key === "longitude" ? { ...s, key: "Gateways_longitude" } : s));

/** Drepturile ca text pe pagină: «Rapoarte: vizualizare, editare». */
function permsText(a: Access): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of PAGES) { const acts = a.perms[p.key]; if (acts?.length) out.set(p.label, acts.map((x: Action) => ACTION_LABEL[x].toLowerCase()).join(", ")); }
  return out;
}
/** Ce s-a schimbat la drepturile unui cont: o linie pe pagină (veche → nouă), zona și «Toate filialele». `labelOf` dă numele unei filiale după cod. */
export function diffAccess(before: Access | null, after: Access, labelOf: (fil: string) => string = (f) => f): AuditChange[] {
  const out: AuditChange[] = [];
  const b = before ? permsText(before) : new Map<string, string>(), n = permsText(after);
  for (const label of [...new Set([...b.keys(), ...n.keys()])]) {
    const x = b.get(label) ?? null, y = n.get(label) ?? null;
    if (x !== y) out.push({ field: `perms.${label}`, label: `Pagină: ${label}`, old: x, new: y });
  }
  if ((before?.allZones ?? false) !== after.allZones) out.push({ field: "allZones", label: "Toate filialele", old: fmtAuditValue(before?.allZones ?? false), new: fmtAuditValue(after.allZones) });
  const zone = (a: Access | null) => (a ? [...a.branches.map((f) => `${labelOf(f)} (toată)`), ...a.cities.map((c) => { const [f, ...r] = c.split("|"); return `${labelOf(f)}: ${r.join("|")}`; })].sort() : []);
  const zb = zone(before), za = zone(after);
  if (zb.join("|") !== za.join("|")) {
    const rem = zb.filter((x) => !za.includes(x)), add = za.filter((x) => !zb.includes(x));
    out.push({ field: "zone", label: "Zonă (filiale / orașe)", old: rem.length ? `scoase: ${rem.slice(0, 20).join("; ")}${rem.length > 20 ? ` +${rem.length - 20}` : ""}` : null, new: add.length ? `adăugate: ${add.slice(0, 20).join("; ")}${add.length > 20 ? ` +${add.length - 20}` : ""}` : null });
  }
  return out;
}

/** Rezumatul unei liste de modificări într-un rând: «Contor nr. 12 → 13; Comentarii (+2)». */
export function summarizeChanges(changes: AuditChange[], max = 2): string | null {
  if (!changes.length) return null;
  const cut = (v: string | null) => (v === null ? "∅" : v.length > 24 ? `${v.slice(0, 24)}…` : v);
  const head = changes.slice(0, max).map((c) => `${c.label} ${cut(c.old)} → ${cut(c.new)}`).join("; ");
  return changes.length > max ? `${head} (+${changes.length - max})` : head;
}
