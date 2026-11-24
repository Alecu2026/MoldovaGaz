import "server-only";
import fs from "node:fs";
import path from "node:path";
import { antennaIdOk, cleanAntennaPatch, type AntennaList, type AntennaPatch, type AntennaRecord, type AntennaRow } from "../antennas";
import { getDb } from "../mongo";
import { decodeImage, photoDir, processImage } from "../photos";
import { GATEWAYS, GW_DAY } from "./gateways";
import { PREFS_COLLECTION } from "./installer";

/**
 * Antenele pentru ecranul instalatorului de antene (vezi lib/antennas.ts). Lista = antenele din SCADA (copia din `antennas`, adusă de scripts/pull-antennas.ts: nume, client,
 * SIM, IP, instalator, locație, comentarii) + antenele care ne-au trimis mesaje prin integrare (`integration_gateways`: nume din rețea, ultima activitate, număr de mesaje, poziție),
 * unite după identificator (EUI). Ce introduce instalatorul se salvează în `antenna_data` și are prioritate; poza, ca fișier în `<PHOTO_DIR>/antennas/…`. Nimic nu se scrie în SCADA.
 */
export const ANTENNAS = "antennas";
export const ANT_DATA = "antenna_data";
const MAX_PHOTO_BYTES = 25_000_000;
const ONLINE_MS = 3_600_000, SLOW_MS = 24 * 3_600_000;

type Scada = { _id: string; dev?: string; nm?: string; cm?: string; cl?: string; sim?: string; ip?: string; inst?: string; la?: number | null; lo?: number | null; instd?: boolean; mob?: boolean; lat?: number | null };
type Gw = { _id: string; name?: string; la?: number | null; lo?: number | null; n?: number; last?: number };
type Edit = AntennaPatch & { _id: string; updatedAt?: Date; by?: string; photoAt?: Date };

export const antennaPhotoPath = (id: string, thumb = false): string => {
  if (!antennaIdOk(id)) throw new Error("id de antenă invalid");
  return path.join(photoDir(), "antennas", id.slice(0, 2), `${id}${thumb ? "_t" : ""}.jpg`);
};
const has = (f: string) => fs.promises.stat(f).then(() => true, () => false);

const g = globalThis as unknown as { __antList?: { at: number; p: Promise<{ rows: AntennaRow[]; edit: Map<string, Edit>; scada: Map<string, Scada> }> } };
const TTL_MS = 10_000;

async function build() {
  const db = await getDb();
  const [sc, gw, ed] = await Promise.all([
    db.collection<Scada>(ANTENNAS).find({}).toArray(),
    db.collection<Gw>(GATEWAYS).find({}, { projection: { name: 1, la: 1, lo: 1, n: 1, last: 1 } }).toArray(),
    db.collection<Edit>(ANT_DATA).find({}).toArray(),
  ]);
  const scada = new Map(sc.map((d) => [d._id, d])), gws = new Map(gw.map((d) => [d._id.toLowerCase(), d])), edit = new Map(ed.map((d) => [d._id, d]));
  const ids = [...new Set([...scada.keys(), ...gws.keys()].filter(antennaIdOk))];
  const now = Date.now();
  const rows = await Promise.all(ids.map(async (id): Promise<AntennaRow> => {
    const s = scada.get(id), w = gws.get(id), e = edit.get(id);
    const last = Math.max(w?.last ?? 0, s?.lat ?? 0) || null;
    const age = last ? now - last : Infinity;
    const state: AntennaRow["state"] = age <= ONLINE_MS ? "on" : age <= SLOW_MS ? "slow" : "off";
    const pick = <T,>(...v: (T | null | undefined)[]): T | null => { for (const x of v) if (x !== undefined && x !== null && (typeof x !== "string" || x !== "")) return x; return null; };
    return {
      id, name: w?.name ?? s?.nm ?? "", active: state !== "off", state, last, msgs: w?.n ?? 0,
      Comments: pick(e?.Comments, s?.cm) ?? "", Client: pick(e?.Client, s?.cl) ?? "", NrTel_SIM: pick(e?.NrTel_SIM, s?.sim) ?? "", ip_address: pick(e?.ip_address, s?.ip) ?? "", NumeInstalator: pick(e?.NumeInstalator, s?.inst) ?? "",
      latitude: pick(e?.Gateways_latitude, s?.la, w?.la), longitude: pick(e?.Gateways_longitude, s?.lo, w?.lo),
      Instalta: e?.Instalta ?? s?.instd ?? false, Antena_mobila: e?.Antena_mobila ?? s?.mob ?? false,
      hasPhoto: await has(antennaPhotoPath(id)),
    };
  }));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { rows, edit, scada };
}
const cached = () => {
  if (!g.__antList || Date.now() - g.__antList.at > TTL_MS) {
    const p = build();
    g.__antList = { at: Date.now(), p };
    p.catch(() => { if (g.__antList?.p === p) g.__antList = undefined; });
  }
  return g.__antList.p;
};
const forget = () => { g.__antList = undefined; };

