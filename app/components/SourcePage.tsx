import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { filtersFromEntries, sortFromEntries } from "@/lib/source-filter";
import { SOURCES, type SourceId } from "@/lib/source-shared";
import SourceTable from "./SourceTable";

type SP = Promise<Record<string, string | string[] | undefined>>;

/** Pagina unei surse: verifică sesiunea și trimite către client doar filtrele din URL; lista vine separat, gzip, din /api/sources/<sursă>/dataset. */
export default function SourcePage({ source, searchParams }: { source: SourceId; searchParams: SP }) {
  return (
    <Suspense fallback={<Skeleton />}>
      <Gate source={source} searchParams={searchParams} />
    </Suspense>
  );
}

async function Gate({ source, searchParams }: { source: SourceId; searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const entries = Object.entries(sp).flatMap(([k, v]) => (first(v) !== undefined ? [[k, first(v) as string] as [string, string]] : []));
  const get = (k: string) => first(sp[k]);
  const meta = SOURCES[source];
  return <SourceTable userId={user.id} source={source} initialFilters={filtersFromEntries(entries)} initialSort={sortFromEntries(get, meta.defaultSort)} initialView={get("view") === "charts" ? "charts" : "table"} />;
}

function Skeleton() {
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
