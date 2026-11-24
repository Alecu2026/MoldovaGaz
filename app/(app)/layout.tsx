import { Suspense } from "react";
import AppNav from "@/app/components/AppNav";
import AppShell from "@/app/components/AppShell";
import LogoutButton from "@/app/components/LogoutButton";
import { PAGES } from "@/lib/access";
import { requireUser } from "@/lib/dal";

/** Cadrul aplicației: meniu lateral (vezi AppShell); meniul și contul așteaptă sesiunea, fiecare într-un Suspense. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      nav={<Suspense fallback={<nav className="side-nav" aria-label="Pagini" />}><Nav /></Suspense>}
      who={<Suspense fallback={<div className="skeleton" style={{ width: 160, height: 28 }} />}><Who /></Suspense>}
    >
      {children}
    </AppShell>
  );
}

/** Meniul: doar paginile pe care le poate vedea utilizatorul (administratorul le vede pe toate). */
async function Nav() {
  const user = await requireUser();
  const all = ["/", "/control", "/integration", "/rapoarte", "/instalator", "/antene", "/lorawan", "/facturare", "/utilizatori"];
  return <AppNav hrefs={user.admin ? all : PAGES.filter((p) => user.access.pages.includes(p.key)).map((p) => p.path)} />;
}

async function Who() {
  const user = await requireUser();
  return (
    <div className="who">
      <span title={user.email}>{user.email}</span>
      <LogoutButton />
    </div>
  );
}
