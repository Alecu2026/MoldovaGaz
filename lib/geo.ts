/**
 * Funcții pure pentru hartă (fără DOM, fără Leaflet): proiecția Web Mercator (aceeași ca la dalele OpenStreetMap / Leaflet), gruparea punctelor în bule
 * pentru un nivel de zoom și linkurile către aplicațiile de navigație. Le rulează și scripts/check-engine.ts.
 */
export const TILE = 256;
export const worldSize = (zoom: number): number => TILE * Math.pow(2, zoom);

/** Longitudine → pixel X în „lumea” de la acel zoom. */
export const mercX = (lon: number, size: number): number => ((lon + 180) / 360) * size;
/** Latitudine → pixel Y în „lumea” de la acel zoom (limitat la ±85,05° ca la dale). */
export function mercY(lat: number, size: number): number {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
}
export const lonFromX = (x: number, size: number): number => (x / size) * 360 - 180;
export function latFromY(y: number, size: number): number {
  const n = Math.PI - (2 * Math.PI * y) / size;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export type Clusters = {
  zoom: number;
  n: number;
  /** poziția bulei în pixeli de „lume” la `zoom` (media punctelor din ea) */
  x: Float64Array;
  y: Float64Array;
  cnt: Int32Array;
  /** un punct reprezentant (indice în coloanele listei); la bulele cu un singur punct e chiar el */
  rep: Int32Array;
};

/**
 * Grupează punctele (`idx` = indecșii rândurilor filtrate; cei fără coordonate se sar) în celule pătrate de `cell` pixeli la `zoom`.
 * Celulele sunt ancorate în „lume”, nu în ecran: la deplasarea hărții bulele NU se schimbă, doar la schimbarea zoom-ului. Cost: o trecere, O(n).
 * `cell` = 0 ⇒ fără grupare pe ecran, DAR punctele din ACELAȘI loc (aceleași coordonate, la ~1 m) rămân o singură bulă cu numărătoare: altfel, de ex. 12 contoare
 * de la aceeași adresă s-ar desena unul peste altul și ar părea unul singur, oricât te-ai apropia (zoom-ul nu le poate despărți).
 */
export function buildClusters(la: ArrayLike<number>, lo: ArrayLike<number>, idx: ArrayLike<number>, zoom: number, cell: number): Clusters {
  const size = worldSize(zoom);
  const m = idx.length;
  const x = new Float64Array(m), y = new Float64Array(m);
  const cnt = new Int32Array(m), rep = new Int32Array(m);
  let n = 0;
  if (cell <= 0) {
    const spot = new Map<number, number>();
    for (let k = 0; k < m; k++) {
      const i = idx[k], a = la[i], b = lo[i];
      if (a !== a || b !== b) continue;
      const key = spotKey(a, b), c = spot.get(key);
      if (c === undefined) { spot.set(key, n); x[n] = mercX(b, size); y[n] = mercY(a, size); cnt[n] = 1; rep[n] = i; n++; }
      else cnt[c]++;
    }
    return { zoom, n, x, y, cnt, rep };
  }
  const cols = Math.ceil(size / cell);
  const cellOf = new Map<number, number>();
  for (let k = 0; k < m; k++) {
    const i = idx[k], a = la[i], b = lo[i];
    if (a !== a || b !== b) continue;
    const px = mercX(b, size), py = mercY(a, size);
    const key = Math.floor(py / cell) * cols + Math.floor(px / cell);
    const c = cellOf.get(key);
    if (c === undefined) {
      cellOf.set(key, n);
      x[n] = px; y[n] = py; cnt[n] = 1; rep[n] = i; n++;
    } else {
      x[c] += px; y[c] += py; cnt[c]++;
    }
  }
  for (let c = 0; c < n; c++) if (cnt[c] > 1) { x[c] /= cnt[c]; y[c] /= cnt[c]; }
  return { zoom, n, x, y, cnt, rep };
}

/** Cheie numerică pentru „același loc”: coordonatele rotunjite la 1e-5° (~1 m). */
export const spotKey = (a: number, b: number): number => Math.round(a * 1e5) * 40_000_000 + Math.round(b * 1e5);

/** Toate punctele (indici din `idx`) din același loc cu punctul `at` — contoarele de la aceeași adresă / același GPS. */
export function samePlace(la: ArrayLike<number>, lo: ArrayLike<number>, idx: ArrayLike<number>, at: number): number[] {
  const key = spotKey(la[at], lo[at]), out: number[] = [];
  for (let k = 0; k < idx.length; k++) { const i = idx[k]; if (la[i] === la[i] && lo[i] === lo[i] && spotKey(la[i], lo[i]) === key) out.push(i); }
  return out;
}

/** Limitele geografice ale punctelor: [latMin, lonMin, latMax, lonMax], sau null dacă nu e niciunul cu coordonate. */
export function boundsOf(la: ArrayLike<number>, lo: ArrayLike<number>, idx: ArrayLike<number>): [number, number, number, number] | null {
  let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], a = la[i], b = lo[i];
    if (a !== a || b !== b) continue;
    if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  return a0 === Infinity ? null : [a0, b0, a1, b1];
}

const fix = (v: number) => v.toFixed(6);

/** Linkuri care deschid locația în aplicațiile de navigație (pe telefon se deschide aplicația, dacă e instalată; pe PC, versiunea web). */
export function mapLinks(lat: number, lon: number): { google: string; waze: string; apple: string; osm: string } {
  const ll = `${fix(lat)},${fix(lon)}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes&zoom=17`,
    apple: `https://maps.apple.com/?daddr=${ll}&dirflg=d`,
    osm: `https://www.openstreetmap.org/?mlat=${fix(lat)}&mlon=${fix(lon)}#map=18/${fix(lat)}/${fix(lon)}`,
  };
}

/** La fel, dar după adresă (când contorul n-are coordonate). Adresa pleacă spre aplicația aleasă DOAR la click. */
export function addressLinks(address: string): { google: string; waze: string; apple: string } {
  const q = encodeURIComponent(address);
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
    apple: `https://maps.apple.com/?q=${q}`,
  };
}

const RAD = Math.PI / 180;
/** distanța pe sferă între două puncte, în km */
export function distanceKm(a1: number, o1: number, a2: number, o2: number): number {
  const dLa = (a2 - a1) * RAD, dLo = (o2 - o1) * RAD;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a1 * RAD) * Math.cos(a2 * RAD) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
