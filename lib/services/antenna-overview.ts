import "server-only";
import { gasLink, type AntennaRecord, type OverviewRow } from "../antennas";
import { gatewayDetail, gatewaySummary, type GwDetail } from "./gateways";
import { antennaDaily, getAntenna, listAntennas } from "./antennas";

/**
 * Pagina «Antene: date și hartă»: o linie pe antenă, cu tot ce știm despre ea — datele din SCADA (client, SIM, IP, instalator, locație),
 * activitatea și eficiența din mesajele primite prin integrare (contoare auzite, semnal) și legătura cu contoarele noastre de gaz.
 * Doar citire din ce avem deja în baza noastră; nu atinge SCADA.
 */
export type Overview = { rows: OverviewRow[]; now: number };

export async function antennaOverview(): Promise<Overview> {
  const [list, sum] = await Promise.all([listAntennas(), gatewaySummary().catch(() => null)]);
  const by = new Map((sum?.rows ?? []).map((r) => [r.id.toLowerCase(), r]));
  const rows = list.rows.map((a): OverviewRow => {
    const s = by.get(a.id);
    const o = { devices: s?.devices ?? 0, primary: s?.primary ?? 0, exclusive: s?.exclusive ?? 0, rssi: s?.rssi ?? null, snr: s?.snr ?? null };
    return { ...a, ...o, link: gasLink({ devices: o.devices, gas: a.gas ?? null, gasAt: a.gasAt ?? null }, list.now) };
  });
  return { rows, now: list.now };
}

export type AntennaMore = { record: AntennaRecord | null; detail: GwDetail | null; days: { d: number; n: number }[] };
/** Detaliile unei antene: fișa ei (atribute), contoarele auzite și mesajele pe zile. */
export async function antennaMore(id: string): Promise<AntennaMore> {
  const [record, detail, days] = await Promise.all([getAntenna(id), gatewayDetail(id).catch(() => null), antennaDaily(id, 60)]);
  return { record, detail, days };
}
