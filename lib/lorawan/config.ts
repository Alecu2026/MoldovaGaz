/**
 * Înregistrarea și activarea modulelor LoRaWAN în ChirpStack — aceleași reguli ca lanțul din SCADA «LoraWan_register_and_activation» (portate din configurația lui):
 *  · serverul principal (ChirpStack v3, API REST) — aplicația și profilul se aleg după tipul contorului (filiala) și activare (OTAA / ABP);
 *  · serverul de rezervă «de urgență» (ChirpStack v3) — reînregistrare ABP, cu aplicațiile lui;
 *  · al treilea server (ChirpStack v4) — «ABP extraframe» (activare ABP + comandă de repornire);
 *  · numele din ChirpStack = numele contorului fără prima literă «S» («SN» la ACC Axioma).
 * Adresele, contul și cheile vin DOAR din mediu (.env.local pe server), nimic din ele nu stă în cod. Partea comună client + server (fără importuri de server).
 */
export const GAS_TYPES = [
  "Jooby_Gas_Meter_DP", "Comrat_Gas_Meter_DP", "StefanVoda_Gas_Meter_DP", "Ialoveni_Gas_Meter_DP", "Cahul_Gas_Meter_DP", "Floresti_Gas_Meter_DP",
  "Cimislia_Gas_Meter_DP", "Edinet_Gas_Meter_DP", "Taraclia_Gas_Meter_DP", "Chisinau_Gas_Meter_DP", "ACC_AXIOMA_W1_DP", "AC_Lozova_W1_DP", "Defectate_Jooby_Gaz",
] as const;
export type ModType = (typeof GAS_TYPES)[number];
export const TYPE_LABEL: Record<ModType, string> = {
  Jooby_Gas_Meter_DP: "Orhei (Jooby)", Comrat_Gas_Meter_DP: "Comrat", StefanVoda_Gas_Meter_DP: "Ștefan Vodă", Ialoveni_Gas_Meter_DP: "Ialoveni", Cahul_Gas_Meter_DP: "Cahul",
  Floresti_Gas_Meter_DP: "Florești", Cimislia_Gas_Meter_DP: "Cimișlia", Edinet_Gas_Meter_DP: "Edineț", Taraclia_Gas_Meter_DP: "Taraclia", Chisinau_Gas_Meter_DP: "Chișinău",
  ACC_AXIOMA_W1_DP: "Apă Canal Chișinău (Axioma W1)", AC_Lozova_W1_DP: "AC Lozova (W1)", Defectate_Jooby_Gaz: "Defectate (Jooby)",
};
export type Activation = "OTAA" | "ABP";
export const isType = (x: unknown): x is ModType => typeof x === "string" && (GAS_TYPES as readonly string[]).includes(x);

/** (aplicație, profil) la serverul principal. Contoarele cu seria S3010… (partener) merg în aplicația 12, cu profilul lor. */
export type Target = { applicationID: string; deviceProfileID: string };
const OTAA_PROFILE = "9af1b76c-b566-47e4-90d9-86a4fc328bc2", PARTNER_PROFILE = "8ef5cf24-e282-44ce-8827-3b1552bc2d06", ABP_PROFILE = "236b9ff1-90fe-424d-bd03-069305facc7b";
const PRIMARY_APP: Partial<Record<ModType, string>> = { Comrat_Gas_Meter_DP: "29", StefanVoda_Gas_Meter_DP: "30", Ialoveni_Gas_Meter_DP: "36", Cahul_Gas_Meter_DP: "37", Floresti_Gas_Meter_DP: "39", Cimislia_Gas_Meter_DP: "40", Edinet_Gas_Meter_DP: "41", Taraclia_Gas_Meter_DP: "42", Chisinau_Gas_Meter_DP: "44" };
export const seriesPrefix = (name: string): string => name.split("_")[0];
export function primaryTarget(type: ModType, name: string, activation: Activation): Target | null {
  if (type === "ACC_AXIOMA_W1_DP") return { applicationID: "3", deviceProfileID: "6f4011e1-e67c-4ddc-bdf8-f429b9f0f541" };
  if (type === "AC_Lozova_W1_DP") return { applicationID: "12", deviceProfileID: PARTNER_PROFILE };
  if (type === "Defectate_Jooby_Gaz") return null;
  if (seriesPrefix(name) === "S3010") return { applicationID: "12", deviceProfileID: PARTNER_PROFILE };
  if (type === "Jooby_Gas_Meter_DP") return activation === "ABP" ? { applicationID: "23", deviceProfileID: ABP_PROFILE } : { applicationID: "27", deviceProfileID: OTAA_PROFILE };
  const app = PRIMARY_APP[type];
  return app ? { applicationID: app, deviceProfileID: OTAA_PROFILE } : null;
}
/** (aplicație, profil) la serverul de rezervă (reînregistrarea «de urgență», ABP). */
const BACKUP_APP: Partial<Record<ModType, string>> = { Jooby_Gas_Meter_DP: "6", Comrat_Gas_Meter_DP: "7", StefanVoda_Gas_Meter_DP: "8", Ialoveni_Gas_Meter_DP: "11", Floresti_Gas_Meter_DP: "15", Edinet_Gas_Meter_DP: "17", Taraclia_Gas_Meter_DP: "19", Cimislia_Gas_Meter_DP: "18", Cahul_Gas_Meter_DP: "14", Chisinau_Gas_Meter_DP: "23" };
export const BACKUP_PROFILE = "066bc2af-408a-462a-b55e-e198d3f84a73";
export function backupTarget(type: ModType): Target | null { const a = BACKUP_APP[type]; return a ? { applicationID: a, deviceProfileID: BACKUP_PROFILE } : null; }
/** (aplicație, profil) la al treilea server (ChirpStack v4): ABP extraframe. */
const V4_APP: Partial<Record<ModType, string>> = { Jooby_Gas_Meter_DP: "f61f19e3-7aad-4f5e-bf63-c0dc02ff63c3", Comrat_Gas_Meter_DP: "ce9eabf7-5ac5-4c20-930b-0a3674efa315", StefanVoda_Gas_Meter_DP: "a376cd24-89ec-4a2c-bf62-cb9964c6a786", Ialoveni_Gas_Meter_DP: "ad02b302-c714-4e79-9830-8c4c75677308", Floresti_Gas_Meter_DP: "70c89deb-fdde-47a4-8ecd-7c21dedf849a", Edinet_Gas_Meter_DP: "de873f16-cc7b-4a26-9c0a-823f4e9df8b1", Taraclia_Gas_Meter_DP: "9db70303-5d7c-4017-8689-0e2ddfe0396a", Cimislia_Gas_Meter_DP: "808a1ac8-c9fa-40e4-943d-404274b0ad60", Cahul_Gas_Meter_DP: "33083c03-1609-4347-8f5c-e3e033a8a851" };
export const V4_PROFILE = "3f26dbfc-efef-4291-9c05-66e0d5f5d8d3";
export function v4Target(type: ModType): Target | null { const a = V4_APP[type]; return a ? { applicationID: a, deviceProfileID: V4_PROFILE } : null; }

