import type { ChirpStack, Creds, Res } from "./chirpstack";
import { DOWNLINKS, backupTarget, chirpName, primaryTarget, v4Target, type DownlinkKey, type ModuleInput, type Target } from "./config";

/**
 * Procesele din SCADA (lanțul «LoraWan_register_and_activation»), portate pas cu pas. Fiecare funcție primește serverele și «ieșirile» (MQTT, Node-RED) prin `Ctx`,
 * deci se poate testa cu servere false. În modul `dry` (simulare) se fac doar citiri (GET); scrierile sunt doar descrise în jurnal.
 *   registerPrimary — înregistrare + activare la serverul principal (OTAA: dispozitiv + cheie; ABP: activare); conflict (409) ⇒ șterge și recreează, doar cu confirmare;
 *   emergencyBackup — reînregistrare «de urgență» la serverul de rezervă (ABP), cu verificarea adresei (devAddr = «00» + ultimele 6 cifre din devEUI) și numărătoarea reactivărilor;
 *   otaaDown        — comandă către modul prin coada de downlink (ex. trecere pe ABP), doar dacă coada e goală sau are peste 2 elemente;
 *   abpExtraFrame   — al treilea server (v4): creează / activează ABP și trimite prin MQTT comanda de repornire.
 */
export type Servers = { primary: ChirpStack | null; backup: ChirpStack | null; v4: ChirpStack | null; mqttPrimary?: string; mqttV4?: string; nodered: string[]; noderedCreds?: Creds };
export type Ctx = {
  s: Servers; dry: boolean; allowDelete: boolean; log: (m: string) => void;
  publish: (url: string, topic: string, payload: unknown) => Promise<void>;
  forward: (url: string, body: unknown) => Promise<boolean>;
};
export type Outcome = { ok: boolean; result: "registered" | "dry" | "failed" | "conflict"; error?: string; applicationID?: string; emergency?: string; emcCount?: number; step?: string; needsConfirm?: "delete" };

const fail = (c: Ctx, error: string, extra: Partial<Outcome> = {}): Outcome => { c.log(`✗ ${error}`); return { ok: false, result: "failed", error, ...extra }; };
const dryOut = (extra: Partial<Outcome> = {}): Outcome => ({ ok: true, result: "dry", ...extra });
const errText = (r: Res): string => { const b = r.body as { error?: string; message?: string } | null; return `HTTP ${r.status}${b && typeof b === "object" && (b.message || b.error) ? ` — ${b.message ?? b.error}` : ""}`; };
const missingKeys = (m: ModuleInput): string | null => (m.activation === "OTAA" ? (m.appKey ? null : "lipsește APPKEY") : !m.devAddr ? "lipsește devADDR" : !m.appSKey ? "lipsește APPSKEY" : !m.nwkSKey ? "lipsește NWKSKEY" : null);

const deviceBody3 = (m: ModuleInput, t: Target) => { const n = chirpName(m.name, m.type); return { applicationID: t.applicationID, description: n, devEUI: m.devEUI, deviceProfileID: t.deviceProfileID, name: n, referenceAltitude: 0, skipFCntCheck: true, tags: {}, variables: {} }; };
const activationBody = (devAddr: string, m: ModuleInput) => ({ aFCntDown: 0, appSKey: m.appSKey, devAddr, devEUI: m.devEUI, fCntUp: 0, fNwkSIntKey: m.nwkSKey, nFCntDown: 0, nwkSEncKey: m.nwkSKey, sNwkSIntKey: m.nwkSKey });
const otaaKeys = (m: ModuleInput) => ({ appKey: "", devEUI: m.devEUI, genAppKey: "", nwkKey: m.appKey });

/** OTAA: cheia există? dacă nu, se scrie. ABP: activarea există? dacă nu, se face. */
async function ensureSecrets(m: ModuleInput, cs: ChirpStack, c: Ctx): Promise<Outcome | null> {
  if (m.activation === "OTAA") {
    const k = await cs.getKeys(m.devEUI);
    if (k.ok) { c.log("✓ cheia OTAA există deja"); return null; }
    c.log(`cheia OTAA lipsește (${errText(k)})`);
    if (c.dry) { c.log("(simulare) ar scrie cheia OTAA"); return dryOut(); }
    const p = await cs.createKeys(m.devEUI, otaaKeys(m));
    return p.ok ? (c.log("✓ cheia OTAA scrisă"), null) : fail(c, `nu am putut scrie cheia OTAA (${errText(p)})`);
  }
  const a = await cs.getActivation(m.devEUI);
  if (a.ok) { c.log("✓ activarea ABP există deja"); return null; }
  c.log(`activarea ABP lipsește (${errText(a)})`);
  if (c.dry) { c.log("(simulare) ar face activarea ABP"); return dryOut(); }
  const p = await cs.activate(m.devEUI, activationBody(m.devAddr ?? "", m));
  return p.ok ? (c.log("✓ activare ABP făcută"), null) : fail(c, `activarea ABP a eșuat (${errText(p)})`);
}

