import { FLAG } from "./meter-shared";
import type { MeterStore } from "./meter-store";

const HEAD = ["ultima_citire", "contor", "devEUI", "filiala", "oras", "profil", "aplicatie", "concentrator", "rssi", "snr", "frecventa_mhz", "fcnt", "port", "tip_mesaj", "volume_m3", "baterie_pct", "consum_zilnic_l", "consum_lunar_l", "raportat_offline_de_contor", "baterie_slaba", "inactiv", "buton", "magnet", "cu_facturare"];

const esc = (s: string) => (/[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Contoarele filtrate → CSV (separator „;” și BOM, ca să se deschidă corect în Excel cu setări românești). Ora e ISO, în UTC. Fără date personale ale consumatorilor. */
export function metersToCsv(st: MeterStore, idx: Int32Array): string {
  const lines: string[] = [HEAD.join(";")];
  for (let k = 0; k < idx.length; k++) {
    const r = st.view(idx[k]);
    lines.push(
      [
        r.ts > 0 ? new Date(r.ts).toISOString() : "", r.name, r.eui, r.branch ?? "", r.city ?? "", r.profile ?? "", r.app, r.gw ?? "", r.rssi ?? "", r.snr ?? "",
        r.freqKhz ? (r.freqKhz / 1000).toFixed(1) : "", r.fc >= 0 ? r.fc : "", r.pt >= 0 ? r.pt : "", r.types.join(", "), r.val ?? "", r.bat ?? "", r.dc ?? "", r.mc ?? "",
        r.fl & FLAG.OFFLINE ? 1 : 0, r.fl & FLAG.BATT ? 1 : 0, r.fl & FLAG.INACTIVE ? 1 : 0, r.fl & FLAG.BTN ? 1 : 0, r.fl & FLAG.MAG ? 1 : 0, r.fl & FLAG.BILLED ? 1 : 0,
      ].map((v) => esc(String(v))).join(";"),
    );
  }
  return "﻿" + lines.join("\r\n");
}
