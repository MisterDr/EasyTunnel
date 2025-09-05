const { Server } = require('ssh2');
const httpProxy = require('http-proxy');
const express = require('express');
const net = require('net');

class TunnelServer {
  constructor() {
    this.tunnels = new Map();
    this.baseDomain = process.env.HTUNNEL_DOMAIN || 'blablabla.me';
    this.publicSshHost = process.env.PUBLIC_SSH_HOST || (this.baseDomain || 'your-server.com');
    const v = String(process.env.HTUNNEL_VERBOSE || process.env.VERBOSE || '').toLowerCase();
    this.verbose = v === '1' || v === 'true' || v === 'yes';
    this.vlog = (...args) => { if (this.verbose) console.log(...args); };
    this.sshServer = new Server({
      hostKeys: [this.generateHostKey()],
      banner: '🚇 HTunnel SSH Server - Tunnel URLs will be displayed after connection\r\n',
      ident: 'SSH-2.0-HTunnel'
    });
    this.proxy = httpProxy.createProxyServer({});
    this.httpServer = express();
    this.setupSSHServer();
    this.setupHTTPProxy();
  }

  generateHostKey() {
    const fs = require('fs');
    const path = require('path');
    
    try {
      const keyPath = path.join(__dirname, 'host_key');
      if (fs.existsSync(keyPath)) {
        const privateKey = fs.readFileSync(keyPath, 'utf8');
        console.log('Loaded persistent SSH host key');
        return privateKey;
      } else {
        console.error('Host key file not found:', keyPath);
        throw new Error('Host key file not found');
      }
    } catch (err) {
      console.error('Failed to load host key:', err);
      throw err;
    }
  }

