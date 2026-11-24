import { Suspense } from "react";
import type { Metadata } from "next";
import InstallerApp from "@/app/components/InstallerApp";
import { requireUser } from "@/lib/dal";

export const metadata: Metadata = { title: "Instalator" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  await requireUser();
  return <InstallerApp />;
}
