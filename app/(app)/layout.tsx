import { Suspense } from "react";
import AppNav from "@/app/components/AppNav";
import AppShell from "@/app/components/AppShell";
import LogoutButton from "@/app/components/LogoutButton";
import AuditTracker from "@/app/components/AuditTracker";
import ImpersonationNotice from "@/app/components/ImpersonationNotice";
import NotifBell from "@/app/components/NotifBell";
import { PAGES, can } from "@/lib/access";
import { requireUser } from "@/lib/dal";

/** Cadrul aplicației: meniu lateral (vezi AppShell); meniul și contul așteaptă sesiunea, fiecare într-un Suspense. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      nav={<Suspense fallback={<nav className="side-nav" aria-label="Pagini" />}><Nav /></Suspense>}
      who={<Suspense fallback={<div className="skeleton" style={{ width: 160, height: 28 }} />}><Who /></Suspense>}
    >
      {children}
      <Suspense fallback={null}><ImpersonationNotice /></Suspense>
      <Suspense fallback={null}><AuditTracker /></Suspense>
    </AppShell>
  );
}

/** Meniul: doar paginile la care utilizatorul are dreptul «Vizualizare» (administratorul le vede pe toate). */
async function Nav() {
  const user = await requireUser();
  // «Securitate» (parola proprie, sesiuni) e pentru orice cont autentificat, nu depinde de drepturile pe pagini
  return <AppNav hrefs={[...PAGES.filter((p) => can(user, p.key)).map((p) => p.path), "/securitate"]} />;
}

async function Who() {
  const user = await requireUser();
  return (
    <div className="who">
      {user.notify.length > 0 && <NotifBell />}
      <span title={user.email}>{user.email}</span>
      <LogoutButton />
    </div>
  );
}
