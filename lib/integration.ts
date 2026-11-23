import { FLAG } from "./meter-shared";
import { CLIENT_KEYS, SERVER_KEYS, buildDocs, hashBody, type Bill, type Dev, type MeterDoc } from "./meter-sync";
import type { TbLatest } from "./thingsboard";
import { looksLikeUplink, normTs, uplinkToMsg } from "./integration-uplink";

export { normTs };

/**
 * INTEGRARE: mesaje de contor primite DIRECT de la rețeaua LoRaWAN / antene (nu din SCADA), în aceeași formă ca documentul unui contor din aplicație:
 *   { id?, tb: { name, type, customerId, createdTime, label }, bill?, attrs?, tel: { <cheie>: { t: <moment ms>, v: <valoare> } } }
 * `s` (rezumatul) NU se ia din mesaj: se DERIVĂ ca la sincronizarea din SCADA (aceeași funcție `buildDocs`), deci stările, filiala, căutarea etc. ies identic.
 * Fără rețea, fără baze de date: funcții pure, testate în `npm run check`.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BATCH = 1000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TEL = 100, MAX_ATTRS = 200, MAX_BILL = 60, MAX_STR = 512;
const KEY = /^[A-Za-z0-9_:. -]{1,64}$/;
/** chei care nu se păstrează niciodată (chei de rețea LoRaWAN, secrete) */
const SENSITIVE = /key|secret|token|pass|credential|nwk|appskey/i;
const FUTURE_MS = 36 * 3_600_000;

