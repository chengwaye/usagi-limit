/**
 * PM2 Ecosystem — 烏薩奇漲停版每日更新
 *
 * 用法：
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs usagi-daily
 *   pm2 delete usagi-daily
 *
 * 排程：每個交易日 15:30（台灣時間 = UTC+8）
 * PM2 cron 用 UTC 時間：15:30 TST = 07:30 UTC
 */

module.exports = {
  apps: [
    {
      name: "usagi-daily",
      script: "daily-update.mjs",
      cwd: "D:\\claude-auto\\usagi-limit",
      cron_restart: "30 7 * * 1-5", // UTC 07:30 = TST 15:30, Mon-Fri
      autorestart: false,            // 跑完就結束，不要自動重啟
      watch: false,
      max_restarts: 0,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