/** Numele în ChirpStack: fără prima «S» (la ACC Axioma: fără «SN»). */
export const chirpName = (name: string, type: ModType): string => (type === "ACC_AXIOMA_W1_DP" ? name.replace("SN", "") : name.replace("S", ""));

/** Comenzile (downlink) cunoscute, ca în SCADA: conținutul în base64. */
export const DOWNLINKS = {
  to_abp: { label: "Trecere pe ABP", data: "AwIJAVw=" },
  to_otaa: { label: "Trecere pe OTAA", data: "AwIJAF0=" },
  soft_restart: { label: "Repornire soft", data: "GQBM" },
  disable_extraframes: { label: "Fără extraframe-uri", data: "AwMcAABJ" },
  depassivation: { label: "Depasivarea bateriei", data: "AwcK6mAgAAwcoQ==" },
} as const;
export type DownlinkKey = keyof typeof DOWNLINKS;

/* ───────── validări ───────── */
export const hex = (s: unknown, n: number): string | null => { const t = String(s ?? "").trim().toLowerCase(); return new RegExp(`^[0-9a-f]{${n}}$`).test(t) ? t : null; };
export const nameOk = (s: string): boolean => /^(?:S|SN)?[0-9A-Za-z]{2,8}_[0-9]{4,10}_[0-9]{4}$|^SN[0-9]{6,12}$|^[A-Za-z0-9_.-]{4,40}$/.test(s);

export type ModuleInput = { name: string; type: ModType; activation: Activation; devEUI: string; appKey?: string; devAddr?: string; devAaddr?: string; appSKey?: string; nwkSKey?: string };
/** Validează o înregistrare nouă (câmpurile cerute depind de activare). Întoarce { mod } curățat sau { error }. */
export function cleanModule(raw: unknown): { mod: ModuleInput } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Cerere invalidă." };
  const b = raw as Record<string, unknown>;
  const name = String(b.name ?? "").trim();
  if (!nameOk(name) || name.length > 40) return { error: `Numele contorului nu e valid: «${name}».` };
  if (!isType(b.type)) return { error: `Tipul (filiala) nu e valid: «${String(b.type ?? "")}».` };
  const activation = b.activation === "ABP" ? "ABP" : b.activation === "OTAA" ? "OTAA" : null;
  if (!activation) return { error: "Activarea trebuie să fie OTAA sau ABP." };
  const devEUI = hex(b.devEUI, 16);
  if (!devEUI) return { error: `devEUI trebuie să aibă 16 cifre hexazecimale: «${String(b.devEUI ?? "")}».` };
  const mod: ModuleInput = { name, type: b.type, activation, devEUI };
  const k = (key: string, n: number, label: string, need: boolean): string | null => { const v = hex(b[key], n); if (!v && (need || String(b[key] ?? "").trim() !== "")) return `${label} trebuie să aibă ${n} cifre hexazecimale.`; if (v) (mod as Record<string, unknown>)[key] = v; return null; };
  const problems = [
    k("appKey", 32, "APPKEY", activation === "OTAA"),
    k("appSKey", 32, "APPSKEY", activation === "ABP"),
    k("nwkSKey", 32, "NWKSKEY", activation === "ABP"),
    k("devAddr", 8, "devADDR", activation === "ABP"),
  ].filter(Boolean);
  if (problems.length) return { error: problems.join(" ") };
  const aa = String(b.devAaddr ?? "").trim().toUpperCase();
  if (aa) { if (!/^A[0-9A-F]{8}$/.test(aa)) return { error: "devAADDR (reactivarea de urgență / extraframe) trebuie să fie «A» urmat de 8 cifre hexazecimale (9 caractere), ex. A0001162C." }; mod.devAaddr = aa; }
  return { mod };
}
