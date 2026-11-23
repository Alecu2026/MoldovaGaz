"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Cele trei pagini: datele combinate (principala), doar lorawandb (primul IP) și doar getmgdb (al doilea IP). */
const ITEMS: { href: string; label: string; sub: string; title: string }[] = [
  { href: "/", label: "Contoare", sub: "combinat", title: "Contoarele din SCADA + facturarea, puse împreună (volum, coordonate, stare)" },
  { href: "/control", label: "Consum nemăsurat", sub: "noapte", title: "Contoare care noaptea nu înregistrează consum deși ziua consumă și temperatura nu scade" },
  { href: "/lorawan", label: "Dispozitive LoRaWAN", sub: "lorawandb", title: "Doar datele din lorawandb (primul IP)" },
  { href: "/facturare", label: "Facturare", sub: "getmgdb", title: "Doar datele din getmgdb (al doilea IP)" },
];

export default function AppNav() {
  const path = usePathname();
  return (
    <nav className="appnav" aria-label="Pagini">
      {ITEMS.map((it) => {
        const on = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} aria-current={on ? "page" : undefined} title={it.title}>
            {it.label}
            <span className="appnav-sub">{it.sub}</span>
          </Link>
        );
      })}
    </nav>
  );
}
