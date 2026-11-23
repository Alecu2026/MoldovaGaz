# Moldovagaz — contoare de gaz LoRaWAN

Next.js 16 (App Router, Cache Components) + MongoDB. Arată contoarele de gaz Moldovagaz din SCADA (≈69.000, cele 10 filiale) într-un tabel, pe hartă și într-un tablou de grafice, cu totaluri, filtre și sortare **instant**, iar pentru fiecare contor istoricul **Volume (m³)**.

## Sursele de date

| Sursă | Ce aduce |
|---|---|
| **SCADA** (ThingsBoard, `iiot.scada.md` / `192.168.77.24:8080`) | **lista contoarelor** (dispozitivele celor 10 clienți de gaz, fără `Defectate_*`: vezi [lib/meter-scope.ts](lib/meter-scope.ts)), valorile curente (`Volume_m3_Total`, `Volume_m3_Total_ts`, **coordonate** `latitude` / `longitude`, RSSI/SNR, baterie, consumuri…), atributele și **istoricul** |
| `getmgdb` (`http://192.168.77.11:3880/getmgdb`) | facturarea: **filiala (FIL)**, cont (ACCT_ID), **număr radio**, adresă, consumator, secție, controlor… |

**Legătura facturare ↔ dispozitiv:** `NUM_RADIO` (8 cifre) = seria din numele dispozitivului (`S2154_00070948_2022` → `00070948`). **Filiala:** codul `FIL` din facturare (01 Chișinău, 05 Comrat, 10 Edineț, 11 Cahul, 20 Orhei, 27 Taraclia, 31 Florești, 33 Cimișlia, 35 Ștefan Vodă, 36 Ialoveni); contoarele fără facturare primesc filiala clientului lor din SCADA (fiecare filială are un client: `ComratGaz_DashGroup`, `OrheiGaz_DashGroup`…). Cheile LoRaWAN (APPKEY / NWKSKEY / APPSKEY) **nu** se copiază niciodată în aplicație.

## Trei pagini

| Pagină | Adresă | Ce arată |
|---|---|---|
| **Contoare** (principala) | `/` | contoarele din SCADA **combinate** cu facturarea: volum, coordonate, semnal, baterie, stare, cu hartă și istoric |
| **Dispozitive LoRaWAN** | `/lorawan` | **doar** datele din lorawandb (`http://192.168.77.11:3880/lorawandb`), exact cum le dă sursa: nume, profil, etichetă, client, data creării (+ serie / model / an extrase din nume, serii repetate). Nu are volum, coordonate sau semnal; lista poate fi în urma SCADA |
| **Facturare** | `/facturare` | **doar** datele din getmgdb: consumator, adresă, filială, număr radio, serie contor, cont, secție, cod abonat, data actualizării… — toate rândurile (și cele fără contor în SCADA) |

Paginile pe sursă au aceleași instrumente ca pagina principală: căutare cu mai multe cuvinte, filtru sub fiecare antet de coloană și „Mai multe filtre” pentru restul câmpurilor, filtre active ca etichete cu ✕ (în URL), totaluri, sortare pe orice coloană, grafice (click pe bară filtrează, glisarea alege un interval de timp), detalii pe rând cu toate câmpurile și export CSV (fără datele personale). Coloanele sunt definite în [lib/source-schemas.ts](lib/source-schemas.ts); câmpurile necunoscute din getmgdb apar singure ca coloane text în detalii. Din detalii poți sări la pagina principală (`/?name=…` sau `/?q=<număr radio>`).

## Sincronizarea

Înainte de valorile din SCADA, sincronizarea salvează și **rândurile brute** din lorawandb și getmgdb în colecțiile `src_lorawan` și `src_billing` ([lib/source-sync.ts](lib/source-sync.ts)): paginile pe sursă rămân la zi chiar dacă SCADA nu răspunde. Se scriu doar rândurile schimbate (hash pe conținut); din lorawandb se păstrează doar câmpurile de identificare (**fără** `deviceData` și chei LoRaWAN). Lista contoarelor din aplicație NU vine din lorawandb, ci din SCADA. Serverul ține lista în memorie (gzip, ETag = amprenta datelor), iar browserul o păstrează în IndexedDB și o verifică la 60 s (304 când nu s-a schimbat nimic).

