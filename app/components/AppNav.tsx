"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Meniul lateral: grupat pe teme, fiecare pagină cu o pictogramă potrivită (se recunoaște după ea, mai ales când meniul e strâns și rămân doar pictogramele) și cu o explicație scurtă în limbaj obișnuit.
 * Pictogramele sunt SVG-uri în linie (fără bibliotecă): contur de 1,8 px, 24×24, culoarea textului.
 */
const Ico = ({ children }: { children: ReactNode }) => (
  <svg className="side-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICONS: Record<string, ReactNode> = {
  // contor / cadran
  "/": <Ico><path d="M4.5 18.5a9 9 0 1 1 15 0" /><path d="M12 14l4-5" /><circle cx="12" cy="14" r="1.4" /><path d="M7 21h10" /></Ico>,
  // lună = noaptea
  "/control": <Ico><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" /><path d="M16 4v3M14.5 5.5h3" /></Ico>,
  // cheie de montaj
  "/instalator": <Ico><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Ico>,
  // antenă parabolică (instalare)
  "/antene": <Ico><path d="M4 10a7.3 7.3 0 0 0 10 10z" /><path d="m9 15 3-3" /><path d="M17 13a6 6 0 0 0-6-6" /><path d="M21 13A10 10 0 0 0 11 3" /></Ico>,
  // turn de radio (date + hartă)
  "/date-antene": <Ico><path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9" /><path d="M7.8 4.7a6.1 6.1 0 0 0-.8 7.5" /><circle cx="12" cy="9" r="2" /><path d="M16.2 4.7a6.1 6.1 0 0 1 .8 7.5" /><path d="M19.1 1.9a10.1 10.1 0 0 1 0 14.2" /><path d="M9.5 18h5" /><path d="m8 22 4-11 4 11" /></Ico>,
  // schimb de date (mesaje între sisteme)
  "/integration": <Ico><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></Ico>,
  // cip (modulul din contor)
  "/module": <Ico><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></Ico>,
  // bază de date
  "/lorawan": <Ico><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Ico>,
  // raport cu bare
  "/rapoarte": <Ico><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 18v-3M12 18v-6M15 18v-2" /></Ico>,
  // bon / factură
  "/facturare": <Ico><path d="M5 2v20l3-2 2 2 2-2 2 2 2-2 3 2V2l-3 2-2-2-2 2-2-2-2 2z" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></Ico>,
  // conturi
  "/utilizatori": <Ico><circle cx="9" cy="8" r="3.6" /><path d="M2.5 21v-1a6 6 0 0 1 6-6h1a6 6 0 0 1 6 6v1" /><path d="M16 4.3a3.6 3.6 0 0 1 0 7" /><path d="M21.5 21v-1a6 6 0 0 0-3.8-5.6" /></Ico>,
  // istoric (cine, ce, când)
  "/audit": <Ico><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3.5 2" /></Ico>,
  // scut cu bifă
  "/securitate": <Ico><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></Ico>,
};

type Item = { href: string; label: string; sub: string; title: string };
const GROUPS: { title: string; items: Item[] }[] = [
  { title: "Contoare", items: [
    { href: "/", label: "Contoare", sub: "listă, hartă, grafice", title: "Contoarele din SCADA + facturarea, puse împreună (volum, coordonate, stare)" },
    { href: "/control", label: "Consum nemăsurat", sub: "suspecte noaptea", title: "Contoare care noaptea nu înregistrează consum deși ziua consumă și temperatura nu scade" },
    { href: "/instalator", label: "Instalator contoare", sub: "montaj, poză, QR", title: "Ecranul instalatorului, ca în SCADA (ChisinauGaz_Instalator_App): listă de contoare, scanare QR, poză, locație și datele de montaj; se salvează doar la noi" },
  ] },
  { title: "Antene", items: [
    { href: "/date-antene", label: "Antene", sub: "date și hartă", title: "Datele fiecărei antene (activitate, contoare auzite, semnal, client, instalator) și harta lor, pe o pagină separată" },
    { href: "/antene", label: "Instalator antene", sub: "montaj, poză, SIM", title: "Ecranul instalatorului de antene, ca în SCADA (Gateways_Lorawan_App): lista antenelor, poză, locație, instalator, număr SIM; se salvează doar la noi" },
  ] },
  { title: "LoRaWAN", items: [
    { href: "/integration", label: "Integrare API", sub: "mesaje primite direct", title: "API-ul prin care primim mesaje direct de la LoRaWAN / antene: stare, ritm, verificare mesaj" },
    { href: "/module", label: "Module LoRaWAN", sub: "înregistrare ChirpStack", title: "Înregistrarea și activarea modulelor în ChirpStack, ca în SCADA: creare, OTAA / ABP, reînregistrare de urgență, comenzi (doar administratori)" },
    { href: "/lorawan", label: "Dispozitive LoRaWAN", sub: "date din lorawandb", title: "Doar datele din lorawandb (primul IP)" },
  ] },
  { title: "Facturare", items: [
    { href: "/rapoarte", label: "Rapoarte", sub: "citiri către facturare", title: "Raport de citiri către facturare (Oracle): perioadă la alegere, fișier CSV pe server, generare automată pe 1 ale lunii la 07:00" },
    { href: "/facturare", label: "Facturare", sub: "date din getmgdb", title: "Doar datele din getmgdb (al doilea IP)" },
  ] },
  { title: "Administrare", items: [
    { href: "/utilizatori", label: "Utilizatori", sub: "conturi și drepturi", title: "Conturile aplicației: cine ce pagini vede și ce filiale / orașe (doar administratorii)" },
    { href: "/audit", label: "Jurnal de audit", sub: "cine a făcut ce", title: "Cine a făcut ce, când și de unde: autentificări, drepturi, rapoarte, module, date modificate, acces refuzat" },
    { href: "/securitate", label: "Securitate", sub: "parola mea, sesiuni", title: "Schimbă-ți parola, vezi sesiunile deschise și activitatea contului tău" },
  ] },
];

/** `hrefs` = paginile pe care le poate vedea utilizatorul conectat (restul nu apar în meniu; un grup fără pagini dispare). */
export default function AppNav({ hrefs }: { hrefs: string[] }) {
  const path = usePathname();
  return (
    <nav className="side-nav" aria-label="Pagini">
      {GROUPS.map((g) => {
        const items = g.items.filter((it) => hrefs.includes(it.href));
        if (items.length === 0) return null;
        return (
          <div className="side-group" key={g.title} role="group" aria-label={g.title}>
            <div className="side-group-t" aria-hidden="true">{g.title}</div>
            {items.map((it) => {
              const on = it.href === "/" ? path === "/" : path.startsWith(it.href);
              return (
                <Link key={it.href} href={it.href} aria-current={on ? "page" : undefined} aria-label={it.label} title={`${it.label} — ${it.title}`} className="side-link">
                  <span className="side-ico-box">{ICONS[it.href]}</span>
                  <span className="side-txt"><span className="side-label">{it.label}</span><span className="side-sub">{it.sub}</span></span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