/* ───────── 1. înregistrare + activare (serverul principal) ───────── */
export async function registerPrimary(m: ModuleInput, c: Ctx): Promise<Outcome> {
  const cs = c.s.primary;
  if (!cs) return fail(c, "serverul principal ChirpStack nu e configurat (CS_URL, CS_USER, CS_PASS)");
  const t = primaryTarget(m.type, m.name, m.activation);
  if (!t) return fail(c, `tipul «${m.type}» nu are aplicație la serverul principal`);
  const miss = missingKeys(m);
  if (miss) return fail(c, miss);
  c.log(`țintă: aplicația ${t.applicationID}, profilul ${t.deviceProfileID.slice(0, 8)}…, nume «${chirpName(m.name, m.type)}»`);
  const g = await cs.getDevice(m.devEUI);
  let appId = t.applicationID;
  if (g.ok) {
    appId = String((g.body as { device?: { applicationID?: string | number } } | null)?.device?.applicationID ?? appId);
    c.log(`✓ dispozitivul există în ChirpStack (aplicația ${appId})`);
  } else if (g.status === 404) {
    c.log("dispozitivul nu există în ChirpStack");
    if (m.activation === "ABP") return fail(c, "ABP: dispozitivul nu există în ChirpStack și (ca în SCADA) nu se creează automat aici");
    if (c.dry) { c.log("(simulare) ar crea dispozitivul, apoi ar scrie cheia"); return dryOut({ applicationID: appId }); }
    let cr = await cs.createDevice(deviceBody3(m, t));
    if (cr.status === 409) {
      c.log(`conflict la creare (${errText(cr)}): există un obiect cu aceeași serie / același nume`);
      if (!c.allowDelete) return { ok: false, result: "conflict", needsConfirm: "delete", error: "Conflict: există deja în ChirpStack. Confirmă ștergerea și recrearea.", applicationID: appId };
      const d = await cs.deleteDevice(m.devEUI);
      if (!d.ok) return fail(c, `nu pot șterge dispozitivul vechi (${errText(d)})`);
      c.log("✓ dispozitivul vechi a fost șters");
      cr = await cs.createDevice(deviceBody3(m, t));
    }
    if (!cr.ok) return fail(c, `crearea a eșuat (${errText(cr)})`);
    c.log("✓ dispozitiv creat");
  } else return fail(c, `nu pot citi ChirpStack (${errText(g)})`);
  const out = await ensureSecrets(m, cs, c);
  if (out) return { ...out, applicationID: appId };
  return { ok: true, result: c.dry ? "dry" : "registered", applicationID: appId };
}

