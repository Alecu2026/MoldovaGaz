import { Suspense } from "react";
import type { Metadata } from "next";
import InstallerApp from "@/app/components/InstallerApp";
import { can } from "@/lib/access";
import { requirePage } from "@/lib/dal";
import { getFilter, listMeters } from "@/lib/services/installer";

export const metadata: Metadata = { title: "Instalator" };

export default function Page() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Gate />
    </Suspense>
  );
}

async function Gate() {
  const user = await requirePage("installer");
  // filtrul păstrat și prima pagină a listei, într-un singur drum către baza de date, ca prima pictare să nu aștepte cereri separate
  const filter = await getFilter(user.id).catch(() => "");
  const list = await listMeters(user, { q: filter.trim(), page: 0, size: 10, sort: "name", dir: 1 }).catch(() => null);
  return <InstallerApp canHome={can(user, "meters")} canEdit={can(user, "installer", "edit")} initial={{ filter, list }} />;
}

/** Cât așteaptă sesiunea și lista: bara verde de sus apare imediat (aceeași ca în aplicație), restul se umple după. */
function Skeleton() {
  return (
    <div className="tbx" aria-busy="true" aria-label="Se încarcă">
      <header className="tbx-tool"><div className="tbx-tool-row1"><h1>Moldovagaz_Meter_App</h1></div><div className="tbx-tool-row2" style={{ minHeight: 48 }} /></header>
      <div className="tbx-grid"><div className="skeleton" style={{ gridColumn: "1 / -1", gridRow: "span 3", borderRadius: 8 }} /></div>
    </div>
  );
}