  generateRandomHostname() {
    const adjectives = ['quick', 'lazy', 'happy', 'clever', 'bright', 'swift', 'calm', 'bold'];
    const animals = ['fox', 'cat', 'dog', 'bear', 'wolf', 'lion', 'tiger', 'eagle'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const number = Math.floor(Math.random() * 1000);
    return `${adj}-${animal}-${number}`;
  }

  sendTunnelInfoToSession(session, client) {
    // Find all tunnels for this client
    const tunnelList = [];
    for (const [hostname, tunnel] of this.tunnels.entries()) {
      if (tunnel.client === client) {
        tunnelList.push(`🌐 https://${hostname}.${this.baseDomain}`);
      }
    }
    
    if (tunnelList.length > 0) {
      const message = `\r\n🚀 Active Tunnels:\r\n${tunnelList.join('\r\n')}\r\n\r\n`;
      try {
        session.write(message);
      } catch (err) {
        console.log('Could not write tunnel info to session');
      }
    }
  }

  setupSSHServer() {
    this.sshServer.on('error', (err) => {
      console.error('SSH Server error:', err);
    });
    
    this.sshServer.on('connection', (client, info) => {
      this.vlog(`SSH Client connected from ${info.ip}:${info.port} (family: ${info.family})`);
      this.vlog('Connection info:', info);
      
      client.on('authentication', (ctx) => {
        this.vlog(`Auth attempt: ${ctx.method} from ${ctx.username || 'anonymous'}`);
        ctx.accept();
      });

      client.on('service', (accept, reject, name) => {
        this.vlog(`Service request received: ${name}`);
        accept();
      });
      
      client.on('error', (err) => {
        console.error('SSH Client error:', err);
      });
      
      client.on('end', () => {
        this.vlog('SSH Client ended connection');
      });
      
      client.on('close', (hadError) => {
        this.vlog(`SSH Client disconnected${hadError ? ' with error' : ' cleanly'}`);
        // Clean up all tunnels for this client
        for (const [hostname, tunnel] of this.tunnels.entries()) {
          if (tunnel.client === client) {
            try { tunnel.server && tunnel.server.close(); } catch {}
            this.tunnels.delete(hostname);
            this.vlog(`Tunnel closed: ${hostname}`);
          }
        }
      });

      client.on('ready', () => {
        this.vlog('SSH Client authenticated and ready');
        
        // Store reference to active session for sending tunnel info later
        client.activeSession = null;
        
        // Handle session requests to send tunnel info to client
        client.on('session', (accept, reject) => {
          this.vlog('Session request received');
          const session = accept();
          if (session) {
            client.activeSession = session;
            
            session.on('pty', (accept, reject) => {
              // Accept PTY to create a pseudo-shell
              const ptyInfo = accept();
              if (ptyInfo) {
                // Send welcome message and any pending tunnel info
                session.write('\r\n🚇 HTunnel - Ready!\r\n');
                
                if (client.pendingTunnelMessage) {
                  session.write(client.pendingTunnelMessage);
                  client.pendingTunnelMessage = null;
                  this.vlog('Sent pending tunnel info to new PTY session');
                }
              }
            });
            
            session.on('shell', (accept, reject) => {
              // Accept shell request
              const stream = accept();
              if (stream) {
                // Welcome message 
                stream.write('\r\n🚇 HTunnel - Ready!\r\n');
                
                // Store stream reference for sending tunnel info
                client.activeStream = stream;
                
                // Send any pending tunnel message
                if (client.pendingTunnelMessage) {
                  stream.write(client.pendingTunnelMessage);
                  client.pendingTunnelMessage = null;
                  this.vlog('Sent pending tunnel info to new shell stream');
                }
                
                // Handle input - allow Ctrl+C to close
                stream.on('data', (data) => {
                  // Check for Ctrl+C (ASCII 3)
                  if (data.length === 1 && data[0] === 3) {
                    stream.write('\r\n🛑 Closing tunnel...\r\n');
                    stream.exit(0);
                    stream.end();
                  } else {
                    // Echo back other input
                    stream.write(data);
                  }
                });
                
                stream.on('close', () => {
                  this.vlog('Shell stream closed');
                });
              }
            });
            
            session.on('exec', (accept, reject) => reject());
            
            session.on('close', () => {
              client.activeSession = null;
            });
          }
        });

        // Listen for rekey events which might give us tunnel information  
        client.on('rekey', () => {
          this.vlog('Client rekey');
        });
        
        // Listen for any additional SSH2 events that might give us tunnel information
        client.on('tcpip-forward', (details) => {
          this.vlog('SSH2 tcpip-forward event:', details);
        });
        
        client.on('forward', (details) => {
          this.vlog('SSH2 forward event:', details);
        });
        
        // Optional: Log tcpip events (not used in our manual forwardOut flow)
        client.on('tcpip', (accept, reject, info) => {
          this.vlog('SSH2 tcpip connection request (info):', info);
          reject && reject();
        });

        client.on('request', (accept, reject, name, info) => {
          this.vlog(`SSH Request: ${name}`, JSON.stringify(info, null, 2));
          this.vlog('All available info keys:', Object.keys(info));
          
          if (name === 'tcpip-forward') {
            this.vlog(`Creating tunnel for bindAddr: ${info.bindAddr}, bindPort: ${info.bindPort}`);
            // Generate hostname for this tunnel
            const hostname = this.generateRandomHostname();

            // Create a local TCP server to receive HTTP proxy connections
            const server = net.createServer((socket) => {
              const srcIP = socket.remoteAddress || '127.0.0.1';
              const srcPort = socket.remotePort || 0;
              const boundAddr = info.bindAddr || '127.0.0.1';

              // We need allocatedPort; delay forwardOut until after it's known
              const doForward = () => {
                const t = this.tunnels.get(hostname);
                if (!t || !t.allocatedPort) {
                  // Try again very shortly (should be immediate after listen callback)
                  return setImmediate(doForward);
                }
                // As ssh2 server, forwardOut opens a 'forwarded-tcpip' channel to the client.
                // Params: forwardOut(boundAddr, boundPort, remoteAddr, remotePort, cb)
                client.forwardOut(boundAddr, t.allocatedPort, srcIP, srcPort, (err, stream) => {
                  if (err) {
                    console.error('forwardOut error:', err);
                    socket.destroy();
                    return;
                  }
                  this.vlog(`forwardOut opened: bound ${boundAddr}:${t.allocatedPort} <- ${srcIP}:${srcPort}`);
                  // Bi-directional piping
                  socket.pipe(stream);
                  stream.pipe(socket);

                  socket.on('error', (e) => {
                    console.error('Tunnel socket error:', e.message);
                    stream.end();
                  });
                  stream.on('error', (e) => {
                    console.error('Tunnel stream error:', e.message);
                    socket.destroy();
                  });
                  socket.on('end', () => this.vlog('Inbound socket ended'));
                  stream.on('end', () => this.vlog('SSH stream ended'));
                  socket.on('close', () => { this.vlog('Inbound socket closed'); stream.end(); });
                  stream.on('close', () => { this.vlog('SSH stream closed'); socket.destroy(); });
                });
              };
              doForward();
            });

            // Listen on an ephemeral local port
            server.listen(0, '127.0.0.1', () => {
              const allocatedPort = server.address().port;

              const tunnelInfo = {
                client,
                bindAddr: info.bindAddr,
                bindPort: info.bindPort,
                hostname,
                allocatedPort,
                server
              };

              this.tunnels.set(hostname, tunnelInfo);

              console.log(`Tunnel created: ${hostname} -> localhost:${allocatedPort} (manual) -> client's ${info.bindAddr}:${info.bindPort || 'remote'}`);
              console.log(`Access your service at: https://${hostname}.${this.baseDomain}`);

              // Inform client in-session
              client.pendingTunnelMessage = `\r\n🚀 Tunnel created: ${hostname}\r\n🌐 Access at: https://${hostname}.${this.baseDomain}\r\n\r\nPress Ctrl+C to close tunnel.\r\n`;
              if (client.activeStream) {
                try { client.activeStream.write(client.pendingTunnelMessage); client.pendingTunnelMessage = null; } catch {}
              } else if (client.activeSession) {
                try { client.activeSession.write(client.pendingTunnelMessage); client.pendingTunnelMessage = null; } catch {}
              }

              // Accept tcpip-forward and, for bindPort=0, return the allocated port
              if (accept) {
                if (info.bindPort === 0) accept(allocatedPort);
                else accept();
              }
            });

            server.on('error', (err) => {
              console.error('Manual server error:', err);
              if (reject) reject();
            });

          } else if (name === 'cancel-tcpip-forward') {
            this.vlog('Cancel tcpip-forward request:', info);
            accept && accept();
            
          } else {
            console.log(`Rejecting unknown request: ${name}`);
            reject && reject();
          }
        });
        
        // SSH2 connections stay alive automatically, no need for manual keepalive
      });

    });
  }

  setupHTTPProxy() {
    this.httpServer.use((req, res) => {
      const host = req.headers.host;
      if (!host) {
        return res.status(400).send('Host header required');
      }

      const hostname = host.split('.')[0];
      const tunnel = this.tunnels.get(hostname);

      if (!tunnel) {
        return res.status(404).send(`Tunnel not found: ${hostname}`);
      }

      if (!tunnel.allocatedPort) {
        return res.status(503).send('Tunnel not ready - no allocated port');
      }

      this.vlog(`HTTP request for tunnel: ${hostname} -> localhost:${tunnel.allocatedPort} (SSH2 managed)`);
      // console.log(`Request protocol: ${req.protocol}, Headers:`, req.headers);
      
      // Proxy to SSH2's allocated port - SSH2 will automatically forward to client's service
      req.url = req.originalUrl;
      this.vlog(`Proxying HTTP request to SSH2 port ${tunnel.allocatedPort}`);
      
      this.proxy.web(req, res, {
        target: `http://127.0.0.1:${tunnel.allocatedPort}`,
        changeOrigin: true,
        secure: false,
        timeout: 30000,
        proxyTimeout: 30000
      }, (err) => {
        if (err) {
          console.error('Proxy error:', err);
          console.error('Error details:', err.message);
          if (!res.headersSent) {
            res.status(502).send('Bad Gateway: ' + err.message);
          }
        }
      });
    });

    this.proxy.on('error', (err, req, res) => {
      console.error('Proxy error:', err);
      if (!res.headersSent) {
        res.status(502).send('Bad Gateway');
      }
    });

    this.proxy.on('proxyRes', (proxyRes, req, res) => {
      try {
        this.vlog(`Upstream response: ${req.headers.host} ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
      } catch {}
    });
  }

  start(sshPort = 2222, httpPort = 8081) {
    this.sshServer.listen(sshPort, () => {
      console.log(`SSH Server listening on port ${sshPort}`);
      console.log(`Usage: ssh -N -p ${sshPort} -R0:localhost:3000 user@${this.publicSshHost}`);
    });

    this.httpServer.listen(httpPort, () => {
      console.log(`HTTP Proxy listening on port ${httpPort}`);
    });
  }
}

module.exports = TunnelServer;
