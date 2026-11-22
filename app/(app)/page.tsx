import { Suspense } from "react";
import type { Metadata } from "next";
import MetersTable from "@/app/components/MetersTable";
import { requireUser } from "@/lib/dal";
import { getHeadRows, warmVersion } from "@/lib/services/meter-dataset";
import { filtersFromParams, sortFromParams } from "@/lib/meter-filter";

export const metadata: Metadata = { title: "Contoare de gaz" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <Gate searchParams={searchParams} />
    </Suspense>
  );
}

/**
 * Verifică sesiunea și trimite către client doar ce trebuie pentru PRIMA pictare: filtrele din URL, primele rânduri (o interogare indexată) și versiunea
 * listei de pe server — dacă browserul are deja exact această versiune (memorie / IndexedDB), nu mai face nicio cerere.
 * Lista completă NU trece prin HTML: vine separat, gzip, din /api/meters/dataset.
 */
async function Gate({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const [head, warm] = await Promise.all([getHeadRows(40), warmVersion()]);
  return <MetersTable userId={user.id} warm={warm} head={head} initialFilters={filtersFromParams(get)} initialSort={sortFromParams(get)} initialView={get("view") === "charts" ? "charts" : get("view") === "map" ? "map" : "table"} />;
}

function TableSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Se încarcă">
      <div className="skeleton" style={{ height: 112, borderRadius: 12 }} />
      <div className="stats">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 68, borderRadius: 12 }} />
        ))}
      </div>
      <div className="skeleton" style={{ flex: 1, borderRadius: 12 }} />
    </div>
  );
}
