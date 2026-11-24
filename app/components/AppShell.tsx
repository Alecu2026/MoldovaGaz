"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import BrandMark from "./BrandMark";

/**
 * Cadrul aplicației: meniu lateral (sidebar) în loc de bara de sus cu toate paginile.
 *  - calculator: sidebar de 232 px care se poate închide (rămâne o bandă îngustă cu butonul de redeschidere); alegerea se ține minte în browser;
 *  - telefon: sus doar o bară mică cu butonul „Meniu”; sidebar-ul se deschide peste pagină (cu fundal întunecat) și se închide singur la schimbarea paginii, la Esc sau la atingerea fundalului.
 * `nav` (meniul) și `who` (contul + ieșire) vin de pe server (depind de sesiune), de aceea sunt primite ca elemente gata făcute.
 */
const KEY = "mg:side";
const Burger = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
const Chevron = ({ left }: { left: boolean }) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={left ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} /></svg>;

export default function AppShell({ nav, who, children }: { nav: React.ReactNode; who: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  // meniul deschis pe telefon e legat de pagina pe care a fost deschis: la schimbarea paginii se închide singur
  const [mobileFor, setMobileFor] = useState<string | null>(null);
  const mobileOpen = mobileFor === path;
  useEffect(() => { const t = setTimeout(() => { try { if (localStorage.getItem(KEY) === "closed") setCollapsed(true); } catch { /* fără stocare locală */ } }, 0); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileFor(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(KEY, n ? "closed" : "open"); } catch { /* alegerea nu se reține */ } return n; });

  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="side" id="sidebar" data-open={mobileOpen} aria-label="Meniu principal">
        <div className="side-head">
          <button type="button" className="side-btn side-rail-btn" onClick={toggle} aria-label={collapsed ? "Deschide meniul" : "Închide meniul"} aria-expanded={!collapsed} aria-controls="sidebar-body" title={collapsed ? "Deschide meniul" : "Închide meniul"}>
            {collapsed ? <Burger /> : <Chevron left />}
          </button>
          <div className="side-brand">
            <div className="brand-mark"><BrandMark size={18} /></div>
            <div className="brand-name" style={{ fontSize: 16, lineHeight: 1.1 }}>Moldovagaz</div>
          </div>
          <button type="button" className="side-btn side-close" onClick={() => setMobileFor(null)} aria-label="Închide meniul"><Chevron left /></button>
        </div>
        <div className="side-body" id="sidebar-body" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setMobileFor(null); }}>
          {nav}
          <div className="side-foot">{who}</div>
        </div>
      </aside>
      {mobileOpen && <div className="side-scrim" onClick={() => setMobileFor(null)} aria-hidden="true" />}
      <div className="main">
        <div className="mbar">
          <button type="button" className="side-btn" onClick={() => setMobileFor(path)} aria-label="Deschide meniul" aria-expanded={mobileOpen} aria-controls="sidebar"><Burger /></button>
          <div className="brand-mark"><BrandMark size={16} /></div>
          <span className="mbar-title">Moldovagaz</span>
        </div>
        {children}
      </div>
    </div>
  );
}
