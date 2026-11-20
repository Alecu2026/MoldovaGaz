import { createHash } from "node:crypto";
import { FLAG, type UplinkSummary } from "./uplink-shared";

/**
 * Un eveniment de uplink (format ChirpStack + decoder Jooby) → document pentru MongoDB.
 * Se păstrează payload-ul ORIGINAL întreg (`payload`), iar câmpurile de sus + `s` sunt doar derivate, pentru listă și interogări.
 * Formatul variază de la un mesaj la altul (rxInfo cu 1 sau mai multe gateway-uri, `object` lipsă, tipuri diferite de `decoded`), așa că tot ce se
 * extrage e defensiv: ce lipsește rămâne gol, nu strică mesajul.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export type ParsedUplink = {
  _id: string;
  receivedAt: Date;
  ts: Date;
  devEUI: string;
  deviceName: string;
  applicationName: string;
  s: UplinkSummary;
  payload: Obj;
};

/** Valoarea principală: prima intrare cu `values[]` (ia canalul 0, ultima citire) sau, altfel, un `value` numeric direct. */
function mainValue(decoded: Obj[]): number | null {
  for (const e of decoded) {
    if (Array.isArray(e.values)) {
      const vals = e.values.filter(isObj);
      const pick = (list: Obj[]) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const v = num(list[i].value ?? list[i].v);
          if (v != null) return v;
        }
        return null;
      };
      const v = pick(vals.filter((x) => num(x.channel) === 0)) ?? pick(vals);
      if (v != null) return v;
    }
  }
  for (const e of decoded) {
    const v = num(e.value);
    if (v != null) return v;
  }
  return null;
}

export function parseUplink(body: unknown, receivedAt: Date): ParsedUplink | { error: string } {
  if (!isObj(body)) return { error: "nu este un obiect JSON" };
  const devEUI = str(body.devEUI).toLowerCase();
  const deviceName = str(body.deviceName);
  if (!devEUI && !deviceName) return { error: "lipsesc devEUI și deviceName" };

  const rx = Array.isArray(body.rxInfo) ? body.rxInfo.filter(isObj) : [];
  let best: Obj | null = null;
  let bestRssi = -Infinity;
  for (const g of rx) {
    const r = num(g.rssi) ?? -Infinity;
    if (!best || r > bestRssi) {
      best = g;
      bestRssi = r;
    }
  }

  const obj = isObj(body.object) ? body.object : null;
  const decoded = obj && Array.isArray(obj.decoded) ? obj.decoded.filter(isObj) : [];

  const rxTimes = rx.map((g) => time(g.time)).filter((t): t is number => t != null);
  const ts = rxTimes.length ? Math.min(...rxTimes) : time(obj?.decodeTime) ?? receivedAt.getTime();

  let fl = body.adr === true ? FLAG.ADR : 0;
  const types: string[] = [];
  for (const e of decoded) {
    const t = str(e.ieType) || (num(e.cmd) != null ? `cmd ${num(e.cmd)}` : "");
    if (t && !types.includes(t)) types.push(t);
    if (isObj(e.status)) {
      fl |= FLAG.STATUS;
      if (e.status.batteryTooLowVoltage === true) fl |= FLAG.BATT;
      if (e.status.buttonPressed === true) fl |= FLAG.BTN;
      if (e.status.magnet === true) fl |= FLAG.MAG;
      if (e.status.offline === true) fl |= FLAG.OFFLINE;
    }
  }

  const tx = isObj(body.txInfo) ? body.txInfo : {};
  const fCnt = num(body.fCnt) ?? -1;
  const freqHz = num(tx.frequency);
  const s: UplinkSummary = {
    t: ts,
    d: deviceName,
    e: devEUI,
    a: str(body.applicationName) || str(body.applicationID),
    g: best ? str(best.name) || str(best.gatewayID) || null : null,
    gn: rx.length,
    r: best ? num(best.rssi) : null,
    n: best ? num(best.loRaSNR ?? best.snr) : null,
    f: freqHz == null ? 0 : Math.round(freqHz / 1000),
    dr: num(tx.dr) ?? -1,
    fl,
    fc: fCnt,
    pt: num(body.fPort) ?? -1,
    ty: types,
    v: mainValue(decoded),
  };

  // id determinist: aceeași retrimitere a aceluiași uplink nu se mai salvează a doua oară
  const id = createHash("sha1")
    .update([devEUI, deviceName, fCnt, str(body.data), str(rx[0]?.uplinkID) || ts].join("|"))
    .digest("hex")
    .slice(0, 24);

  return { _id: id, receivedAt, ts: new Date(ts), devEUI, deviceName, applicationName: s.a, s, payload: body };
}