export type IntegrationMsg = {
  id: string | null;
  name: string | null;
  eui: string | null;
  tb: { type?: string; customerId?: string | null; createdTime?: number; label?: string | null };
  bill: Bill | null;
  attrs: Record<string, string | number | boolean>;
  tel: Record<string, { t: number; v: string }>;
  /** cheia de nume „model_serie_an” (fără prefixul S / SN): potrivire de rezervă a contorului pentru uplink-uri (vezi integration-uplink.ts) */
  nameKey?: string | null;
  /** contorul de impulsuri al uplink-ului (1 impuls = 10 L); volumul total se calculează la aplicare din atributele contorului */
  pulse?: { t: number; v: number } | null;
  /** contorul de cadre LoRaWAN al uplink-ului: un mesaj cu fCnt mai mic decât cel deja primit e vechi și nu are voie să dea valorile înapoi */
  fcnt?: number | null;
};
export type Parsed = { ok: true; msg: IntegrationMsg } | { ok: false; error: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function scalar(v: unknown): string | null {
  if (typeof v === "string") return v.length <= MAX_STR ? v : null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return String(v);
  if (isObj(v) || Array.isArray(v)) {
    const s = JSON.stringify(v);
    return s.length <= MAX_STR ? s : null;
  }
  return null;
}

export function parseMessage(x: unknown, now: number = Date.now()): Parsed {
  if (looksLikeUplink(x)) return uplinkToMsg(x, now); // uplink brut de la serverul LoRaWAN (ChirpStack / Jooby)
  if (!isObj(x)) return { ok: false, error: "mesajul trebuie să fie un obiect JSON" };
  const tbIn = isObj(x.tb) ? x.tb : {};
  const idRaw = typeof x.id === "string" ? x.id.trim() : typeof tbIn.id === "string" ? tbIn.id.trim() : "";
  if (idRaw && !UUID.test(idRaw)) return { ok: false, error: "id invalid (se așteaptă UUID-ul dispozitivului)" };
  const nameRaw = typeof tbIn.name === "string" ? tbIn.name : typeof x.name === "string" ? x.name : "";
  const name = nameRaw.trim().slice(0, 128) || null;
  const attrsIn = isObj(x.attrs) ? x.attrs : {};
  const euiRaw = typeof attrsIn.devEUI === "string" ? attrsIn.devEUI : typeof x.eui === "string" ? x.eui : isObj(x.s) && typeof x.s.e === "string" ? x.s.e : "";
  const eui = /^[0-9a-f]{16}$/i.test(euiRaw.trim()) ? euiRaw.trim().toLowerCase() : null;
  if (!idRaw && !name && !eui) return { ok: false, error: "lipsește identificarea contorului (id, tb.name sau attrs.devEUI)" };

  // momentul mesajului (pentru valorile date simplu, fără {t, v})
  const msgTs = normTs(x.ts ?? x.t ?? x.updatedAt ?? x.time) ?? now;

  const tel: IntegrationMsg["tel"] = {};
  const telIn = isObj(x.tel) ? x.tel : {};
  const telKeys = Object.keys(telIn);
  if (telKeys.length > MAX_TEL) return { ok: false, error: `prea multe chei în tel (maximum ${MAX_TEL})` };
  for (const k of telKeys) {
    if (!KEY.test(k) || SENSITIVE.test(k)) continue;
    const e = telIn[k];
    let t: number | null = msgTs, raw: unknown = e;
    // „intrare cu moment” = obiect cu `t` (sau `ts`) ȘI `v` (sau `value`); orice alt obiect (ex. battery: { remCapacity: 80 }) e o valoare, cu momentul mesajului
    if (isObj(e) && ("t" in e || "ts" in e) && ("v" in e || "value" in e)) {
      t = normTs(e.t ?? e.ts);
      raw = e.v ?? e.value;
    }
    if (t === null) return { ok: false, error: `tel.${k}: moment invalid (se așteaptă milisecunde sau text ISO)` };
    if (t > now + FUTURE_MS) return { ok: false, error: `tel.${k}: momentul e în viitor` };
    const v = scalar(raw);
    if (v === null) return { ok: false, error: `tel.${k}: valoare invalidă (text, număr, boolean sau obiect scurt)` };
    tel[k] = { t, v };
  }

  const attrs: IntegrationMsg["attrs"] = {};
  const aKeys = Object.keys(attrsIn);
  if (aKeys.length > MAX_ATTRS) return { ok: false, error: `prea multe atribute (maximum ${MAX_ATTRS})` };
  for (const k of aKeys) {
    if (!KEY.test(k) || SENSITIVE.test(k)) continue;
    const v = attrsIn[k];
    if (typeof v === "string") { if (v.length <= MAX_STR) attrs[k] = v; }
    else if (typeof v === "number") { if (Number.isFinite(v)) attrs[k] = v; }
    else if (typeof v === "boolean") attrs[k] = v;
  }

  let bill: Bill | null = null;
  if (isObj(x.bill)) {
    bill = {};
    const bk = Object.keys(x.bill);
    if (bk.length > MAX_BILL) return { ok: false, error: `bill: prea multe câmpuri (maximum ${MAX_BILL})` };
    for (const k of bk) {
      if (!KEY.test(k)) continue;
      const v = x.bill[k];
      bill[k] = typeof v === "string" ? v.trim().slice(0, MAX_STR) : typeof v === "number" && Number.isFinite(v) ? v : null;
    }
  }

  const createdTime = normTs(tbIn.createdTime);
  const msg: IntegrationMsg = {
    id: idRaw ? idRaw.toLowerCase() : null,
    name,
    eui,
    tb: {
      ...(typeof tbIn.type === "string" ? { type: tbIn.type.trim().slice(0, 128) } : {}),
      ...(typeof tbIn.customerId === "string" && UUID.test(tbIn.customerId) ? { customerId: tbIn.customerId.toLowerCase() } : tbIn.customerId === null ? { customerId: null } : {}),
      ...(createdTime !== null ? { createdTime } : {}),
      ...(typeof tbIn.label === "string" ? { label: tbIn.label.trim().slice(0, 128) || null } : tbIn.label === null ? { label: null } : {}),
    },
    bill,
    attrs,
    tel,
    nameKey: null,
    pulse: null,
    fcnt: null,
  };
  if (aKeysEmpty(msg) && Object.keys(tel).length === 0 && !bill) return { ok: false, error: "mesaj fără date (tel, attrs sau bill)" };
  return { ok: true, msg };
}
const aKeysEmpty = (m: IntegrationMsg) => Object.keys(m.attrs).length === 0;

/** Îmbină două mesaje ale aceluiași contor, `b` fiind cel mai nou: pentru fiecare cheie de telemetrie rămâne valoarea cu momentul cel mai mare. */
/** „Mai vechi” după contorul de cadre LoRaWAN: aceeași sesiune (diferența sub 30000, ca să nu confundăm o repornire a contorului de cadre). */
export const isStaleFcnt = (incoming: number | null | undefined, known: number | null | undefined): boolean =>
  incoming !== null && incoming !== undefined && known !== null && known !== undefined && Number.isFinite(known) && incoming < known && known - incoming < 30_000;

/**
 * Un uplink e „vechi” (reluare / retransmitere) doar dacă: are fCnt mai mic decât cel cunoscut (aceeași sesiune), NU aduce mai multe impulsuri decât cele cunoscute
 * (altfel contorul e în viață, chiar dacă și-a repornit contorul de cadre) și valoarea cunoscută nu e mai veche de 48 h (după două zile fără cadre mai noi, un fCnt mai mic
 * înseamnă o repornire a contorului, nu o reluare — nu blocăm un contor).
 */
export function isStaleUplink(inc: { fcnt: number | null | undefined; pulse?: number | null; t: number }, known: { fcnt: number; t: number; pulse: number | null }): boolean {
  if (!isStaleFcnt(inc.fcnt, known.fcnt)) return false;
  if (inc.t - known.t > 48 * 3_600_000) return false;
  if (inc.pulse !== null && inc.pulse !== undefined && known.pulse !== null && inc.pulse > known.pulse) return false;
  return true;
}

export function mergeMsgs(a: IntegrationMsg, b: IntegrationMsg): IntegrationMsg {
  if (isStaleFcnt(b.fcnt, a.fcnt) && !(b.pulse && a.pulse && b.pulse.v > a.pulse.v)) return a; // b a sosit după a, dar e un cadru mai vechi
  const tel = { ...a.tel };
  for (const [k, e] of Object.entries(b.tel)) if (!tel[k] || e.t >= tel[k].t) tel[k] = e;
  return { id: b.id ?? a.id, name: b.name ?? a.name, eui: b.eui ?? a.eui, nameKey: b.nameKey ?? a.nameKey ?? null, tb: { ...a.tb, ...b.tb }, bill: b.bill ?? a.bill, attrs: { ...a.attrs, ...b.attrs }, tel, pulse: b.pulse ?? a.pulse ?? null, fcnt: b.fcnt ?? a.fcnt ?? null };
}

export type MeterDocIng = MeterDoc & { ing?: number };
export type Derived = { doc: MeterDocIng; status: "created" | "updated" | "unchanged" };

/**
 * Documentul contorului după mesaj: îmbină mesajul peste documentul existent (telemetria cu momentul cel mai nou câștigă, atributele se suprascriu,
 * facturarea rămâne dacă mesajul nu o aduce) și DERIVĂ rezumatul cu aceeași funcție ca la sincronizarea din SCADA.
 * „unchanged” = același conținut ca înainte (nu se scrie nimic).
 */
export function mergeDerive(existing: MeterDocIng | null, id: string, msg: IntegrationMsg, now: Date): Derived {
  // uplink mai vechi decât ce s-a primit deja (retransmitere / reluare): nu are voie să dea volumul sau starea înapoi
  if (existing && existing.tel.fCnt) {
    const exF = Number(existing.tel.fCnt.v), exP = existing.attrs.c_couterPulse !== undefined && existing.attrs.c_couterPulse !== null ? Number(existing.attrs.c_couterPulse) : NaN;
    if (Number.isFinite(exF) && isStaleUplink({ fcnt: msg.fcnt, pulse: msg.pulse?.v ?? null, t: msg.tel.fCnt?.t ?? now.getTime() }, { fcnt: exF, t: existing.tel.fCnt.t, pulse: Number.isFinite(exP) ? exP : null })) return { doc: existing, status: "unchanged" };
  }
  const tel: Record<string, { t: number; v: string }> = { ...(existing?.tel ?? {}) };
  for (const [k, e] of Object.entries(msg.tel)) if (!tel[k] || e.t >= tel[k].t) tel[k] = e;
  const attrs: Record<string, string | number | boolean | null> = { ...(existing?.attrs ?? {}), ...msg.attrs };

  // volumul total din contorul de impulsuri: litri = Instalation_Litres + (impulsuri − ModuleInitialValue) × 10 (1 impuls = 10 L). Verificat pe date reale.
  // Contorul de volum doar crește: o valoare mai mică decât cea cunoscută se ignoră.
  if (msg.pulse) {
    const inst = Number(String(attrs.Instalation_Litres ?? "").trim());
    const init = Number(String(attrs.ModuleInitialValue ?? "0").trim());
    if (String(attrs.Instalation_Litres ?? "").trim() !== "" && Number.isFinite(inst) && Number.isFinite(init) && msg.pulse.v >= init) {
      const litres = inst + (msg.pulse.v - init) * 10;
      const known = Number(tel.Volume_m3_Total?.v);
      if (!(Number.isFinite(known) && known * 1000 > litres + 0.5)) {
        tel.Volume_m3_Total = { t: msg.pulse.t, v: (litres / 1000).toFixed(3) };
        attrs.c_couterPulse = String(msg.pulse.v);
        attrs.c_Volume_m3 = (msg.pulse.v / 100).toFixed(2);
      }
    }
  }

  const customerId = msg.tb.customerId !== undefined ? msg.tb.customerId : existing?.tb.customerId ?? null;
  const dev: Dev = {
    id: { id },
    name: msg.name ?? existing?.tb.name ?? "",
    type: msg.tb.type ?? existing?.tb.type ?? "",
    label: msg.tb.label !== undefined ? msg.tb.label : existing?.tb.label ?? null,
    createdTime: msg.tb.createdTime ?? existing?.tb.createdTime ?? 0,
    customerId: customerId ? { id: customerId } : null,
  };

  const latest: TbLatest = { TIME_SERIES: {}, SERVER_ATTRIBUTE: {}, CLIENT_ATTRIBUTE: {} };
  for (const [k, e] of Object.entries(tel)) latest.TIME_SERIES[k] = { ts: e.t, value: e.v };
  for (const k of SERVER_KEYS) {
    const a = k.replace(/:$/, "");
    if (a in attrs && attrs[a] !== null) latest.SERVER_ATTRIBUTE[k] = { ts: 0, value: String(attrs[a]) };
  }
  for (const k of CLIENT_KEYS) {
    const a = `c_${k}`;
    if (a in attrs && attrs[a] !== null) latest.CLIENT_ATTRIBUTE[k] = { ts: 0, value: String(attrs[a]) };
  }
  const bill = msg.bill ?? existing?.bill ?? null;
  const built = buildDocs([dev], [], new Map([[id, latest]]), now, { billById: new Map([[id, bill as Bill | null]]) as Map<string, Bill> }).docs[0];

  // „Serie repetată” se stabilește din lista tuturor dispozitivelor (la sincronizare), nu din mesaj: se păstrează ce era
  if (existing && (existing.s.fl & FLAG.DUP) !== 0) {
    built.s.fl |= FLAG.DUP;
    if (existing.tb.dupWith) built.tb.dupWith = existing.tb.dupWith;
  }
  // atributele pe care mesajul nu le conține rămân (buildDocs păstrează doar cheile cunoscute)
  const body = { s: built.s, tb: built.tb, bill: built.bill, attrs: { ...(existing?.attrs ?? {}), ...built.attrs }, tel: built.tel };
  const doc: MeterDocIng = { _id: id, updatedAt: now, h: hashBody(body), ...body };
  const status = !existing ? "created" : existing.h === doc.h ? "unchanged" : "updated";
  return { doc, status };
}

/** Când sincronizarea din SCADA NU are voie să suprascrie un contor: datele lui venite prin integrare sunt la fel de noi sau mai noi decât cele din SCADA. */
export function ingestIsNewer(existing: { ing?: number; s?: { t?: number } } | undefined, scadaReadingTs: number): boolean {
  return !!existing && typeof existing.ing === "number" && (existing.s?.t ?? 0) >= scadaReadingTs;
}
