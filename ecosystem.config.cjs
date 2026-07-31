const fs = require('node:fs');
const path = require('node:path');

const logDirectory = path.join(__dirname, 'data', 'logs');
fs.mkdirSync(logDirectory, { recursive: true });

module.exports = {
  apps: [
    {
      name: 'vaultback',
      cwd: __dirname,
      script: 'dist/main.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 5000,
      out_file: path.join(logDirectory, 'vaultback-out.log'),
      error_file: path.join(logDirectory, 'vaultback-error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      env: {
        UPDATE_PM2_APP: 'vaultback'
      }
    }
  ]
};
