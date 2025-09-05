const TunnelServer = require('./server');

const server = new TunnelServer();

const sshPort = process.env.SSH_PORT || 2222;
const httpPort = process.env.HTTP_PORT || 8081;

server.start(sshPort, httpPort);

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});