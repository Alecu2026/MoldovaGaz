import { allowsMeter, type Viewer } from "./access";

/**
 * Notificările despre probleme (partea comună client + server). Fiecare utilizator primește DOAR tipurile bifate la contul lui (la «Utilizatori»), iar cele care țin de un oraș
 * doar pentru orașele pe care are voie să le vadă (aceeași zonă ca la contoare); administratorii cu tipul bifat le primesc pe toate zonele.
 *   · meters_silent — contoare care au început să nu mai transmită (într-un oraș);
 *   · gw_down       — o antenă care nu mai primește mesaje;
 *   · gw_drop       — eficiență scăzută la o antenă (mult mai puține mesaje decât de obicei).
 * Un eveniment (problemă) are o cheie stabilă (`key`): se deschide o singură dată, se actualizează cât timp durează și se închide singur când problema dispare.
 */
export const NOTIFY_TYPES = ["meters_silent", "gw_down", "gw_drop"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];
export const NOTIFY_INFO: Record<NotifyType, { label: string; desc: string }> = {
  meters_silent: { label: "Contoare care nu mai transmit", desc: "Într-un oraș, contoare care transmiteau și au încetat (ultima citire mai veche de 36 h)." },
  gw_down: { label: "Antenă fără mesaje", desc: "O antenă care primea mesaje constant și nu mai primește nimic de câteva ore." },
  gw_drop: { label: "Eficiență scăzută la antene", desc: "O antenă care a primit ieri mult mai puține mesaje decât de obicei (sub jumătate)." },
};
export const isNotifyType = (x: unknown): x is NotifyType => typeof x === "string" && (NOTIFY_TYPES as readonly string[]).includes(x);

/** Validează lista de tipuri trimisă de client (necunoscutele și dublurile ies). */
export function cleanNotify(raw: unknown): { notify: NotifyType[] } | { error: string } {
  if (raw === undefined || raw === null) return { notify: [] };
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return { error: "Notificări invalide." };
  return { notify: [...new Set(raw.filter(isNotifyType))] };
}

/** O problemă, așa cum o vede utilizatorul. `zones` = „<filială>|<oraș>” (fără oraș: „—”). */
export type NotifyEvent = {
  id: string; type: NotifyType; key: string; level: "warn" | "crit";
  title: string; body: string; zones: string[];
  openedAt: number; /** ultima notificare trimisă (deschidere sau agravare) */ at: number; resolvedAt: number | null;
};

/** Evenimentul intră în zona utilizatorului? Administratorul vede toate; ceilalți doar dacă cel puțin una din zonele evenimentului e a lor. */
export function eventVisible(v: Viewer, zones: string[]): boolean {
  if (v.admin) return true;
  return zones.some((z) => { const i = z.indexOf("|"); return i > 0 && allowsMeter(v, z.slice(0, i), z.slice(i + 1)); });
}
/** Tipul e permis utilizatorului? */
export const canGet = (notify: readonly NotifyType[], type: NotifyType): boolean => notify.includes(type);
