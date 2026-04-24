module.exports = {
  apps: [
    {
      name: 'vpn-backend',
      script: 'dist/main.js',
      cwd: '/opt/vpn-service/backend',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
