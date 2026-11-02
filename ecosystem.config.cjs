// pm2 alternative to Docker:
//   npm run build && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "outreach-agent",
      script: "dist/index.js",
      env: { NODE_ENV: "production", OPEN_BROWSER: "false" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: "500M",
    },
  ],
};
