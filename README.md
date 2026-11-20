# Moldovagaz — mesaje LoRaWAN

Next.js 16 (App Router, Cache Components) + MongoDB. Primește uplink-urile ChirpStack / Jooby și le arată într-un tabel cu totaluri, filtre și sortare **instant**, chiar și cu sute de mii de rânduri.

## Pornire

```bash
npm install
npm run seed:user     # creează test@gmail.com / parola123 în colecția `users`
npm run dev           # http://localhost:3000
```

`.env.local` (nu se comite):

| variabilă | rol |
|---|---|
| `DATABASE_URL` | conexiunea MongoDB (baza `moldovagaz`) |
| `INGEST_TOKEN` | secretul pentru `POST /api/ingest` |
| `UPLINK_WINDOW_DAYS` (30) / `UPLINK_MAX_ROWS` (300000) | fereastra de date ținută în memorie |
| `USERS_COLLECTION` / `SESSIONS_COLLECTION` / `UPLINKS_COLLECTION` | numele colecțiilor (implicit `users`, `sessions`, `uplinks`) |
| `INSECURE_COOKIES=1` | doar dacă rulezi `npm start` pe HTTP, în afara `localhost` |
| `MONGO_DNS_SERVERS` | DNS-ul folosit ca fallback când routerul refuză interogările SRV ale `mongodb+srv://` (implicit `1.1.1.1,8.8.8.8`) |

## Producție (server cu pm2, din GitHub)

Pe server: Node 20+, `git`, `pm2` (`npm i -g pm2`).

```bash
git clone https://github.com/Alecu2026/MoldovaGaz.git && cd MoldovaGaz
cp .env.example .env.local && nano .env.local   # DATABASE_URL, INGEST_TOKEN (+ INSECURE_COOKIES=1 doar fără HTTPS)
npm ci && npm run seed:user -- admin@exemplu.md ParolaPuternica "Nume"   # primul cont (nu folosi parola de test!)
./deploy/deploy.sh                               # git pull, npm ci, build, pm2 start/reload
pm2 startup && pm2 save                          # pornire automată după reboot
```

Actualizare ulterioară: `./deploy/deploy.sh`. Config pm2: [ecosystem.config.cjs](ecosystem.config.cjs) (un singur proces, intenționat). Exemplu nginx: [deploy/nginx.conf.example](deploy/nginx.conf.example).

**Înainte de producție:** schimbă/șterge contul `test@gmail.com` (parolă publică în acest README) și lasă HTTPS activ — cookie-ul de sesiune e `Secure`.

## Primirea datelor

```
POST /api/ingest
Authorization: Bearer <INGEST_TOKEN>      (sau X-Ingest-Token: <INGEST_TOKEN>)
```

Corp: un obiect JSON, o listă, sau NDJSON. Formatul poate varia (mai multe gateway-uri, `object` lipsă, alte tipuri de `decoded`): se păstrează payload-ul original întreg, iar coloanele din tabel se extrag defensiv. Retrimiterea aceluiași mesaj nu creează dubluri. Răspuns: `{ received, inserted, duplicates, rejected }`.

În ChirpStack (integrarea HTTP) pune URL-ul `https://<server>/api/ingest` și antetul `Authorization: Bearer …`. Evenimentele care nu sunt `up` (`?event=join|ack|status…`) sunt ignorate cu 200.

```bash
curl -X POST http://localhost:3000/api/ingest -H "Authorization: Bearer $INGEST_TOKEN" --data-binary @scripts/sample-uplink.json
```

## Cum e făcut să meargă instant

Același model ca „tasks” din StefanPWA, adaptat la date doar-adăugare:

1. **Server (memorie)** — `lib/services/uplink-dataset.ts`. Lista, coloanar, în memoria procesului. La fiecare cerere se verifică o *amprentă* ieftină din Mongo (total estimat + ultimul `receivedAt`); dacă s-a schimbat, se aduc **doar** documentele noi și se adaugă la coadă (nu se recitește colecția). Gzip-ul se face o dată și se memorează pe versiune. `ETag = generație.poziție` → `304` fără corp.
2. **Browser, IndexedDB** — vectorii tipizați se salvează ca atare; la deschidere lista apare din cache local, fără `JSON.parse`.
3. **Browser, memorie** — obiectul `UplinkStore` rămâne cât timp fila e deschisă.
4. **Sincronizare incrementală** — `/api/uplinks/delta?after=<poziție>` întoarce doar mesajele noi (zero rânduri = câțiva zeci de octeți). „Live” = o întrebare la 10 s cât timp fila e vizibilă.
5. **Virtualizare** — în DOM stau ~25 de rânduri, indiferent de număr; filtrarea/sortarea rulează într-o trecere peste vectori tipizați (câțiva ms la 300.000 de rânduri).
6. Prima pictare vine din HTML (primele 40 de rânduri) și, dacă browserul are deja versiunea curentă, **nu se face nicio cerere**.

Verificări: `npm run bench` (motorul pe 300.000 de rânduri sintetice, în memorie).

## Limite de știut

- **Fereastra**: în memorie stau ultimele `UPLINK_WINDOW_DAYS` zile / `UPLINK_MAX_ROWS` rânduri; „Total” arată și câte sunt în baza de date. Istoricul mai vechi există în Mongo, dar nu se vede încă în tabel (ar cere interogări pe server).
- **Un singur proces Node** (`next start`): `gen`-ul listei e per proces. Pe serverless sau cu mai multe instanțe totul rămâne corect, dar browserul reface mai des descărcarea completă.
- **Spațiu în Mongo**: un mesaj ocupă ~1–2 KB (payload-ul original). Clusterul Atlas M0 are 512 MB **partajați cu celelalte baze**; planifică retenție (ex. index TTL pe `receivedAt`) sau un cluster mai mare înainte de volum real.
- `scripts/seed-demo.ts` generează date sintetice, dar doar într-o colecție de test (refuză colecția reală).