`scripts/sync-meters.ts` (pm2: `<nume>-sync`, o dată pe oră, la minutul 0): citește facturarea (getmgdb), lista contoarelor din SCADA (pe client, pagini de 1000) și valorile curente (loturi de 500), cu o **pauză între cereri** (`TB_PAUSE_MS`, implicit 150 ms) ca încărcarea serverului SCADA să rămână mică. Combină totul și scrie în colecția `meters` **doar contoarele ale căror date s-au schimbat** (hash pe conținut). Contoarele care nu mai sunt în SCADA se șterg (cu plasă de siguranță dacă dispar prea multe deodată). **Doar citire** din SCADA: clientul refuză orice apel în afară de login, interogări și citiri de liste / serii. Fără `TB_URL` nu pleacă nicio cerere.

```bash
npm run sync:meters                       # sincronizare completă
npm run sync:meters -- --dry              # doar citește și combină; afișează statistici (nu scrie nimic)
npm run sync:meters -- --dry --out f.json # la fel, + salvează documentele într-un fișier
npm run sync:meters -- --load f.json      # scrie documentele din fișier (fără rețea) — încărcare inițială
npm run sync:meters -- --patch-geo        # completează coordonatele pe documentele existente, din atributele lor (fără rețea)
npm run sync:sources                      # doar rândurile brute din lorawandb + getmgdb → `src_lorawan` / `src_billing` (fără SCADA)
npm run sync:sources -- --dry             # le citește și numără, fără să scrie nimic
npm run check                             # verifică filtrele, agregările, actualizările pe loc și combinarea (date sintetice)
```

## Pornire locală

```bash
npm install
npm run seed:user -- admin@exemplu.md ParolaPuternica "Nume" super_admin   # primul cont (colecția users)
npm run dev                                                               # http://localhost:3000
```

`.env.local` (nu se comite; model în [.env.example](.env.example)): `DATABASE_URL`, `TB_USER`, `TB_PASS` (+ opțional `TB_URL`, `LORAWAN_DB_URL`, `MG_DB_URL`, `PORT`, `PM2_NAME`, `INSECURE_COOKIES`, `MONGO_DNS_SERVERS`).

## Producție (server cu pm2, din GitHub)

Pe server: Node 20+, `git`, `pm2` (`npm i -g pm2`).

```bash
git clone https://github.com/Alecu2026/MoldovaGaz.git && cd MoldovaGaz
cp .env.example .env.local && nano .env.local   # DATABASE_URL, TB_USER, TB_PASS, PORT, PM2_NAME
npm ci && npm run seed:user -- admin@exemplu.md ParolaPuternica "Nume" super_admin
./deploy/deploy.sh                               # git pull, npm ci (doar dacă s-au schimbat dependențele), build, pm2 start/reload
pm2 startup && pm2 save                          # pornire automată după reboot
```

[ecosystem.config.js](ecosystem.config.js) pornește trei procese: aplicația (un singur proces, intenționat: lista din memorie e per proces), `<nume>-sync` (sincronizarea, o dată pe oră) și `<nume>-autodeploy` (la un minut face `git fetch` și, dacă există commit nou, rulează [deploy/deploy.sh](deploy/deploy.sh); la build eșuat revine la commit-ul anterior). Fără secrete în GitHub și fără SSH spre server. Variantă alternativă: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) (GitHub Actions + SSH) — nu o folosi împreună cu `autodeploy`.

**Rețea:** serverul trebuie să ajungă la SCADA (`TB_URL`, de preferat adresa internă `http://192.168.77.24:8080`) și la lorawandb / getmgdb din LAN. `TB_URL` e obligatoriu: fără el nu se face nicio cerere către SCADA. Exemplu nginx: [deploy/nginx.conf.example](deploy/nginx.conf.example).

**Alt proiect pe același server:** `PORT` și `PM2_NAME` diferite în `.env.local`, un record DNS `A` pentru subdomeniu, un site nginx nou (`proxy_pass` spre portul ales) și certificat (`certbot --nginx -d subdomeniu`). Cookie-urile sunt per subdomeniu.

## Cum e făcut să meargă instant

Același model ca „tasks” din StefanPWA, adaptat la rânduri care se modifică pe loc:

