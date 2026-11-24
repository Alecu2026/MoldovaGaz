import fs from "node:fs";
import path from "node:path";
import type { Db } from "mongodb";
import { antennaIdOk } from "./antennas";
import { decodeImage, photoDir, processImage } from "./photos";
import { tb, tbLatest } from "./thingsboard";

/**
 * Antenele din SCADA (dispozitivele de tip `gatewayType` / `gatewayType1`), aduse în colecția noastră `antennas` — DOAR CITIRE din SCADA (cu `ANTENNA_TB_URL` / `ANTENNA_TB_USER` / `ANTENNA_TB_PASS`
 * în mediu, antenele se citesc de pe serverul SCADA al antenelor, `gw.scada.md`, cu un cont de citire; vezi scripts/pull-antennas.ts):
 *  1. lista dispozitivelor (2 cereri GET), apoi atributele lor curente într-o cerere pe lot de 100 (POST entitiesQuery/find = căutare, nu scrie nimic): comentarii, client, SIM, IP,
 *     instalator, locație, Instalta / Antena_mobila, lastActivityTime. Fără poze: sunt grele (în medie 4 MB / antenă).
 *  2. pozele (atributul `image`, câte o antenă pe cerere), micșorate și scrise ca fișiere în `<PHOTO_DIR>/antennas/…` — DOAR dacă `ANTENNA_PHOTO_PULL=1` și doar pentru antenele fără poză.
 * Ce a introdus deja un instalator la noi (antenna_data) nu se atinge niciodată.
 */
export const TYPES = ["gatewayType", "gatewayType1"] as const;
type Dev = { id: { id: string }; name: string; type: string; createdTime: number };
type Page = { data: Dev[]; hasNext: boolean };
const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const coord = (la: number | null, lo: number | null): [number, number] | null => (la !== null && lo !== null && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0) ? [la, lo] : null);
const SERVER = ["active", "Comments", "Client", "Gateways_name_A", "lastActivityTime", "NrTel_SIM", "ip_address", "NumeInstalator", "Gateways_latitude", "Gateways_longitude", "latitude", "longitude", "Instalta", "Antena_mobila"];
const NONE_RETRY_MS = 7 * 86_400_000;

export const antennaPhotoFile = (id: string, thumb = false): string => path.join(photoDir(), "antennas", id.slice(0, 2), `${id}${thumb ? "_t" : ""}.jpg`);
const exists = (f: string) => fs.promises.stat(f).then(() => true, () => false);

export type PullResult = { devices: number; upserted: number; photos: number; none: number; errors: number };

