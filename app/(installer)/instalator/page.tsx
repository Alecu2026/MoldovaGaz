import { Suspense } from "react";
import type { Metadata } from "next";
import InstallerApp from "@/app/components/InstallerApp";
import { requirePage } from "@/lib/dal";

export const metadata: Metadata = { title: "Instalator" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  const user = await requirePage("installer");
  return <InstallerApp canHome={user.admin || user.access.pages.includes("meters")} />;
}
