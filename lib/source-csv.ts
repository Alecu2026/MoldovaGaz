import type { SourceStore } from "./source-store";

const esc = (s: string) => (/[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Rândurile filtrate → CSV (separator „;” și BOM, ca să se deschidă corect în Excel cu setări românești). Momentele sunt ISO, în UTC.
 * Coloanele cu date personale (consumator, adresă, cont…) NU se exportă — la fel ca exportul din pagina principală.
 */
export function sourceToCsv(st: SourceStore, idx: Int32Array): string {
  const cols = st.cols.filter((c) => !c.pii);
  const lines: string[] = [cols.map((c) => esc(c.label)).join(";")];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    lines.push(
      cols
        .map((c) => {
          if (c.kind === "date") {
            const t = st.nums[c.key][i];
            return t === t ? new Date(t).toISOString() : "";
          }
          return esc(st.text(i, c));
        })
        .join(";"),
    );
  }
  return "﻿" + lines.join("\r\n");
}