export async function pullAntennas(db: Db, opts: { photos?: boolean; log?: (m: string) => void; shouldStop?: () => boolean } = {}): Promise<PullResult> {
  const log = opts.log ?? (() => {});
  const devs: Dev[] = [];
  for (const type of TYPES) for (let p = 0; p < 50; p++) {
    const r = await tb<Page>(`/api/tenant/devices?type=${type}&pageSize=100&page=${p}`);
    devs.push(...r.data);
    if (!r.hasNext) break;
  }
  log(`antene: ${devs.length} dispozitive în SCADA (${TYPES.join(", ")})`);
  const coll = db.collection<{ _id: string }>("antennas");
  const result: PullResult = { devices: devs.length, upserted: 0, photos: 0, none: 0, errors: 0 };
  for (let i = 0; i < devs.length; i += 100) {
    const chunk = devs.slice(i, i + 100);
    const ents = await tbLatest(chunk.map((d) => d.id.id), { ts: ["CounterGasModules"], server: SERVER, client: [] });
    const byId = new Map(ents.map((e) => [e.entityId.id, e.latest]));
    const ops = [];
    for (const d of chunk) {
      const id = d.name.trim().toLowerCase();
      if (!antennaIdOk(id)) continue;
      const a = byId.get(d.id.id)?.SERVER_ATTRIBUTE ?? {};
      const v = (k: string): string => { const x = a[k]?.value; return x === undefined || x === null ? "" : String(x).trim(); };
      const geo = coord(num(a.Gateways_latitude?.value), num(a.Gateways_longitude?.value)) ?? coord(num(a.latitude?.value), num(a.longitude?.value));
      const lat = num(a.lastActivityTime?.value);
      // CounterGasModules = de câte ori a fost antena cea mai bună receptoare pentru un modul de GAZ (lanțul «Gateways_Lorawan» din SCADA); ts = ultima dată când a crescut
      const gmv = byId.get(d.id.id)?.TIME_SERIES?.CounterGasModules;
      const gm = num(gmv?.value);
      ops.push({ updateOne: { filter: { _id: id }, update: { $set: {
        dev: d.id.id, type: d.type, nm: v("Gateways_name_A"), cm: v("Comments"), cl: v("Client"), sim: v("NrTel_SIM"), ip: v("ip_address"), inst: v("NumeInstalator"),
        la: geo ? geo[0] : null, lo: geo ? geo[1] : null, instd: v("Instalta") === "true", mob: v("Antena_mobila") === "true", lat: lat !== null && lat > 1e11 ? Math.round(lat) : null, gm: gm !== null ? Math.round(gm) : null, gmAt: gm !== null && gm > 0 && gmv?.ts ? gmv.ts : null, upd: new Date(),
      } }, upsert: true } });
    }
    if (ops.length) { await coll.bulkWrite(ops as never); result.upserted += ops.length; }
  }
  log(`antene: ${result.upserted} actualizate în colecția antennas`);

  if (opts.photos) {
    const st = db.collection<{ _id: string; st: string; at: Date }>("antenna_photos");
    const done = new Map((await st.find({}).toArray()).map((d) => [d._id, d]));
    const minFree = (Number(process.env.PHOTO_MIN_FREE_GB) || 3) * 1e9;
    for (const d of devs) {
      if (opts.shouldStop?.()) break;
      const id = d.name.trim().toLowerCase();
      if (!antennaIdOk(id) || (await exists(antennaPhotoFile(id)))) continue;
      const prev = done.get(id);
      if (prev?.st === "none" && Date.now() - prev.at.getTime() < NONE_RETRY_MS) continue;
      try {
        const fsst = await fs.promises.statfs(photoDir()).catch(() => null);
        if (fsst && fsst.bavail * fsst.bsize < minFree) { log("antene: spațiu pe disc prea mic, mă opresc"); break; }
        const r = await tb<{ key: string; value: unknown }[]>(`/api/plugins/telemetry/DEVICE/${d.id.id}/values/attributes?keys=image`, { timeoutMs: 180_000, retries: 2 });
        const img = decodeImage((Array.isArray(r) ? r.find((x) => x.key === "image") : undefined)?.value);
        if (!img) { await st.updateOne({ _id: id }, { $set: { st: "none", at: new Date() } }, { upsert: true }); result.none++; continue; }
        const p = await processImage(img);
        for (const [thumb, data] of [[false, p.full], [true, p.thumb]] as const) {
          const f = antennaPhotoFile(id, thumb);
          await fs.promises.mkdir(path.dirname(f), { recursive: true });
          const tmp = `${f}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, data);
          await fs.promises.rename(tmp, f);
        }
        await st.updateOne({ _id: id }, { $set: { st: "ok", at: new Date() } }, { upsert: true });
        result.photos++;
        await new Promise((res) => setTimeout(res, Number(process.env.PHOTO_PAUSE_MS ?? 150) || 0));
      } catch (e) {
        result.errors++;
        log(`antene: poza ${id} a eșuat: ${(e as Error).message}`);
      }
    }
    log(`antene: poze noi ${result.photos}, fără poză în SCADA ${result.none}, erori ${result.errors}`);
  }
  return result;
}
