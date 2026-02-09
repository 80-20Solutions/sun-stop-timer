import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, exec } from 'node:child_process';
import https from 'node:https';
import os from 'os';
import fs from 'fs';
import readline from 'readline';

// Cloudflare tunnel binary management
const CF_URLS = {
    'win32-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'darwin-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
    'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
    'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
};

const ensureCloudflared = async (onProgress) => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binDir = process.pkg ? dirname(process.execPath) : process.cwd();
    const binPath = join(binDir, `cloudflared${ext}`);

    if (fs.existsSync(binPath)) return binPath;

    const key = `${process.platform}-${process.arch}`;
    const url = CF_URLS[key];
    if (!url) throw new Error(`Unsupported platform: ${key}`);

    console.log('Downloading cloudflared...');
    if (onProgress) onProgress(0, 0);

    await new Promise((resolve, reject) => {
        const download = (downloadUrl) => {
            https.get(downloadUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    download(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }

                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                let lastEmit = 0;

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    const now = Date.now();
                    if (onProgress && (now - lastEmit > 300 || downloadedBytes === totalBytes)) {
                        lastEmit = now;
                        onProgress(downloadedBytes, totalBytes);
                    }
                });

                const ws = fs.createWriteStream(binPath);
                res.pipe(ws);
                ws.on('finish', () => { ws.close(resolve); });
                ws.on('error', reject);
            }).on('error', reject);
        };
        download(url);
    });

    if (process.platform !== 'win32') {
        fs.chmodSync(binPath, 0o755);
    }
    console.log('Cloudflared downloaded to', binPath);
    return binPath;
};

// Works in both ESM (dev) and CJS bundle (pkg)
const APP_ROOT = (() => {
    try {
        return dirname(fileURLToPath(import.meta.url));
    } catch {
        return typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    }
})();

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const staticPath = join(APP_ROOT, 'dist');
app.use(express.static(staticPath));

// --- TIMER STATE ---
let state = {
    timeLeft: 0,
    status: 'IDLE',
    overtimeMode: 'COUNT_UP',
    lastTick: Date.now()
};

let timerInterval = null;

const clearTimer = () => {
    clearTimeout(timerInterval);
    timerInterval = null;
};

const tick = () => {
    if (state.status !== 'RUNNING') return;

    const now = Date.now();
    const elapsed = Math.floor((now - state.lastTick) / 1000);

    if (elapsed >= 1) {
        state.timeLeft -= elapsed;
        state.lastTick = now;

        if (state.timeLeft <= 0 && state.overtimeMode === 'STOP') {
            state.status = 'FINISHED';
            state.timeLeft = 0;
            clearTimer();
        }

        io.emit('timer-update', state);
    }

    if (state.status === 'RUNNING') {
        timerInterval = setTimeout(tick, 200);
    }
};

// --- SERVER INFO & TUNNEL ---
const PORT = 3000;
let serverInfo = { port: PORT, hostname: os.hostname(), addresses: [] };
let activeTunnel = null;

const updateServerInfo = (port) => {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    Object.values(interfaces).forEach(ifaceList => {
        ifaceList.forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        });
    });
    serverInfo = { port, hostname: os.hostname(), addresses };
};

