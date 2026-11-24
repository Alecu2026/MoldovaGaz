import { Suspense } from "react";
import type { Metadata } from "next";
import LorawanPanel from "@/app/components/LorawanPanel";
import { requirePage } from "@/lib/dal";

export const metadata: Metadata = { title: "Module LoRaWAN" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  await requirePage("admin");
  return <LorawanPanel />;
}
