module.exports = {
  apps: [
    // ── Webhook service (always-on) ───────────────────────────────────────────
    {
      name: 'growthngen-caller',
      script: 'src/app.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ── Scheduled calling sessions (Mon–Fri AEST) ─────────────────────────────
    // Will picks up any contacts with hs_lead_status = MAKE_CALL twice a day.
    // cron_restart times are UTC: 10:05 AEST = 00:05 UTC, 13:05 AEST = 03:05 UTC.
    // autorestart: false — PM2 runs the script once per cron tick, does not loop.
    {
      name: 'will-session-1005',
      script: 'src/scripts/triggerBatch.js',
      cron_restart: '5 0 * * 1-5',
      autorestart: false,
      args: '--lead-status SDR_QUEUE --max 20 --agent will',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/will-1005-error.log',
      out_file: 'logs/will-1005-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'will-session-1305',
      script: 'src/scripts/triggerBatch.js',
      cron_restart: '5 3 * * 1-5',
      autorestart: false,
      args: '--lead-status SDR_QUEUE --max 20 --agent will',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/will-1305-error.log',
      out_file: 'logs/will-1305-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
