import { Suspense } from "react";
import type { Metadata } from "next";
import AntennaApp from "@/app/components/AntennaApp";
import { can } from "@/lib/access";
import { requirePage } from "@/lib/dal";
import { getAntennaFilter, listAntennas } from "@/lib/services/antennas";

export const metadata: Metadata = { title: "Antene" };

export default function Page() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  const user = await requirePage("antennas");
  // filtrul păstrat și lista antenelor vin odată cu pagina: prima pictare are deja date
  const [filter, list] = await Promise.all([getAntennaFilter(user.id).catch(() => ""), listAntennas().catch(() => null)]);
  return <AntennaApp canHome={can(user, "meters")} canEdit={can(user, "antennas", "edit")} initial={{ filter, list }} />;
}

/** Cât așteaptă sesiunea și lista: bara verde de sus apare imediat, restul se umple după. */
function Skeleton() {
  return (
    <div className="tbx" aria-busy="true" aria-label="Se încarcă">
      <header className="tbx-tool"><div className="tbx-tool-row1"><h1>Gateway_App</h1></div><div className="tbx-tool-row2" style={{ minHeight: 48 }} /></header>
      <div className="tbx-grid"><div className="skeleton" style={{ gridColumn: "1 / -1", gridRow: "span 3", borderRadius: 8 }} /></div>
    </div>
  );
}
