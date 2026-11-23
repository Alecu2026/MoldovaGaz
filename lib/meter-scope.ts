/**
 * CE contoare intră în aplicație: contoarele de gaz Moldovagaz ale celor 10 filiale, așa cum sunt în SCADA (iiot.scada.md).
 * Fiecare filială are un „client” în ThingsBoard (ex. ComratGaz_DashGroup); toate dispozitivele clientului sunt contoarele filialei.
 * Cifrele verificate pe iiot.scada.md: 68.930 de contoare + 5.567 „Defectate_*” (excluse) = 74.497 dispozitive la cei 10 clienți.
 * Dashboard-ul „MoldovaGaz” din SCADA arată 68.941 / 68.917, deci același set.
 *
 * Nu intră: profilurile „Defectate_*” (contoare defecte, au grup separat în SCADA), `Edge_Gas_Meter_DP` și `default` (fără client / filială),
 * apa, energia, gateway-urile și dispozitivele de test. Se schimbă DOAR aici.
 */
export type GasCustomer = { id: string; name: string; fil: string };

export const GAS_CUSTOMERS: GasCustomer[] = [
  { id: "2e2874d0-7c4e-11ed-bc64-85872813a734", name: "ComratGaz_DashGroup", fil: "05" },
  { id: "07ed0920-7b6d-11ed-bc64-85872813a734", name: "OrheiGaz_DashGroup", fil: "20" },
  { id: "b6f36920-ea9b-11ee-b1d6-97aa3471e353", name: "IaloveniGaz", fil: "36" },
  { id: "f20657f0-5898-11ef-936d-33a22b7e43aa", name: "CahulGaz_DashGroup", fil: "11" },
  { id: "8f50d730-8175-11ed-bc64-85872813a734", name: "StefanVodaGaz_DashGroup", fil: "35" },
  { id: "4c96e5a0-7409-11ef-ac57-5deef674e634", name: "FlorestiGaz", fil: "31" },
  { id: "42d18610-7409-11ef-ac57-5deef674e634", name: "CimisliaGaz", fil: "33" },
  { id: "e201fef0-d8d5-11ef-9e8c-634c2bb8f9a2", name: "Chisinau_Gaz", fil: "01" },
  { id: "47963a10-7409-11ef-ac57-5deef674e634", name: "EdinetGaz", fil: "10" },
  { id: "50fcfee0-7409-11ef-ac57-5deef674e634", name: "TaracliaGaz", fil: "27" },
];

/** client ThingsBoard → codul filialei (FIL) */
export const CUSTOMER_FIL: Record<string, string> = Object.fromEntries(GAS_CUSTOMERS.map((c) => [c.id, c.fil]));

/** profiluri de dispozitiv excluse chiar dacă aparțin unui client de gaz */
export const EXCLUDED_PROFILE = /^Defectate_/i;
