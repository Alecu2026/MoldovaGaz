import { FLAG } from "./uplink-shared";
import type { UplinkStore } from "./uplink-store";

const HEAD = ["timp", "dispozitiv", "devEUI", "aplicatie", "gateway", "nr_gateway", "rssi", "snr", "frecventa_mhz", "dr", "adr", "fcnt", "port", "tipuri", "valoare", "baterie_slaba", "offline", "buton", "magnet"];

const esc = (s: string) => (/[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Rândurile filtrate → CSV (separator „;” și BOM, ca să se deschidă corect în Excel cu setări românești). Ora e ISO, în UTC. */
export function uplinksToCsv(st: UplinkStore, idx: Int32Array): string {
  const lines: string[] = [HEAD.join(";")];
  for (let k = 0; k < idx.length; k++) {
    const r = st.view(idx[k]);
    lines.push(
      [
        new Date(r.ts).toISOString(),
        r.dev,
        r.eui,
        r.app,
        r.gw ?? "",
        r.gn,
        r.rssi ?? "",
        r.snr ?? "",
        r.freqKhz ? (r.freqKhz / 1000).toFixed(1) : "",
        r.dr >= 0 ? r.dr : "",
        r.fl & FLAG.ADR ? 1 : 0,
        r.fc >= 0 ? r.fc : "",
        r.pt >= 0 ? r.pt : "",
        r.types.join(", "),
        r.val ?? "",
        r.fl & FLAG.BATT ? 1 : 0,
        r.fl & FLAG.OFFLINE ? 1 : 0,
        r.fl & FLAG.BTN ? 1 : 0,
        r.fl & FLAG.MAG ? 1 : 0,
      ]
        .map((v) => esc(String(v)))
        .join(";"),
    );
  }
  return "﻿" + lines.join("\r\n");
}