// --- DEBUG LOGGING ---
const logStream = fs.createWriteStream('./debug.log', { flags: 'a' });
const log = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] ${msg}\n`);
    console.log(...args);
};

// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('timer-update', state);
    socket.emit('server-info', serverInfo);

    socket.on('set-time', (seconds) => {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
        const clamped = Math.max(-5999, Math.min(5999, Math.round(seconds)));
        state.timeLeft = clamped;
        state.status = 'IDLE';
        clearTimer();
        io.emit('timer-update', state);
    });

    socket.on('start', () => {
        if (state.status !== 'RUNNING' && (state.timeLeft !== 0 || state.status === 'PAUSED')) {
            state.status = 'RUNNING';
            state.lastTick = Date.now();
            if (!timerInterval) timerInterval = setTimeout(tick, 200);
            io.emit('timer-update', state);
        }
    });

    socket.on('pause', () => {
        state.status = 'PAUSED';
        clearTimer();
        io.emit('timer-update', state);
    });

    socket.on('stop', () => {
        state.status = 'IDLE';
        state.timeLeft = 0;
        clearTimer();
        io.emit('timer-update', state);
    });

    socket.on('set-mode', (mode) => {
        if (mode !== 'COUNT_UP' && mode !== 'STOP') return;
        state.overtimeMode = mode;
        io.emit('timer-update', state);
    });

    socket.on('shutdown', () => {
        log('Shutdown requested from client');
        clearTimer();
        io.emit('server-shutdown');
        setTimeout(() => {
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 2000);
        }, 500);
    });

    // Internet tunnel (Cloudflare) - downloads binary at runtime
    socket.on('start-tunnel', async () => {
        log('Tunnel requested');
        if (activeTunnel) {
            socket.emit('tunnel-status', { url: activeTunnel.url });
            return;
        }
        try {
            socket.emit('tunnel-status', { url: null, downloading: true });
            const cfPath = await ensureCloudflared((downloaded, total) => {
                io.emit('tunnel-download-progress', { downloaded, total });
            });
            log('Cloudflared binary at:', cfPath);
            const child = spawn(cfPath, ['tunnel', '--url', `http://localhost:${serverInfo.port}`]);

            const tunnelUrl = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Tunnel timeout (30s)')), 30000);
                const handler = (data) => {
                    const output = data.toString();
                    log('cloudflared:', output.trim());
                    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
                    if (match) {
                        clearTimeout(timeout);
                        resolve(match[0]);
                    }
                };
                child.stdout.on('data', handler);
                child.stderr.on('data', handler);
                child.on('error', (err) => { clearTimeout(timeout); reject(err); });
                child.on('exit', (code) => {
                    clearTimeout(timeout);
                    reject(new Error(`cloudflared exited with code ${code}`));
                });
            });

            log('Tunnel opened:', tunnelUrl);
            activeTunnel = { url: tunnelUrl, child };
            io.emit('tunnel-status', { url: tunnelUrl });

            child.on('exit', () => {
                log('Tunnel process exited');
                activeTunnel = null;
                io.emit('tunnel-status', { url: null });
            });
        } catch (err) {
            log('Tunnel error:', err.message);
            socket.emit('tunnel-status', { url: null, error: err.message });
        }
    });

    socket.on('stop-tunnel', () => {
        if (activeTunnel) {
            activeTunnel.child.kill();
            activeTunnel = null;
            io.emit('tunnel-status', { url: null });
        }
    });

    socket.on('set-and-start', (seconds) => {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
        const clamped = Math.max(-5999, Math.min(5999, Math.round(seconds)));
        state.timeLeft = clamped;
        state.status = 'RUNNING';
        state.lastTick = Date.now();
        clearTimer();
        timerInterval = setTimeout(tick, 200);
        io.emit('timer-update', state);
    });
});

// --- BROWSER OPENER ---
const openBrowser = (url) => {
    if (process.platform === 'win32') {
        exec(`start msedge --app="${url}"`, (err) => {
            if (err) exec(`start chrome --app="${url}"`, (err2) => {
                if (err2) exec(`start "" "${url}"`);
            });
        });
    } else if (process.platform === 'darwin') {
        exec(`open -a "Google Chrome" --args --app="${url}"`, (err) => {
            if (err) exec(`open "${url}"`);
        });
    } else {
        exec(`google-chrome --app="${url}"`, (err) => {
            if (err) exec(`xdg-open "${url}"`);
        });
    }
};

// --- ERROR HANDLING ---
process.on('uncaughtException', (err) => {
    log('CRITICAL ERROR:', err.message, err.stack);
    console.error('CRITICAL ERROR:', err);
    console.log('Window will close in 60 seconds...');
    setTimeout(() => process.exit(1), 60000);
});

// KEEP-ALIVE
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (input) => { log(`Command received: ${input}`); });

console.log('Sun Stop Timer Starting...');
log('Starting application...');

// --- START SERVER ---
const MAX_PORT_RETRIES = 10;

const startServer = (port, retriesLeft = MAX_PORT_RETRIES) => {
    const serverInstance = server.listen(port, async () => {
        console.log('---------------------------------------------------');
        console.log(`Sun Stop Timer Running on Port ${port}!`);
        console.log('---------------------------------------------------');

        updateServerInfo(port);

        const interfaces = os.networkInterfaces();
        const hostname = os.hostname();
        const localUrl = `http://localhost:${port}`;
        const staticUrl = `http://${hostname}.local:${port}`;

        console.log(`\n>>> STATIC LINK: ${staticUrl}`);
        console.log(`\n>>> LAN LINK:`);
        Object.keys(interfaces).forEach((ifname) => {
            interfaces[ifname].forEach((iface) => {
                if ('IPv4' !== iface.family || iface.internal !== false) return;
                console.log(`    http://${iface.address}:${port}`);
            });
        });
        console.log('\n---------------------------------------------------');
        console.log('Opening browser...');

        try { openBrowser(localUrl); } catch (err) { console.error('Failed to open browser:', err); }
    });

    serverInstance.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            if (retriesLeft <= 0) {
                console.error(`Failed to find an available port after ${MAX_PORT_RETRIES} retries.`);
                process.exit(1);
            }
            console.log(`Port ${port} is busy, trying ${port + 1}...`);
            serverInstance.close(() => startServer(port + 1, retriesLeft - 1));
        } else {
            console.error('Server error:', err);
        }
    });
};

startServer(PORT);
