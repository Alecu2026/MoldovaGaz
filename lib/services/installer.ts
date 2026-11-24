import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDb, COLLECTIONS } from "../mongo";
import type { Viewer } from "../access";
import { allowedIds, meterAllowed } from "./meter-dataset";
import { cleanPatch, type InstallerList, type InstallerRecord, type InstallerRow, type Patch } from "../installer";
import { decodeImage, photoDir, photoPath, processImage, validId } from "../photos";

/**
 * Ecranul instalatorului (vezi lib/installer.ts): datele introduse se salvează în `installer_data` (un document per contor), poza instalatorului ca fișier în
 * `<PHOTO_DIR>/installer/…` (separat de pozele extrase din SCADA, ca extragerea să n-o suprascrie). Nimic nu se scrie în SCADA.
 */
export const DATA_COLLECTION = "installer_data";
export const PREFS_COLLECTION = "installer_prefs";
const MAX_PHOTO_BYTES = 25_000_000;

type MeterLite = { _id: string; tb?: { name?: string }; s?: { n?: string; br?: string }; attrs?: Record<string, unknown>; tel?: Record<string, { t: number; v: string } | undefined> };
type DataDoc = Patch & { _id: string; updatedAt?: Date; by?: string; photoAt?: Date };

const n = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const x = Number(String(v).replace(",", ".")); return Number.isFinite(x) ? x : null; };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const installerPhotoPath = (id: string, thumb = false): string => photoPath(id, thumb, path.join(photoDir(), "installer"));
const nameOf = (m: MeterLite) => String(m.tb?.name ?? m.s?.n ?? m._id);

function rowOf(m: MeterLite, d?: DataDoc): InstallerRow {
  const a = m.attrs ?? {}, tel = m.tel ?? {};
  return {
    id: String(m._id), name: nameOf(m), lastActivityTime: n(a.lastActivityTime),
    Volume_m3_Total: n(tel.Volume_m3_Total?.v), Instalation_Litres: d?.Instalation_Litres !== undefined ? d.Instalation_Litres : n(a.Instalation_Litres),
    Volume_Liters: n(tel.Volume_Liters?.v), ModuleInitialValue: n(a.ModuleInitialValue),
  };
}

const PROJ = { _id: 1, "tb.name": 1, "s.n": 1, attrs: 1, "tel.Volume_m3_Total": 1, "tel.Volume_Liters": 1 } as const;
const SORTS: Record<string, string> = { name: "tb.name", active: "attrs.lastActivityTime", ActiveTime: "attrs.lastActivityTime", lastActivityTime: "attrs.lastActivityTime", Instalation_Litres: "attrs.Instalation_Litres", ModuleInitialValue: "attrs.ModuleInitialValue", Volume_m3_Total: "tel.Volume_m3_Total.v", Volume_Liters: "tel.Volume_Liters.v" };

/** Lista „Localitate” (locationModule) a unei filiale: la Orhei exact lista din SCADA, la celelalte valorile folosite la cel puțin 20 de contoare ale filialei (fără „na”). */
const ORHEI = ["Orhei", "Soldanesti", "Rezina", "Telenesti"];
const gOpt = globalThis as unknown as { __instOpt?: { at: number; by: Map<string, string[]> } };
async function localityOptions(branch: string): Promise<string[]> {
  if (/^20/.test(branch)) return ORHEI;
  if (!gOpt.__instOpt || Date.now() - gOpt.__instOpt.at > 600_000) {
    const g = await (await getDb()).collection(COLLECTIONS.meters).aggregate<{ _id: { br: string; v: string }; n: number }>([
      { $match: { "attrs.locationModule": { $nin: [null, "", "na"] } } }, { $group: { _id: { br: "$s.br", v: "$attrs.locationModule" }, n: { $sum: 1 } } }, { $match: { n: { $gte: 20 } } }, { $sort: { n: -1 } },
    ]).toArray();
    const by = new Map<string, string[]>();
    for (const x of g) { const l = by.get(String(x._id.br)) ?? []; l.push(String(x._id.v)); by.set(String(x._id.br), l); }
    gOpt.__instOpt = { at: Date.now(), by };
  }
  return gOpt.__instOpt.by.get(branch) ?? [];
}