/* ───────── 2. reînregistrare «de urgență» (serverul de rezervă, ABP) ───────── */
export const expectedDevAddr = (eui: string): string => "00" + eui.slice(-6);
export async function emergencyBackup(m: ModuleInput, emcCount: number, c: Ctx): Promise<Outcome> {
  const cs = c.s.backup;
  if (!cs) return fail(c, "serverul de rezervă nu e configurat (CS_BACKUP_URL)");
  const t = backupTarget(m.type);
  if (!t) return fail(c, `tipul «${m.type}» nu are aplicație la serverul de rezervă`);
  if (!m.appSKey || !m.nwkSKey || !m.devAaddr) return fail(c, "pentru urgență trebuie APPSKEY, NWKSKEY și devAADDR");
  // ca în SCADA: datele modulului se trimit și către cele două Node-RED, indiferent de rezultat
  if (!c.dry) for (const u of c.s.nodered) { const ok = await c.forward(u, { ...(c.s.noderedCreds ?? {}), metadata: { applicationID: t.applicationID, deviceProfileID: t.deviceProfileID, originatorName: m.name, originatorType: m.type, ss_activation: m.activation, ss_devEUI: m.devEUI, ss_devADDR_ABP: m.devAddr, ss_dev_APPKEY_OTAA: m.appKey, ss_dev_APPSKEY_ABP: m.appSKey, ss_dev_NWKSKEY_ABP: m.nwkSKey } }); c.log(ok ? "✓ trimis la Node-RED" : "Node-RED nu a răspuns"); }
  const g = await cs.getDevice(m.devEUI);
  if (!g.ok) {
    if (g.status !== 404) return fail(c, `nu pot citi serverul de rezervă (${errText(g)})`);
    c.log("dispozitivul nu există pe serverul de rezervă");
    if (c.dry) { c.log("(simulare) ar crea dispozitivul și ar face activarea ABP"); return dryOut({ applicationID: t.applicationID }); }
    const cr = await cs.createDevice(deviceBody3(m, t));
    if (!cr.ok) return fail(c, `crearea pe serverul de rezervă a eșuat (${errText(cr)})`);
    c.log("✓ dispozitiv creat pe serverul de rezervă");
  } else c.log("✓ dispozitivul există pe serverul de rezervă");
  const a = await cs.getActivation(m.devEUI);
  let needActivate = !a.ok;
  if (a.ok) {
    const addr = String((a.body as { deviceActivation?: { devAddr?: string } } | null)?.deviceActivation?.devAddr ?? "");
    if (addr !== expectedDevAddr(m.devEUI)) { c.log(`adresa ${addr || "?"} ≠ ${expectedDevAddr(m.devEUI)}: se reactivează`); needActivate = true; }
    else { c.log("✓ activare existentă, adresa corectă"); return { ok: true, result: c.dry ? "dry" : "registered", applicationID: t.applicationID, emergency: "true-activated-key-ok", emcCount }; }
  } else c.log(`activarea lipsește (${errText(a)})`);
  if (needActivate) {
    const aa = m.devAaddr;
    if (!aa.includes("A") || aa.length !== 9) { c.log("devAADDR invalid (trebuie 9 caractere cu «A»)"); return { ok: false, result: "failed", error: "nu se poate activa: devAADDR invalid", applicationID: t.applicationID, emergency: "false-can_not_activate", emcCount }; }
    if (c.dry) { c.log("(simulare) ar face activarea ABP pe serverul de rezervă"); return dryOut({ applicationID: t.applicationID }); }
    const p = await cs.activate(m.devEUI, activationBody(aa.replace("A", ""), m));
    if (!p.ok) { c.log(`✗ activarea a eșuat (${errText(p)})`); return { ok: false, result: "failed", error: `activarea de urgență a eșuat (${errText(p)})`, applicationID: t.applicationID, emergency: "false-can_not_activate", emcCount }; }
    c.log("✓ activare ABP făcută pe serverul de rezervă");
    return { ok: true, result: "registered", applicationID: t.applicationID, emergency: `true-reactivated_${emcCount}`, emcCount: emcCount + 1 };
  }
  return { ok: true, result: "registered", applicationID: t.applicationID, emergency: "true-activated-key-ok", emcCount };
}

/* ───────── 3. comandă către modul (OTAA_DOWN) ───────── */
export async function otaaDown(m: ModuleInput, cmd: DownlinkKey, c: Ctx, armed = true): Promise<Outcome> {
  const cs = c.s.primary;
  if (!cs) return fail(c, "serverul principal ChirpStack nu e configurat");
  if (m.activation !== "OTAA") return fail(c, "comanda e pentru module OTAA");
  const g = await cs.getDevice(m.devEUI);
  if (!g.ok) return fail(c, `dispozitivul nu e în ChirpStack (${errText(g)})`, { step: "not-activated" });
  const appId = String((g.body as { device?: { applicationID?: string | number } } | null)?.device?.applicationID ?? primaryTarget(m.type, m.name, m.activation)?.applicationID ?? "");
  const a = await cs.getActivation(m.devEUI);
  if (!a.ok) return fail(c, `modulul nu e activat (${errText(a)})`, { step: "not-activated", applicationID: appId });
  const q = await cs.getQueue(m.devEUI);
  if (!q.ok) return fail(c, `nu pot citi coada (${errText(q)})`, { applicationID: appId });
  const count = Number((q.body as { totalCount?: number | string } | null)?.totalCount ?? 0) || 0;
  c.log(`coada de comenzi: ${count}`);
  if (!((count === 0 || count > 2) && armed)) { c.log(`✗ nu trimit: coada are ${count} elemente (se trimite doar la 0 sau peste 2)`); return { ok: true, result: c.dry ? "dry" : "registered", step: `total_queue=${count}`, applicationID: appId }; }
  if (c.dry) { c.log(`(simulare) ar șterge coada și ar pune comanda «${DOWNLINKS[cmd].label}»`); return dryOut({ step: "mqtt_sent", applicationID: appId }); }
  if (count > 0) { const d = await cs.deleteQueue(m.devEUI); if (!d.ok) return fail(c, `nu pot goli coada (${errText(d)})`, { applicationID: appId }); c.log("✓ coada veche ștearsă"); }
  const p = await cs.postQueue(m.devEUI, { confirmed: false, data: DOWNLINKS[cmd].data, devEUI: m.devEUI, fCnt: 1, fPort: 1 });
  if (!p.ok) return fail(c, `comanda nu a putut fi pusă în coadă (${errText(p)})`, { applicationID: appId });
  c.log(`✓ comanda «${DOWNLINKS[cmd].label}» pusă în coadă`);
  return { ok: true, result: "registered", step: "mqtt_sent", applicationID: appId };
}

