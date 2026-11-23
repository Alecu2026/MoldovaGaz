import { METER_NAME } from "./meter-shared";
import type { IntegrationMsg, Parsed } from "./integration";

/**
 * Adaptor pentru uplink-urile BRUTE ale serverului LoRaWAN (ChirpStack, decodor Jooby), așa cum le trimite rețeaua:
 *   { applicationName, deviceName, devEUI, rxInfo: [{ name, rssi, loRaSNR, … }], txInfo: { frequency }, fCnt, fPort,
 *     object: { decodeTime, decoded: [ { ieType: "CurrentDataMul" | "LastEventSeq" | "DeviceStatus" | "HoursDataMul" | …, … } ] } }
 * Le transformă în același `IntegrationMsg` ca mesajul în forma documentului de contor, deci intră pe același drum (îmbinare, derivare, istoric). Fără rețea, fără baze de date.
 *
 * Reguli (verificate pe datele reale):
 *  - contorul: `devEUI` (nume `deviceName` fără prefixul S / SN, deci se normalizează la `model_serie_an`);
 *  - momentul mesajului: `object.decodeTime` (ca `decodeTime` din SCADA), nu `rxInfo.time` (ceasul antenei poate fi greșit);
 *  - impulsuri (contorul de volum): ultimul cadru CurrentDataMul / CurrentData; volumul total se calculează la aplicare, din atributele contorului
 *    (volum total [L] = Instalation_Litres + (impulsuri − ModuleInitialValue) × 10), vezi mergeDerive;
 *  - stare: cadrul LastEventSeq (batteryTooLowVoltage, buttonPressed, magnet, offline); baterie și temperatură: cadrul DeviceStatus;
 *  - `ieType` = tipul ULTIMULUI cadru, ca în SCADA.
 */
/** Moment în ms: număr în ms (sau în secunde) ori text ISO. null = invalid. */
export function normTs(x: unknown): number | null {
  let t: number;
  if (typeof x === "number") t = x;
  else if (typeof x === "string" && x.trim() !== "") t = /^d+(.d+)?$/.test(x.trim()) ? Number(x) : Date.parse(x);
  else return null;
  if (!Number.isFinite(t)) return null;
  if (t >= 1e9 && t < 1e11) t *= 1000; // secunde
  return t >= 1e11 && t <= 4e12 ? Math.round(t) : null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export const looksLikeUplink = (x: unknown): x is Record<string, unknown> =>
  isObj(x) && typeof x.devEUI === "string" && (isObj(x.object) || Array.isArray(x.rxInfo)) && x.tel === undefined && x.tb === undefined;

/** „2154_00073058_2022”, „S2154_00073058_2022” și „SN2154_00073058_2022” → „2154_00073058_2022”; alt nume ⇒ null. */
export function nameKey(name: string | null | undefined): string | null {
  const m = name ? METER_NAME.exec(name.trim()) : null;
  return m ? `${m[1]}_${m[2]}_${m[3]}` : null;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);

export function uplinkToMsg(x: Record<string, unknown>, now: number = Date.now()): Parsed {
  const euiRaw = String(x.devEUI ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(euiRaw)) return { ok: false, error: "uplink: devEUI invalid (se așteaptă 16 cifre hexazecimale)" };
  const obj = isObj(x.object) ? x.object : {};
  const t = normTs(obj.decodeTime) ?? now;
  if (t > now + 36 * 3_600_000) return { ok: false, error: "uplink: decodeTime în viitor" };
  const rx = Array.isArray(x.rxInfo) && isObj(x.rxInfo[0]) ? (x.rxInfo[0] as Record<string, unknown>) : null;
  const tx = isObj(x.txInfo) ? x.txInfo : null;
  const frames = Array.isArray(obj.decoded) ? obj.decoded.filter(isObj) : [];

  const tel: IntegrationMsg["tel"] = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
    if (s.length <= 512) tel[k] = { t, v: s };
  };
  if (rx) {
    put("rssi", num(rx.rssi));
    put("loRaSNR", num(rx.loRaSNR));
    if (typeof rx.name === "string" && rx.name) put("Concentrator", rx.name);
  }
  const fr = num(tx?.frequency);
  if (fr !== null) put("Frequency", Math.round((fr / 1e6) * 10) / 10);
  const fCnt = num(x.fCnt);
  put("fCnt", fCnt);
  put("fPort", num(x.fPort));
  if (typeof x.applicationName === "string") put("applicationName", x.applicationName);
  if (typeof obj.decodeTime === "string") put("decodeTime", obj.decodeTime);

  let pulse: number | null = null;
  for (const f of frames) {
    if (f.ieType === "CurrentDataMul" && Array.isArray(f.values)) {
      const v = f.values.find((e) => isObj(e) && (e.channel === 0 || e.channel === undefined));
      const n = isObj(v) ? num(v.value) : null;
      if (n !== null && n >= 0) pulse = n;
    } else if (f.ieType === "CurrentData") {
      const n = num(f.value);
      if (n !== null && n >= 0) pulse = n;
    } else if (f.ieType === "LastEventSeq" && isObj(f.status)) {
      for (const k of ["batteryTooLowVoltage", "buttonPressed", "magnet", "offline"]) if (typeof f.status[k] === "boolean") put(k, f.status[k]);
    } else if (f.ieType === "DeviceStatus") {
      if (isObj(f.battery)) put("battery", f.battery);
      put("temp", num(f.temp));
    }
  }
  const last = frames.length ? frames[frames.length - 1].ieType : null;
  if (typeof last === "string") put("ieType", last);

  const dev = typeof x.deviceName === "string" ? x.deviceName.trim() : "";
  const attrs: IntegrationMsg["attrs"] = { devEUI: euiRaw, active: true, lastActivityTime: t };
  if (fCnt !== null) attrs.c_fCnt = String(fCnt);
  if (typeof x.applicationName === "string") attrs.c_applicationName = x.applicationName;

  return {
    ok: true,
    msg: { id: null, name: null, eui: euiRaw, nameKey: nameKey(dev), tb: {}, bill: null, attrs, tel, pulse: pulse !== null ? { t, v: pulse } : null, fcnt: fCnt },
  };
}
