module.exports = {
  apps: [
    {
      name: "mini-crm",
      cwd: "/var/www/mini-crm-products",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--dns-result-order=ipv4first",
      },
    },
    {
      name: "mini-crm-bot",
      cwd: "/var/www/mini-crm-products/apps/telegram-bot",
      script: "dist/index.js",
      interpreter: "node",
      stop_exit_codes: [0],
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--dns-result-order=ipv4first",
        ENABLE_BOT_WARMUP: "true",
        PORT: "3100",
        BOT_HOST: "127.0.0.1",
      },
    },
  ],
};
