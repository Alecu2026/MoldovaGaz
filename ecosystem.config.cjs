/**
 * pm2:  pm2 start ecosystem.config.cjs   |   pm2 reload moldovagaz   |   pm2 logs moldovagaz
 *
 * UN SINGUR proces (fork, instances: 1) — intenționat: lista de mesaje din memorie (lib/services/uplink-dataset.ts) e per proces.
 * Cu mai multe instanțe (cluster) aplicația rămâne corectă, dar browserele ar reface mai des descărcarea completă.
 * Variabilele (DATABASE_URL, INGEST_TOKEN…) le citește Next din .env.local din acest director; PORT vine din .env.local sau 3000.
 */
module.exports = {
  apps: [
    {
      name: "moldovagaz",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start",
      exec_mode: "fork",
      instances: 1,
      node_args: "--max-old-space-size=1536",
      env: { NODE_ENV: "production" },
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
