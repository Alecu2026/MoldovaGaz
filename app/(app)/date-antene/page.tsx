import { Suspense } from "react";
import type { Metadata } from "next";
import AntennaOverview from "@/app/components/AntennaOverview";
import { requirePage } from "@/lib/dal";

export const metadata: Metadata = { title: "Antene: date și hartă" };

export default function Page() {
  return (
    <Suspense fallback={<div className="page" aria-busy="true"><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></div>}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  await requirePage("antennaInfo");
  return <AntennaOverview />;
}
