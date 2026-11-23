"use client";

import { useEffect, useState } from "react";

/**
 * „Mărește”: un card (listă, tabel) se întinde pe tot ecranul, ca o pânză; Esc sau același buton îl aduc înapoi.
 * Cardul primește clasa `expanded` (vezi globals.css); lista din el își măsoară singură înălțimea și își recalculează rândurile vizibile.
 */
export function useExpand(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);
  return [open, setOpen];
}

export default function ExpandButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn" aria-pressed={open} onClick={onToggle} title="Mărește pe tot ecranul (Esc = înapoi)">
      {open ? "Micșorează ⤡" : "Mărește ⤢"}
    </button>
  );
}
