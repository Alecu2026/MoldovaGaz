/**
 * pm2:  pm2 startOrReload ecosystem.config.js   |   pm2 logs <nume>   |   pm2 status
 *
 * Trei aplicații:
 *  1. aplicația Next (un SINGUR proces, fork — intenționat: lista de contoare din memorie e per proces; în cluster ar fi mai multe copii);
 *  2. „<nume>-sync”: o dată pe oră (minutul 0) rulează scripts/sync-meters.ts (lista și valorile din SCADA + getmgdb → colecția `meters`; scrie doar contoarele modificate);
 *  2b. „<nume>-report”: pe 1 ale lunii la 07:00 rulează scripts/monthly-report.ts (raportul cu ultima citire a fiecărui contor la 1 ale lunii ora 07:00, CSV în REPORT_OUT_DIR, pentru facturare);
 *  2d. „<nume>-antennas”: scripts/pull-antennas.ts aduce din SCADA antenele (gateway-uri) pentru ecranul instalatorului de antene (/antene); pozele lor doar cu ANTENNA_PHOTO_PULL=1;
 *  2c. „<nume>-photos”: scripts/pull-photos.ts extrage din SCADA pozele contoarelor (atributul `image`), le micșorează și le scrie în PHOTO_DIR; pornește doar cu PHOTO_PULL=1 (în fiecare zi la 22:00, reluabil);
 *  3. „<nume>-autodeploy”: o dată pe minut verifică GitHub-ul (deploy/auto-deploy.sh) și, dacă există commit nou pe branch, face deploy
 *     (git pull, npm ci doar dacă s-au schimbat dependențele, build, reload; la build eșuat revine la commit-ul anterior).
 *     Nu e nevoie de webhook sau de SSH dinspre GitHub, deci merge și pe un server din rețeaua locală.
 *
 * Numele și portul se citesc din .env.local: PM2_NAME (implicit „moldovagaz”) și PORT (implicit 3000). Next NU citește PORT din .env.local
 * (serverul HTTP pornește înainte să se încarce fișierele .env), de aceea îl dăm noi explicit cu `-p`.
 * Restul variabilelor (DATABASE_URL, TB_USER, TB_PASS…) le citește Next din .env.local.
 */
const fs = require("node:fs");
const path = require("node:path");

function fromEnvFile(key, fallback) {
  try {
    // o linie „CHEIE=valoare” (cu sau fără ghilimele, spații, comentariu la final)
    for (const line of fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
      const v = line.slice(eq + 1).split(" #")[0].trim().replace(/^"(.*)"$/, "$1");
      if (v) return v;
    }
  } catch {}
  return process.env[key] || fallback;
}
const NAME = fromEnvFile("PM2_NAME", "moldovagaz");
const PORT = fromEnvFile("PORT", "3000");

module.exports = {
  apps: [
    {
      name: NAME,
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${PORT}`,
      exec_mode: "fork",
      instances: 1,
      watch: false, // în producție fișierele nu se urmăresc: deploy-ul face reload controlat
      node_args: "--max-old-space-size=3072", // lista de contoare + profilurile de noapte + codificările ocupă ~1,3 GB; la 1,5 GB colectorul de memorie bloca aplicația
      env: { NODE_ENV: "production", PORT },
      autorestart: true,
      max_memory_restart: "3500M",
      min_uptime: "10s",
      max_restarts: 20,
      restart_delay: 3000,
      kill_timeout: 8000,
      time: true,
      merge_logs: true,
      out_file: "logs/out.log",
      error_file: "logs/error.log",
    },
    {
      name: `${NAME}-sync`,
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/sync-meters.ts",
      exec_mode: "fork",
      instances: 1,
      autorestart: false, // rulează o dată și iese; pm2 îl repornește după cron_restart
      cron_restart: "0 * * * *", // o dată pe oră, la minutul 0
      watch: false,
      time: true,
      merge_logs: true,
      out_file: "logs/sync.log",
      error_file: "logs/sync.log",
    },
    {
      name: `${NAME}-report`,
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/monthly-report.ts",
      exec_mode: "fork",
      instances: 1,
      autorestart: false, // rulează o dată și iese; pm2 îl repornește după cron_restart
      cron_restart: "0 7 1 * *", // pe 1 ale lunii, la 07:00 (ora serverului): raportul de citiri al lunii precedente, pentru facturare
      watch: false,
      time: true,
      merge_logs: true,
      out_file: "logs/report.log",
      error_file: "logs/report.log",
    },
    {
      name: `${NAME}-antennas`,
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/pull-antennas.ts",
      exec_mode: "fork",
      instances: 1,
      autorestart: false, // rulează până termină și iese; pm2 îl repornește după cron_restart
      cron_restart: "30 22 * * *", // în fiecare zi la 22:30: antenele din SCADA (atribute; pozele doar cu ANTENNA_PHOTO_PULL=1 în .env.local)
      watch: false,
      time: true,
      merge_logs: true,
      out_file: "logs/antennas.log",
      error_file: "logs/antennas.log",
    },
    {
      name: `${NAME}-photos`,
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/pull-photos.ts",
      exec_mode: "fork",
      instances: 1,
      autorestart: false, // rulează până termină și iese; pm2 îl repornește după cron_restart
      cron_restart: "0 22 * * *", // în fiecare zi la 22:00: contoarele noi / fără stare (prima rulare le ia pe toate); pornește doar cu PHOTO_PULL=1 în .env.local
      watch: false,
      time: true,
      merge_logs: true,
      out_file: "logs/photos.log",
      error_file: "logs/photos.log",
    },
    {
      name: `${NAME}-autodeploy`,
      cwd: __dirname,
      script: "deploy/auto-deploy.sh",
      interpreter: "bash",
      exec_mode: "fork",
      instances: 1,
      autorestart: false, // rulează o dată și iese; pm2 îl repornește după cron_restart
      cron_restart: "* * * * *",
      watch: false,
      time: true,
      merge_logs: true,
      out_file: "logs/auto-deploy.log",
      error_file: "logs/auto-deploy.log",
    },
  ],
};
