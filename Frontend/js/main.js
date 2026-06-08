const socket = io();
const sessionId = Math.random().toString(36).slice(2, 11);

let serverActive    = false; // true after Start is clicked
let serverConfirmed = false; // true after server-ready received — safe to rejoin on reconnect

const logOutput    = document.getElementById('log-output');
const serverInfoEl = document.getElementById('server-info');
const serverAddr   = document.getElementById('server-address');
const startBtn     = document.getElementById('btn-start');
const stopBtn      = document.getElementById('btn-stop');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const countdown    = document.getElementById('countdown');

let countdownInterval = null;

function startCountdown() {
    clearInterval(countdownInterval);
    const endsAt = Date.now() + 30 * 60 * 1000;
    countdown.classList.remove('hidden');
    countdownInterval = setInterval(() => {
        const remaining = Math.max(0, endsAt - Date.now());
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        countdown.textContent = `${m}:${String(s).padStart(2, '0')} remaining`;
        if (remaining === 0) clearInterval(countdownInterval);
    }, 1000);
}

function stopCountdown() {
    clearInterval(countdownInterval);
    countdown.classList.add('hidden');
    countdown.textContent = '';
}

// ── Controls ─────────────────────────────────────────────────────────────────

startBtn.addEventListener('click', () => {
    logOutput.textContent = '';
    serverInfoEl.classList.add('hidden');
    setStatus('starting');
    startBtn.disabled = true;
    serverActive = true;
    socket.emit('start-mc-server', { sessionId });
});

stopBtn.addEventListener('click', () => {
    setStatus('stopping');
    stopBtn.disabled = true;
    socket.emit('stop-mc-server');
});

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('mc-log', line => addLog(line));

socket.on('server-ready', ({ ip, port }) => {
    serverConfirmed = true;
    serverAddr.textContent = `${ip}:${port}`;
    serverInfoEl.classList.remove('hidden');
    stopBtn.disabled = false;
    setStatus('running');
    startCountdown();
    addLog(`\n✔ Server ready — connect with: ${ip}:${port}`);
});

socket.on('server-error', msg => {
    addLog(`\n✖ ${msg}`);
    setStatus('idle');
    startBtn.disabled = false;
    serverActive = false;
});

socket.on('server-stopped', () => {
    serverInfoEl.classList.add('hidden');
    setStatus('idle');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    serverActive    = false;
    serverConfirmed = false;
    stopCountdown();
    addLog('\n— Server stopped —');
});

// On reconnect: only rejoin if the server was confirmed running.
// If Start was clicked but server-ready hasn't arrived yet, the buffered
// start-mc-server event will reach the server on its own — no double-emit needed.
socket.on('connect', () => {
    if (serverConfirmed) {
        socket.emit('rejoin-session', { sessionId });
    }
});

// Signal an intentional disconnect immediately so the server's grace period
// is short (5s) rather than waiting for the ping timeout (30s).
window.addEventListener('beforeunload', () => socket.disconnect());

// ── Helpers ───────────────────────────────────────────────────────────────────

function addLog(line) {
    logOutput.textContent += line + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
}

function setStatus(state) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = { idle: 'Idle', starting: 'Starting…', running: 'Running', stopping: 'Stopping…' }[state] || state;
}
