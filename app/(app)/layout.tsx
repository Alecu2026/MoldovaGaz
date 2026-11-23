import { Suspense } from "react";
import AppNav from "@/app/components/AppNav";
import BrandMark from "@/app/components/BrandMark";
import LogoutButton from "@/app/components/LogoutButton";
import { requireUser } from "@/lib/dal";

/** Cadrul aplicației: bara de sus e statică (în shell); doar numele utilizatorului așteaptă sesiunea, într-un Suspense. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <BrandMark size={18} />
          </div>
          <div>
            <div className="brand-name" style={{ fontSize: 16, lineHeight: 1.1 }}>
              Moldovagaz
            </div>
          </div>
        </div>
        <AppNav />
        <Suspense fallback={<div className="skeleton" style={{ width: 180, height: 28 }} />}>
          <Who />
        </Suspense>
      </header>
      {children}
    </>
  );
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
