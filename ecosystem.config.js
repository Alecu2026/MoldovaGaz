/**
 * pm2:  pm2 startOrReload ecosystem.config.js   |   pm2 logs <nume>   |   pm2 status
 *
 * Trei aplicații:
 *  1. aplicația Next (un SINGUR proces, fork — intenționat: lista de contoare din memorie e per proces; în cluster ar fi mai multe copii);
 *  2. „<nume>-sync”: la 10 minute rulează scripts/sync-meters.ts (lista și valorile din SCADA + getmgdb → colecția `meters`; scrie doar contoarele modificate);
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
      node_args: "--max-old-space-size=1536",
      env: { NODE_ENV: "production", PORT },
      autorestart: true,
      max_memory_restart: "1800M",
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
      cron_restart: "*/10 * * * *",
      watch: false,
      time: true,
      merge_logs: true,
      out_file: "logs/sync.log",
      error_file: "logs/sync.log",
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