1. **Server (memorie)** — `lib/services/meter-dataset.ts`. Lista, coloanar, în memoria procesului. La fiecare cerere se verifică o *amprentă* ieftină din Mongo (total + ultimul `updatedAt`); dacă s-a schimbat, se aduc **doar** documentele modificate și se suprascriu rândurile (fiecare modificare primește un `seq`). Gzip-ul se face o dată și se memorează pe versiune. `ETag = generație.seq` → `304` fără corp.
2. **Browser, IndexedDB** — vectorii tipizați se salvează ca atare; la deschidere lista apare din cache local, fără `JSON.parse`.
3. **Browser, memorie** — obiectul `MeterStore` rămâne cât timp fila e deschisă.
4. **Sincronizare incrementală** — `/api/meters/delta?after=<seq>` întoarce doar contoarele modificate (zero rânduri = câteva zeci de octeți). „Live” = o întrebare la 30 s cât timp fila e vizibilă.
5. **Virtualizare** — în DOM stau ~20 de rânduri, indiferent de număr; filtrarea / sortarea rulează într-o trecere peste vectori tipizați (câțiva ms).
6. Prima pictare vine din HTML (primele 40 de rânduri) și, dacă browserul are deja versiunea curentă, **nu se face nicio cerere**.
7. **Istoricul** unui contor nu intră în listă: se citește din ThingsBoard doar când deschizi contorul (`/api/meters/<id>/history`, doar citire, 60 s în memorie).

## Filtre și grafice

- **Filtre** (toate optimiste, combinabile; între filtre diferite ȘI, între valorile aceluiași filtru SAU): căutare liberă (nume contor, devEUI, număr radio, cont, adresă, consumator), **filială**, oraș, profil, stare (alerte / offline / baterie / inactiv / buton / magnet), perioada ultimei citiri (presetată sau personalizată) și, în „Mai multe filtre”: aplicație, concentrator, tip mesaj, frecvență, fPort, model, an / cod lot, facturare, intervale pentru **Volume (m³)**, consum zilnic, baterie, RSSI, SNR și fCnt. Filtrele active apar ca etichete cu ✕ și se păstrează în URL.
- **Grafice** (fila „Grafice”, același filtru ca tabelul): contoare după ultima citire, stare și alerte, contoare și **volum pe filială**, orașe, profile, aplicații, concentratoare, tipuri de mesaj, histograme pentru Volume / consum zilnic / baterie / RSSI / SNR, harta RSSI × SNR, frecvențe, fPort, model, an, ora și ziua ultimei citiri, prospețimea citirilor și topul consumurilor. Click pe o bară filtrează, glisarea alege un interval, contextul „toate” rămâne în gri, iar „Tabel” de pe fiecare card arată datele.
- **Hartă** (fila „Hartă”, aceleași filtre ca tabelul): toate contoarele cu coordonate (latitude / longitude din atributele ThingsBoard, ~64% dintre contoare), colorate după stare, semnal, vechimea citirii sau baterie. Punctele se desenează pe un singur canvas și se grupează în bule (O(n), ~2 ms la 44.000 de puncte, recalculat doar la schimbarea zoom-ului): zoom și deplasare la 60 fps. Click pe o bulă = zoom, click pe un punct = popup cu datele contorului și butoane Google Maps / Waze / Apple Hărți. Harta de bază: dale OpenStreetMap (browserele utilizatorilor le cer direct de la tile.openstreetmap.org; pentru trafic mare folosește un furnizor de dale propriu).
- **Detaliu contor** (click pe rând): **harta proprie a contorului** cu butoane de navigare (Google Maps, Waze, Apple Hărți, OpenStreetMap), Volume (m³) cu consum pe zi / oră din `Volume_m3_Total_ts`, facturare completă, ThingsBoard, ultima telemetrie, atribute, JSON.

## Limite și date personale

- Facturarea conține **date personale** (nume consumator, adresă). Ele ajung în browserul utilizatorilor autentificați (căutare instant) și în IndexedDB-ul lor; se șterg la „Ieșire”. Exportul CSV **nu** le include. Dă acces doar persoanelor autorizate.
- Un singur proces Node (`next start`): `gen`-ul listei e per proces; cu mai multe instanțe totul rămâne corect, dar browserul reface mai des descărcarea completă.
- `Volume_m3_Total` negativ (date eronate la unele contoare) nu intră în grafice și în sume.
