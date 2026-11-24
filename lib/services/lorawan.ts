import "server-only";
import { decryptJson, encryptJson, secretOk } from "../lorawan/crypto";
import { ChirpStack } from "../lorawan/chirpstack";
import { DOWNLINKS, cleanModule, isType, type DownlinkKey, type ModuleInput } from "../lorawan/config";
import { abpExtraFrame, emergencyBackup, otaaDown, registerPrimary, type Ctx, type Outcome, type Servers } from "../lorawan/flows";
import { publishMqtt } from "../lorawan/mqtt";
import { getDb } from "../mongo";

/**
 * Module LoRaWAN: evidența lor la noi (`lw_modules`; cheile doar criptate, vezi lib/lorawan/crypto.ts) și rularea proceselor din SCADA (lib/lorawan/flows.ts) asupra serverelor ChirpStack.
 * Scrierile în ChirpStack sunt oprite până când pe server există LORAWAN_WRITE=1 (altfel merge doar simularea: doar citiri). Nu se scrie nimic în SCADA.
 */
export const MODULES = "lw_modules";
export const LOG = "lw_log";
export type RunKind = "register" | "emergency" | "otaa_down" | "extraframe";
export const RUN_LABEL: Record<RunKind, string> = { register: "Înregistrare + activare", emergency: "Reînregistrare de urgență (rezervă)", otaa_down: "Comandă către modul", extraframe: "ABP extraframe (v4)" };

type Secrets = { appKey?: string; devAddr?: string; devAaddr?: string; appSKey?: string; nwkSKey?: string };
type Doc = {
  _id: string; name: string; type: ModuleInput["type"]; activation: ModuleInput["activation"]; enc: string | null;
  status: "nou" | "înregistrat" | "eșuat" | "conflict"; applicationID: string | null; emergency: string | null; emcCount: number; step: string | null;
  last: { at: Date; kind: RunKind; dry: boolean; ok: boolean; by: string; steps: string[]; error: string | null } | null;
  createdAt: Date; by: string; updatedAt: Date;
};
export type ModuleView = Omit<Doc, "enc" | "last" | "createdAt" | "updatedAt"> & { id: string; hasKeys: Record<string, boolean>; createdAt: number; updatedAt: number; last: (Omit<NonNullable<Doc["last"]>, "at"> & { at: number }) | null };

