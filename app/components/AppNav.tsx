"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Cele două pagini: datele combinate (principala) și doar facturarea (getmgdb). */
const ITEMS: { href: string; label: string; sub: string; title: string }[] = [
  { href: "/", label: "Contoare", sub: "combinat", title: "Contoarele din SCADA + facturarea, puse împreună (volum, coordonate, stare)" },
  { href: "/facturare", label: "Facturare", sub: "getmgdb", title: "Doar datele din getmgdb (facturarea Moldovagaz)" },
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
