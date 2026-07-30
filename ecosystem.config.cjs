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
      env: {
        NODE_ENV: 'production',
        UPDATE_PM2_APP: 'vaultback'
      }
    }
  ]
};