/** Lista paginată (căutare după nume, sortare, pagină) — ca „Device admin table”. */
export async function listMeters(v: Viewer, o: { q: string; page: number; size: number; sort: string; dir: 1 | -1 }): Promise<InstallerList> {
  const db = await getDb();
  const meters = db.collection<MeterLite>(COLLECTIONS.meters);
  const q = o.q.trim().slice(0, 80);
  const rx = { $regex: esc(q), $options: "i" };
  const ids = await allowedIds(v); // utilizator limitat: doar contoarele din zona lui
  const base = ids ? { _id: { $in: ids as never[] } } : {};
  const filter = q ? { ...base, $or: [{ "tb.name": rx }, { "attrs.ContorNr": rx }] } : base;
  const key = SORTS[o.sort] ?? "tb.name";
  const [total, docs] = await Promise.all([
    q || ids ? meters.countDocuments(filter) : meters.estimatedDocumentCount(),
    meters.find(filter, { projection: PROJ }).sort({ [key]: o.dir, _id: 1 }).skip(Math.max(0, o.page) * o.size).limit(o.size).toArray(),
  ]);
  const data = new Map((await db.collection<DataDoc>(DATA_COLLECTION).find({ _id: { $in: docs.map((d) => String(d._id)) } }).toArray()).map((d) => [d._id, d]));
  return { total, rows: docs.map((m) => rowOf(m, data.get(String(m._id)))) };
}

export const countMeters = async (v: Viewer): Promise<number> => (await allowedIds(v))?.length ?? (await getDb()).collection(COLLECTIONS.meters).estimatedDocumentCount();

/** Contorul după un nume exact (din codul QR): întoarce id-ul și numele, sau null. */
export async function findByName(name: string, v: Viewer): Promise<{ id: string; name: string } | null> {
  const m = await (await getDb()).collection<MeterLite>(COLLECTIONS.meters).findOne({ "tb.name": name }, { projection: { _id: 1, "tb.name": 1 } });
  if (!m || !(await meterAllowed(v, String(m._id)))) return null; // un contor din afara zonei apare ca „negăsit”
  return { id: String(m._id), name: nameOf(m) };
}

/** Datele unui contor pentru formular: ce a introdus instalatorul, altfel valorile din SCADA. */
export async function getRecord(id: string): Promise<InstallerRecord | null> {
  if (!validId(id)) return null;
  const db = await getDb();
  const m = await db.collection<MeterLite>(COLLECTIONS.meters).findOne({ _id: id } as never, { projection: { _id: 1, "tb.name": 1, "s.n": 1, "s.br": 1, attrs: 1 } });
  if (!m) return null;
  const d = await db.collection<DataDoc>(DATA_COLLECTION).findOne({ _id: id });
  const a = m.attrs ?? {};
  const has = async (f: string) => fs.promises.stat(f).then(() => true, () => false);
  const own = await has(installerPhotoPath(id));
  const sc = !own && (await has(photoPath(id)));
  const b = (k: "Aragaz" | "Cazan" | "Incalzire" | "ModuleWriteInitial") => (d?.[k] !== undefined ? d[k] === true : k !== "ModuleWriteInitial" && (a[k] === true || a[k] === "true"));
  const loc = d?.locationModule !== undefined ? d.locationModule : a.locationModule === undefined || a.locationModule === null || a.locationModule === "na" ? "" : String(a.locationModule);
  const options = await localityOptions(String(m.s?.br ?? ""));
  return {
    id, name: nameOf(m),
    ContorNr: d?.ContorNr ?? (a.ContorNr === undefined || a.ContorNr === null ? "" : String(a.ContorNr)),
    Instalation_Litres: d?.Instalation_Litres !== undefined ? d.Instalation_Litres : n(a.Instalation_Litres),
    latitude: d?.latitude !== undefined ? d.latitude : n(a.latitude), longitude: d?.longitude !== undefined ? d.longitude : n(a.longitude),
    Aragaz: b("Aragaz"), Cazan: b("Cazan"), Incalzire: b("Incalzire"), ModuleWriteInitial: b("ModuleWriteInitial"),
    locationModule: loc, options: loc && !options.includes(loc) ? [...options, loc] : options, Comments: d?.Comments ?? "",
    lastActivityTime: n(a.lastActivityTime), hasPhoto: own || sc, photoSource: own ? "installer" : sc ? "scada" : null,
    updatedAt: d?.updatedAt ? d.updatedAt.getTime() : null, by: d?.by ?? null,
  };
}

