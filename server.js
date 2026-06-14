import express from 'express';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT       = path.dirname(fileURLToPath(import.meta.url));
const PAPER_JAR  = path.join(ROOT, 'paper-1.21.11-132.jar');
const PLUGIN_JAR = path.join(ROOT, 'OneBlock-1.1.3.jar');
const CERT_PATH  = path.join(ROOT, 'Cert', 'cert.pem');
const KEY_PATH   = path.join(ROOT, 'Cert', 'key.pem');
const MAX_SESSIONS = 4;
const TIMEOUT_MS   = 2 * 60 * 60 * 1000;   // 2 hours
const LOG_BUF_MAX  = 500;
const HEARTBEAT_TIMEOUT_MS = 8_000;
const HEARTBEAT_SWEEP_MS   = 2_000;
const PORT_MIN     = 25570;
const PORT_MAX     = 25665;
const HTTPS_PORT   = parseInt(process.env.PORT ?? '3001', 10);

/** @type {Map<string, {
 *   proc: import('node:child_process').ChildProcess,
 *   port: number,
 *   tmpDir: string,
 *   sseRes: import('express').Response | null,
 *   logBuffer: string[],
 *   ready: boolean,
 *   timeoutId: NodeJS.Timeout,
 *   lastHeartbeat: number,
 * }>} */
const sessions = new Map();

function allocatePort() {
    const used = new Set([...sessions.values()].map((s) => s.port));
    for (let port = PORT_MIN; port <= PORT_MAX; port++) {
        if (!used.has(port)) return port;
    }
    return null;
}

function cleanup(tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

function sendSSE(session, data) {
    if (session.sseRes) {
        session.sseRes.write(`data: ${data}\n\n`);
    }
}

function bufferLine(session, line) {
    session.logBuffer.push(line);
    if (session.logBuffer.length > LOG_BUF_MAX) session.logBuffer.shift();
    sendSSE(session, line);
}

function killSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    clearTimeout(session.timeoutId);

    sessions.delete(sessionId);

    if (session.sseRes) {
        session.sseRes.write('data: [SERVER STOPPED]\n\n');
        session.sseRes.end();
        session.sseRes = null;
    }

    try {
        session.proc.stdin.write('stop\n');
    } catch {
        // process may already be gone
    }

    let killed = false;
    const hardKill = setTimeout(() => {
        killed = true;
        session.proc.kill('SIGKILL');
        cleanup(session.tmpDir);
    }, 10_000);

    session.proc.once('close', () => {
        if (killed) return;
        clearTimeout(hardKill);
        cleanup(session.tmpDir);
    });
}

function handleLine(session, sessionId, line) {
    bufferLine(session, line);

    if (!session.ready && line.includes('Done (')) {
        session.ready = true;
    }

    const loginMatch = line.match(/^\[.*\]: (\S+)\[.*\] logged in with entity id/);
    if (loginMatch) {
        try {
            session.proc.stdin.write(`op ${loginMatch[1]}\n`);
        } catch {
            // ignore if stdin already closed
        }
    }
}

function makeLineHandler(session, sessionId) {
    let carry = '';
    return (chunk) => {
        carry += chunk.toString();
        const lines = carry.split('\n');
        carry = lines.pop();
        for (const line of lines) {
            handleLine(session, sessionId, line);
        }
    };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.post('/api/start', (req, res) => {
    const { sessionId } = req.body ?? {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    if (sessions.has(sessionId)) {
        return res.status(409).json({ error: 'Session already running' });
    }
    if (sessions.size >= MAX_SESSIONS) {
        return res.status(503).json({ error: 'Server limit reached' });
    }

    const port = allocatePort();
    if (port === null) {
        return res.status(503).json({ error: 'No free port available' });
    }

    const tmpDir = path.join('/tmp', `mc-${sessionId}`);
    const pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');

    const properties = [
        `server-port=${port}`,
        'online-mode=false',
        'max-players=5',
        'level-name=world',
        'motd=OneBlock Demo @ mc.wnw.li',
        'spawn-protection=0',
        'op-permission-level=4',
        'enable-rcon=false',
        'enable-query=false',
        'view-distance=6',
        'simulation-distance=4',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), properties);

    fs.copyFileSync(PLUGIN_JAR, path.join(pluginsDir, 'OneBlock-1.1.3.jar'));

    const proc = spawn('java', [
        '-Xmx1G', '-Xms512M', '-XX:+UseG1GC',
        '-jar', PAPER_JAR, 'nogui', '--port', String(port),
    ], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });

    const session = {
        proc,
        port,
        tmpDir,
        sseRes: null,
        logBuffer: [],
        ready: false,
        timeoutId: null,
        lastHeartbeat: Date.now(),
    };
    sessions.set(sessionId, session);

    session.timeoutId = setTimeout(() => killSession(sessionId), TIMEOUT_MS);

    const lineHandler = makeLineHandler(session, sessionId);
    proc.stdout.on('data', lineHandler);
    proc.stderr.on('data', lineHandler);

    proc.on('close', () => {
        if (sessions.has(sessionId)) killSession(sessionId);
    });

    res.json({ port });
});

app.post('/api/heartbeat', (req, res) => {
    const { sessionId } = req.body ?? {};
    const session = sessions.get(sessionId);
    if (session) session.lastHeartbeat = Date.now();
    res.status(204).end();
});

app.post('/api/stop', (req, res) => {
    const { sessionId } = req.body ?? {};
    killSession(sessionId);
    res.json({ ok: true });
});

app.post('/api/beacon', (req, res) => {
    const { sessionId } = req.body ?? {};
    killSession(sessionId);
    res.status(204).end();
});

app.get('/api/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.json({ running: false, port: null, ready: false });
    res.json({ running: true, port: session.port, ready: session.ready });
});

app.get('/api/logs/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).end();

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.flushHeaders();

    for (const line of session.logBuffer) {
        res.write(`data: ${line}\n\n`);
    }

    session.sseRes = res;

    req.on('close', () => {
        session.sseRes = null;
    });
});

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
        if (now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
            killSession(sessionId);
        }
    }
}, HEARTBEAT_SWEEP_MS);

https.createServer({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
}, app).listen(HTTPS_PORT, () => console.log('HTTPS :' + HTTPS_PORT));