/* ───────── 4. ABP extraframe (al treilea server, ChirpStack v4) ───────── */
export async function abpExtraFrame(m: ModuleInput, c: Ctx): Promise<Outcome> {
  const cs = c.s.v4;
  if (!cs) return fail(c, "serverul v4 nu e configurat (CS4_URL, CS4_TOKEN)");
  const t = v4Target(m.type);
  if (!t) return fail(c, `tipul «${m.type}» nu are aplicație la serverul v4`);
  if (!m.appSKey || !m.nwkSKey || !m.devAaddr) return fail(c, "trebuie APPSKEY, NWKSKEY și devAADDR");
  const aa = m.devAaddr;
  if (!aa.includes("A") || aa.length !== 9) return fail(c, "devAADDR invalid (trebuie 9 caractere cu «A»)");
  const n = chirpName(m.name, m.type);
  const g = await cs.getDevice(m.devEUI);
  if (!g.ok) {
    if (g.status !== 404) return fail(c, `nu pot citi serverul v4 (${errText(g)})`);
    c.log("dispozitivul nu există pe serverul v4");
    if (c.dry) { c.log("(simulare) ar crea dispozitivul, ar activa ABP și ar trimite comanda de repornire"); return dryOut({ applicationID: t.applicationID }); }
    const cr = await cs.createDevice({ applicationId: t.applicationID.trim(), description: n, devEui: m.devEUI, deviceProfileId: t.deviceProfileID, isDisabled: false, joinEui: "0000000000000000", name: n, skipFcntCheck: true, tags: {}, variables: {} });
    if (!cr.ok) return fail(c, `crearea pe serverul v4 a eșuat (${errText(cr)})`);
    c.log("✓ dispozitiv creat pe serverul v4");
  } else c.log("✓ dispozitivul există pe serverul v4");
  const a = await cs.getActivation(m.devEUI);
  if (!a.ok) return fail(c, `activarea nu poate fi citită (${errText(a)})`);
  if (c.dry) { c.log("(simulare) ar activa ABP și ar trimite comanda de repornire"); return dryOut({ applicationID: t.applicationID }); }
  const p = await cs.activate(m.devEUI, { devEui: m.devEUI, devAddr: aa.replace("A", ""), appSKey: m.appSKey, nwkSEncKey: m.nwkSKey, sNwkSIntKey: m.nwkSKey, fNwkSIntKey: m.nwkSKey, fCntUp: 0, nFCntDown: 0, aFCntDown: 0 });
  if (!p.ok) return fail(c, `activarea ABP a eșuat (${errText(p)})`);
  c.log("✓ activare ABP făcută (v4)");
  if (c.s.mqttV4) {
    try { await c.publish(c.s.mqttV4, `application/${t.applicationID.trim()}/device/${m.devEUI}/command/down`, { devEui: m.devEUI, confirmed: true, fPort: 1, data: DOWNLINKS.soft_restart.data }); c.log("✓ comandă de repornire trimisă prin MQTT"); }
    catch (e) { c.log(`comanda MQTT nu a putut fi trimisă (${(e as Error).message})`); }
  } else c.log("MQTT v4 neconfigurat: comanda de repornire nu s-a trimis");
  return { ok: true, result: "registered", applicationID: t.applicationID };
}
