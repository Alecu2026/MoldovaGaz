import type { Metadata } from "next";
import SourcePage from "@/app/components/SourcePage";

export const metadata: Metadata = { title: "Dispozitive LoRaWAN" };

export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <SourcePage source="lorawan" searchParams={searchParams} />;
}
