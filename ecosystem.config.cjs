/**
 * pm2:  pm2 start ecosystem.config.cjs   |   pm2 reload moldovagaz   |   pm2 logs moldovagaz
 *
 * UN SINGUR proces (fork, instances: 1) — intenționat: lista de mesaje din memorie (lib/services/uplink-dataset.ts) e per proces.
 * Cu mai multe instanțe (cluster) aplicația rămâne corectă, dar browserele ar reface mai des descărcarea completă.
 *
 * Portul: Next NU citește PORT din .env.local (serverul HTTP pornește înainte de încărcarea fișierelor .env), deci îl citim noi de acolo
 * și îl dăm explicit cu `-p`. Dacă pe același server rulează și alt proiect, pune alt PORT în .env.local (ex. 3001) și un alt `name`
 * dacă îl copiezi. Restul variabilelor (DATABASE_URL, INGEST_TOKEN…) le citește Next din .env.local.
 */
const fs = require("node:fs");
const path = require("node:path");

function envPort() {
  try {
    const m = fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").match(/^\s*PORT\s*=\s*"?(\d+)"?\s*$/m);
    if (m) return m[1];
  } catch {}
  return process.env.PORT || "3000";
}
const PORT = envPort();

module.exports = {
  apps: [
    {
      name: "moldovagaz",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${PORT}`,
      exec_mode: "fork",
      instances: 1,
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
  ],
};
