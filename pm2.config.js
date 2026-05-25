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
    // Will runs at :05, Kate runs at :15 — 10-minute offset prevents overlap.
    // --filter-by-agent scopes each session's HubSpot query:
    //   will  → sdr_assigned_agent = 'will' OR unassigned (Will is the default agent)
    //   kate  → sdr_assigned_agent = 'kate' only
    // cron times are UTC: AEST = UTC+10 (no DST — server is UTC).
    //   10:05 AEST = 00:05 UTC  |  10:15 AEST = 00:15 UTC
    //   13:05 AEST = 03:05 UTC  |  13:15 AEST = 03:15 UTC
    // autorestart: false — PM2 runs the script once per cron tick, does not loop.
    {
      name: 'will-session-1005',
      script: 'src/scripts/triggerBatch.js',
      cron_restart: '5 0 * * 1-5',
      autorestart: false,
      args: '--lead-status SDR_QUEUE --max 20 --agent will --filter-by-agent will',
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
      args: '--lead-status SDR_QUEUE --max 20 --agent will --filter-by-agent will',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/will-1305-error.log',
      out_file: 'logs/will-1305-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ── Kate sessions (10 min after Will — staggered to avoid HubSpot query overlap)
    {
      name: 'kate-session-1015',
      script: 'src/scripts/triggerBatch.js',
      cron_restart: '15 0 * * 1-5',
      autorestart: false,
      args: '--lead-status SDR_QUEUE --max 20 --agent kate --filter-by-agent kate',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/kate-1015-error.log',
      out_file: 'logs/kate-1015-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'kate-session-1315',
      script: 'src/scripts/triggerBatch.js',
      cron_restart: '15 3 * * 1-5',
      autorestart: false,
      args: '--lead-status SDR_QUEUE --max 20 --agent kate --filter-by-agent kate',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/kate-1315-error.log',
      out_file: 'logs/kate-1315-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
