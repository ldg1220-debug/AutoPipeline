module.exports = {
  apps: [
    {
      name: 'autopipeline',
      script: 'src/app.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
    },
  ],
};
