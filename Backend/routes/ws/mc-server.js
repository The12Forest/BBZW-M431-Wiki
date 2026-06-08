import { spawn } from 'child_process';
import { readdirSync, rmSync } from 'fs';
import path from 'path';
import log from './../../function/log.js';

const console = { log: log('MCServer') };

const START_PORT  = 25570;
const END_PORT    = 25590;
const MAX_SERVERS = END_PORT - START_PORT + 1;
const TIMEOUT_MS  = 30 * 60 * 1000;
const SERVER_DIR  = './Servers';
const PUBLIC_IP   = process.env.PUBLIC_IP || 'wiki.wnw.li';

// { [sessionId]: { process, port, worldDir, ready, timeoutId, stopTimer } }
const activeServers = {};

function findJar() {
    try {
        const files = readdirSync(path.resolve(SERVER_DIR));
        return files.find(f => f === 'server.jar' || (f.startsWith('paper') && f.endsWith('.jar'))) || 'server.jar';
    } catch { return 'server.jar'; }
}

function findFreePort() {
    const used = new Set(Object.values(activeServers).map(s => s.port));
    for (let p = START_PORT; p <= END_PORT; p++) {
        if (!used.has(p)) return p;
    }
    return null;
}

function gracefulStop(sessionId) {
    const s = activeServers[sessionId];
    if (!s) return;
    clearTimeout(s.timeoutId);
    clearTimeout(s.stopTimer);
    s.timeoutId = null;
    s.stopTimer = null;
    try { s.process.stdin.write('stop\n'); } catch {}
    setTimeout(() => {
        if (activeServers[sessionId] === s) {
            try { s.process.kill('SIGKILL'); } catch {}
        }
    }, 10000);
}

function cancelStopTimer(sessionId) {
    const s = activeServers[sessionId];
    if (s?.stopTimer) { clearTimeout(s.stopTimer); s.stopTimer = null; }
}

export function setupMcSocket(io) {
    io.on('connection', socket => {

        // ── Start (or re-attach to) a server ────────────────────────────
        socket.on('start-mc-server', ({ sessionId }) => {
            socket.sessionId = sessionId;
            socket.join(`mc:${sessionId}`);

            // Session already running — just re-attach
            if (activeServers[sessionId]) {
                cancelStopTimer(sessionId);
                const { ready, port } = activeServers[sessionId];
                socket.emit('mc-log', '--- Reconnected to running server ---');
                if (ready) socket.emit('server-ready', { ip: PUBLIC_IP, port });
                return;
            }

            if (Object.keys(activeServers).length >= MAX_SERVERS) {
                socket.emit('server-error', `All ${MAX_SERVERS} slots are full. Try again later.`);
                return;
            }
            const port = findFreePort();
            if (!port) { socket.emit('server-error', 'No free port available.'); return; }

            const jar      = findJar();
            const worldDir = path.resolve(SERVER_DIR, 'worlds', sessionId);

            console.log(`Starting session ${sessionId} on port ${port} (${jar})`);
            socket.emit('mc-log', `[SYSTEM] Starting server on port ${port}...`);

            const proc = spawn('java', [
                '-Xmx2G', '-Xms512M',
                '-Dlog4j2.contextSelector=org.apache.logging.log4j.core.selector.BasicContextSelector',
                '-jar', jar, 'nogui',
                '--port', String(port),
                '--world-container', worldDir,
            ], { cwd: path.resolve(SERVER_DIR) });

            const entry = { process: proc, port, worldDir, ready: false, timeoutId: null, stopTimer: null };
            activeServers[sessionId] = entry;

            entry.timeoutId = setTimeout(() => {
                io.to(`mc:${sessionId}`).emit('mc-log', '[SYSTEM] 30-minute limit reached. Shutting down...');
                gracefulStop(sessionId);
            }, TIMEOUT_MS);

            function onLine(raw) {
                const line = raw.trimEnd();
                if (!line) return;
                io.to(`mc:${sessionId}`).emit('mc-log', line);

                if (!entry.ready && line.includes('Done (')) {
                    entry.ready = true;
                    io.to(`mc:${sessionId}`).emit('server-ready', { ip: PUBLIC_IP, port });
                }

                const join = line.match(/\]: (\w+)\[\/[\d.:]+\] logged in/)
                          || line.match(/\]: (\w+) joined the game/);
                if (join) {
                    console.log(`Auto-opping ${join[1]}`);
                    try { proc.stdin.write(`op ${join[1]}\n`); } catch {}
                }
            }

            proc.stdout.on('data', d => d.toString().split('\n').forEach(onLine));
            proc.stderr.on('data', d => d.toString().split('\n').forEach(onLine));

            // Only clean up when the process actually exits
            proc.on('close', code => {
                console.log(`Session ${sessionId} closed (code ${code})`);
                if (activeServers[sessionId] === entry) {
                    clearTimeout(entry.timeoutId);
                    clearTimeout(entry.stopTimer);
                    try { rmSync(worldDir, { recursive: true, force: true }); } catch {}
                    delete activeServers[sessionId];
                }
                io.to(`mc:${sessionId}`).emit('mc-log', '--- Server stopped ---');
                io.to(`mc:${sessionId}`).emit('server-stopped');
            });
        });

        // ── Rejoin an existing session (never starts a server) ───────────
        socket.on('rejoin-session', ({ sessionId }) => {
            const s = activeServers[sessionId];
            if (!s) { socket.emit('server-stopped'); return; }
            cancelStopTimer(sessionId);
            socket.sessionId = sessionId;
            socket.join(`mc:${sessionId}`);
            socket.emit('mc-log', '--- Reconnected ---');
            if (s.ready) socket.emit('server-ready', { ip: PUBLIC_IP, port: s.port });
        });

        // ── Explicit stop ────────────────────────────────────────────────
        socket.on('stop-mc-server', () => {
            if (socket.sessionId) gracefulStop(socket.sessionId);
        });

        // ── Disconnect: grace period before killing ──────────────────────
        socket.on('disconnect', reason => {
            const sid = socket.sessionId;
            if (!sid || !activeServers[sid]) return;
            // Explicit tab-close via beforeunload gets a short grace;
            // transport drops (network blip) get 30s to reconnect.
            const grace = reason === 'client namespace disconnect' ? 5000 : 30000;
            activeServers[sid].stopTimer = setTimeout(() => {
                const room = io.sockets.adapter.rooms.get(`mc:${sid}`);
                if (!room || room.size === 0) gracefulStop(sid);
            }, grace);
        });
    });
}