const env = (k: string) => (process.env[k] ?? "").trim();
export type LwConfig = { primary: boolean; backup: boolean; v4: boolean; mqttV4: boolean; nodered: number; secret: boolean; write: boolean };
export const config = (): LwConfig => ({ primary: !!(env("CS_URL") && env("CS_USER") && env("CS_PASS")), backup: !!(env("CS_BACKUP_URL") && env("CS_USER") && env("CS_PASS")), v4: !!(env("CS4_URL") && env("CS4_TOKEN")), mqttV4: !!env("CS4_MQTT_URL"), nodered: env("NODERED_URLS").split(",").filter((x) => /^https?:\/\//.test(x.trim())).length, secret: secretOk(process.env.LORAWAN_KEY_SECRET), write: env("LORAWAN_WRITE") === "1" });

function servers(): Servers {
  const creds = { email: env("CS_USER"), password: env("CS_PASS") };
  return {
    primary: env("CS_URL") && creds.email && creds.password ? new ChirpStack(env("CS_URL"), 3, { creds }) : null,
    backup: env("CS_BACKUP_URL") && creds.email && creds.password ? new ChirpStack(env("CS_BACKUP_URL"), 3, { creds }) : null,
    v4: env("CS4_URL") && env("CS4_TOKEN") ? new ChirpStack(env("CS4_URL"), 4, { token: env("CS4_TOKEN") }) : null,
    mqttV4: env("CS4_MQTT_URL") || undefined,
    nodered: env("NODERED_URLS").split(",").map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)),
    noderedCreds: creds.email ? creds : undefined,
  };
}

const view = (d: Doc): ModuleView => ({
  id: d._id, name: d.name, type: d.type, activation: d.activation, status: d.status, applicationID: d.applicationID, emergency: d.emergency, emcCount: d.emcCount, step: d.step, by: d.by, _id: d._id,
  hasKeys: { appKey: d.enc !== null, abp: d.enc !== null }, createdAt: d.createdAt.getTime(), updatedAt: d.updatedAt.getTime(),
  last: d.last ? { ...d.last, at: d.last.at.getTime() } : null,
});

export async function listModules(): Promise<ModuleView[]> {
  return (await (await getDb()).collection<Doc>(MODULES).find({}).sort({ updatedAt: -1 }).limit(2000).toArray()).map(view);
}

export async function addModules(raws: unknown[], by: string): Promise<{ added: string[]; errors: { row: number; error: string }[] }> {
  const cfg = config();
  if (!cfg.secret) return { added: [], errors: [{ row: 0, error: "LORAWAN_KEY_SECRET lipsește din mediu (cel puțin 24 de caractere): fără el cheile nu se pot păstra criptat." }] };
  const secret = process.env.LORAWAN_KEY_SECRET as string;
  const coll = (await getDb()).collection<Doc>(MODULES);
  const added: string[] = [], errors: { row: number; error: string }[] = [];
  for (let i = 0; i < Math.min(raws.length, 500); i++) {
    const c = cleanModule(raws[i]);
    if ("error" in c) { errors.push({ row: i + 1, error: c.error }); continue; }
    const m = c.mod;
    if (await coll.findOne({ _id: m.devEUI }, { projection: { _id: 1 } })) { errors.push({ row: i + 1, error: `devEUI ${m.devEUI} există deja în evidență.` }); continue; }
    const sec: Secrets = { appKey: m.appKey, devAddr: m.devAddr, devAaddr: m.devAaddr, appSKey: m.appSKey, nwkSKey: m.nwkSKey };
    const now = new Date();
    await coll.insertOne({ _id: m.devEUI, name: m.name, type: m.type, activation: m.activation, enc: encryptJson(sec, secret), status: "nou", applicationID: null, emergency: null, emcCount: 0, step: null, last: null, createdAt: now, by, updatedAt: now });
    added.push(m.devEUI);
  }
  return { added, errors };
}

export async function removeModule(id: string): Promise<boolean> {
  return ((await (await getDb()).collection<Doc>(MODULES).deleteOne({ _id: id.toLowerCase() })).deletedCount ?? 0) > 0;
}

export type RunOpts = { dry: boolean; confirmDelete?: boolean; cmd?: string };
export async function runModule(id: string, kind: RunKind, o: RunOpts, by: string, deps?: { servers?: Servers; publish?: Ctx["publish"]; forward?: Ctx["forward"] }): Promise<{ outcome: Outcome; steps: string[] } | { error: string; status: number }> {
  const cfg = config();
  if (!o.dry && !cfg.write) return { error: "Scrierile în ChirpStack sunt oprite: pe server lipsește LORAWAN_WRITE=1. Poți rula doar simularea.", status: 403 };
  if (!cfg.secret) return { error: "LORAWAN_KEY_SECRET lipsește din mediu.", status: 500 };
  const coll = (await getDb()).collection<Doc>(MODULES);
  const d = await coll.findOne({ _id: id.toLowerCase() });
  if (!d) return { error: "Modulul nu există.", status: 404 };
  if (!isType(d.type)) return { error: "Tip necunoscut.", status: 400 };
  let sec: Secrets = {};
  try { if (d.enc) sec = decryptJson<Secrets>(d.enc, process.env.LORAWAN_KEY_SECRET as string); } catch { return { error: "Cheile nu pot fi decriptate (LORAWAN_KEY_SECRET s-a schimbat?).", status: 500 }; }
  const m: ModuleInput = { name: d.name, type: d.type, activation: d.activation, devEUI: d._id, ...sec };
  const steps: string[] = [];
  const ctx: Ctx = {
    s: deps?.servers ?? servers(), dry: o.dry, allowDelete: o.confirmDelete === true, log: (x) => steps.push(x),
    publish: deps?.publish ?? ((url, topic, payload) => publishMqtt(url, topic, payload)),
    forward: deps?.forward ?? (async (url, body) => { try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); return r.ok; } catch { return false; } }),
  };
  let out: Outcome;
  if (kind === "register") out = await registerPrimary(m, ctx);
  else if (kind === "emergency") out = await emergencyBackup(m, d.emcCount, ctx);
  else if (kind === "extraframe") out = await abpExtraFrame(m, ctx);
  else {
    const cmd = (o.cmd && o.cmd in DOWNLINKS ? o.cmd : "to_abp") as DownlinkKey;
    out = await otaaDown(m, cmd, ctx);
  }
  if (!o.dry) {
    const status: Doc["status"] = out.result === "conflict" ? "conflict" : kind === "register" ? (out.ok ? "înregistrat" : "eșuat") : d.status;
    await coll.updateOne({ _id: d._id }, { $set: {
      status, applicationID: out.applicationID ?? d.applicationID, emergency: out.emergency ?? d.emergency, emcCount: out.emcCount ?? d.emcCount, step: out.step ?? d.step, updatedAt: new Date(),
      last: { at: new Date(), kind, dry: false, ok: out.ok, by, steps, error: out.error ?? null },
    } });
  } else await coll.updateOne({ _id: d._id }, { $set: { last: { at: new Date(), kind, dry: true, ok: out.ok, by, steps, error: out.error ?? null }, updatedAt: new Date() } });
  await (await getDb()).collection(LOG).insertOne({ at: new Date(), id: d._id, name: d.name, kind, dry: o.dry, ok: out.ok, result: out.result, by, error: out.error ?? null });
  return { outcome: out, steps };
}