export async function listAntennas(): Promise<AntennaList> {
  return { rows: (await cached()).rows, now: Date.now() };
}

export async function getAntenna(id: string): Promise<AntennaRecord | null> {
  if (!antennaIdOk(id)) return null;
  const { rows, edit } = await cached();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  const e = edit.get(id);
  return { ...r, updatedAt: e?.updatedAt ? e.updatedAt.getTime() : null, by: e?.by ?? null, photoAt: e?.photoAt ? e.photoAt.getTime() : null };
}

export async function saveAntenna(id: string, body: unknown, by: string): Promise<{ record: AntennaRecord } | { error: string; status: number }> {
  if (!antennaIdOk(id)) return { error: "Id invalid.", status: 400 };
  const c = cleanAntennaPatch(body);
  if ("error" in c) return { error: c.error, status: 400 };
  if (!(await getAntenna(id))) return { error: "Antena nu există.", status: 404 };
  await (await getDb()).collection<Edit>(ANT_DATA).updateOne({ _id: id }, { $set: { ...c.patch, updatedAt: new Date(), by } }, { upsert: true });
  forget();
  const record = await getAntenna(id);
  return record ? { record } : { error: "Antena nu există.", status: 404 };
}

/** Poza făcută de instalator: se decodează, se micșorează (fără metadate / locație) și se scrie ca fișier (poză + miniatură). */
export async function saveAntennaPhoto(id: string, bytes: Buffer, by: string): Promise<{ record: AntennaRecord } | { error: string; status: number }> {
  if (!antennaIdOk(id)) return { error: "Id invalid.", status: 400 };
  if (bytes.length < 1000 || bytes.length > MAX_PHOTO_BYTES) return { error: bytes.length < 1000 ? "Fișierul nu e o poză." : "Poza e prea mare (cel mult 25 MB).", status: 413 };
  const img = decodeImage("data:image/jpeg;base64," + bytes.toString("base64"));
  if (!img) return { error: "Fișierul nu e o poză (JPEG / PNG / WebP).", status: 415 };
  if (!(await getAntenna(id))) return { error: "Antena nu există.", status: 404 };
  let p;
  try { p = await processImage(img); } catch { return { error: "Poza nu poate fi citită.", status: 415 }; }
  for (const [thumb, data] of [[false, p.full], [true, p.thumb]] as const) {
    const f = antennaPhotoPath(id, thumb);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, f);
  }
  await (await getDb()).collection<Edit>(ANT_DATA).updateOne({ _id: id }, { $set: { photoAt: new Date(), updatedAt: new Date(), by } }, { upsert: true });
  forget();
  const record = await getAntenna(id);
  return record ? { record } : { error: "Antena nu există.", status: 404 };
}

/** Mesajele primite prin antenă, pe zile (ultimele `days` zile, ora UTC a zilei), din agregatele integrării. */
export async function antennaDaily(id: string, days = 30): Promise<{ d: number; n: number }[]> {
  if (!antennaIdOk(id)) return [];
  const from = Date.now() - days * 86_400_000;
  const docs = await (await getDb()).collection<{ g: string; d: number; n: number }>(GW_DAY).find({ g: { $in: [id, id.toUpperCase()] }, d: { $gte: from } }, { projection: { d: 1, n: 1 } }).sort({ d: 1 }).toArray();
  return docs.map((x) => ({ d: x.d, n: x.n }));
}

/** „FilterDevices” din „Select Device”: filtrul de nume al listei, păstrat per utilizator (separat de cel al contoarelor). */
export async function getAntennaFilter(userId: string): Promise<string> {
  const d = await (await getDb()).collection<{ _id: string; filter?: string }>(PREFS_COLLECTION).findOne({ _id: `ant:${userId}` });
  return d?.filter ?? "";
}
export async function setAntennaFilter(userId: string, filter: string): Promise<void> {
  await (await getDb()).collection<{ _id: string; filter?: string; at?: Date }>(PREFS_COLLECTION).updateOne({ _id: `ant:${userId}` }, { $set: { filter: filter.slice(0, 80), at: new Date() } }, { upsert: true });
}