/** Salvează câmpurile trimise (doar cele cunoscute). Întoarce înregistrarea actualizată, sau o eroare pentru utilizator. */
export async function saveFields(id: string, body: unknown, by: string): Promise<{ record: InstallerRecord } | { error: string; status: number }> {
  if (!validId(id)) return { error: "Id invalid.", status: 400 };
  const c = cleanPatch(body);
  if ("error" in c) return { error: c.error, status: 400 };
  const db = await getDb();
  if (!(await db.collection(COLLECTIONS.meters).findOne({ _id: id } as never, { projection: { _id: 1 } }))) return { error: "Contorul nu există.", status: 404 };
  await db.collection<DataDoc>(DATA_COLLECTION).updateOne({ _id: id }, { $set: { ...c.patch, updatedAt: new Date(), by } }, { upsert: true });
  const record = await getRecord(id);
  return record ? { record } : { error: "Contorul nu există.", status: 404 };
}

/** Poza făcută de instalator: se decodează, se micșorează (fără metadate / locație) și se scrie ca fișier (poză + miniatură). */
export async function savePhoto(id: string, bytes: Buffer, by: string): Promise<{ record: InstallerRecord } | { error: string; status: number }> {
  if (!validId(id)) return { error: "Id invalid.", status: 400 };
  if (bytes.length < 1000 || bytes.length > MAX_PHOTO_BYTES) return { error: bytes.length < 1000 ? "Fișierul nu e o poză." : "Poza e prea mare (cel mult 25 MB).", status: 413 };
  const img = decodeImage("data:image/jpeg;base64," + bytes.toString("base64"));
  if (!img) return { error: "Fișierul nu e o poză (JPEG / PNG / WebP).", status: 415 };
  const db = await getDb();
  if (!(await db.collection(COLLECTIONS.meters).findOne({ _id: id } as never, { projection: { _id: 1 } }))) return { error: "Contorul nu există.", status: 404 };
  let p;
  try { p = await processImage(img); } catch { return { error: "Poza nu poate fi citită.", status: 415 }; }
  for (const [thumb, data] of [[false, p.full], [true, p.thumb]] as const) {
    const f = installerPhotoPath(id, thumb);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, f);
  }
  await db.collection<DataDoc>(DATA_COLLECTION).updateOne({ _id: id }, { $set: { photoAt: new Date(), updatedAt: new Date(), by } }, { upsert: true });
  const record = await getRecord(id);
  return record ? { record } : { error: "Contorul nu există.", status: 404 };
}

/** „FilterDevices”: ce a scris utilizatorul în „Select Device” (se păstrează între sesiuni, per utilizator). */
export async function getFilter(userId: string): Promise<string> {
  const d = await (await getDb()).collection<{ _id: string; filter?: string }>(PREFS_COLLECTION).findOne({ _id: userId });
  return d?.filter ?? "";
}
export async function setFilter(userId: string, filter: string): Promise<void> {
  await (await getDb()).collection<{ _id: string; filter?: string; at?: Date }>(PREFS_COLLECTION).updateOne({ _id: userId }, { $set: { filter: filter.slice(0, 80), at: new Date() } }, { upsert: true });
}
