module.exports = {
  apps: [
    {
      name: 'socialadlinker',
      script: './src/server.js',
      instances: 1, // Keep 1 for single-EC2 in-memory rate limits; scale with Nginx sticky sessions + Redis if needed
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true
    }
  ]
};

