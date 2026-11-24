"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Cele trei pagini: datele combinate (principala), doar lorawandb (primul IP) și doar getmgdb (al doilea IP). */
const ITEMS: { href: string; label: string; sub: string; title: string }[] = [
  { href: "/", label: "Contoare", sub: "combinat", title: "Contoarele din SCADA + facturarea, puse împreună (volum, coordonate, stare)" },
  { href: "/control", label: "Consum nemăsurat", sub: "noapte", title: "Contoare care noaptea nu înregistrează consum deși ziua consumă și temperatura nu scade" },
  { href: "/integration", label: "Integrare", sub: "api", title: "API-ul prin care primim mesaje direct de la LoRaWAN / antene: stare, ritm, verificare mesaj" },
  { href: "/rapoarte", label: "Rapoarte", sub: "facturare", title: "Raport de citiri către facturare (Oracle): perioadă la alegere, fișier CSV pe server, generare automată pe 1 ale lunii la 07:00" },
  { href: "/instalator", label: "Instalator", sub: "montaj", title: "Ecranul instalatorului, ca în SCADA (ChisinauGaz_Instalator_App): listă de contoare, scanare QR, poză, locație și datele de montaj; se salvează doar la noi" },
  { href: "/antene", label: "Instalator antene", sub: "montaj", title: "Ecranul instalatorului de antene, ca în SCADA (Gateways_Lorawan_App): lista antenelor, poză, locație, instalator, număr SIM; se salvează doar la noi" },
  { href: "/date-antene", label: "Antene", sub: "date + hartă", title: "Datele fiecărei antene (activitate, contoare auzite, semnal, client, instalator) și harta lor, pe o pagină separată" },
  { href: "/module", label: "Module LoRaWAN", sub: "chirpstack", title: "Înregistrarea și activarea modulelor în ChirpStack, ca în SCADA: creare, OTAA / ABP, reînregistrare de urgență, comenzi (doar administratori)" },
  { href: "/lorawan", label: "Dispozitive LoRaWAN", sub: "lorawandb", title: "Doar datele din lorawandb (primul IP)" },
  { href: "/facturare", label: "Facturare", sub: "getmgdb", title: "Doar datele din getmgdb (al doilea IP)" },
  { href: "/audit", label: "Jurnal de audit", sub: "audit", title: "Cine a făcut ce, când și de unde: autentificări, drepturi, rapoarte, module, date modificate, acces refuzat" },
  { href: "/securitate", label: "Securitate", sub: "parola mea", title: "Schimbă-ți parola, vezi sesiunile deschise și activitatea contului tău" },
  { href: "/utilizatori", label: "Utilizatori", sub: "acces", title: "Conturile aplicației: cine ce pagini vede și ce filiale / orașe (doar administratorii)" },
];

/** `hrefs` = paginile pe care le poate vedea utilizatorul conectat (restul nu apar în meniu). */
export default function AppNav({ hrefs }: { hrefs: string[] }) {
  const path = usePathname();
  return (
    <nav className="side-nav" aria-label="Pagini">
      {ITEMS.filter((it) => hrefs.includes(it.href)).map((it) => {
        const on = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} aria-current={on ? "page" : undefined} title={it.title} className="side-link">
            <span>{it.label}</span>
            <span className="side-sub">{it.sub}</span>
          </Link>
        );
      })}
    </nav>
  );
}
