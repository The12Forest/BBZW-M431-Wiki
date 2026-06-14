'use strict';

const sessionId = crypto.randomUUID();

let evtSource = null;
let statusInterval = null;
let countdownInterval = null;
let heartbeatInterval = null;

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const countdownEl = document.getElementById('countdown');
const serverInfo = document.getElementById('server-info');
const serverAddress = document.getElementById('server-address');
const logOutput = document.getElementById('log-output');

function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
}

function appendLog(line) {
    logOutput.textContent += line + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
}

function startCountdown(durationMs) {
    let remaining = Math.floor(durationMs / 1000);
    countdownEl.classList.remove('hidden');

    function render() {
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        countdownEl.textContent = minutes + ':' + String(seconds).padStart(2, '0') + ' remaining';
    }

    render();
    countdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            stopServer();
            return;
        }
        render();
    }, 1000);
}

function resetUI() {
    btnStart.disabled = false;
    btnStop.disabled = true;
    serverInfo.classList.add('hidden');
    countdownEl.classList.add('hidden');
    countdownEl.textContent = '';
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    setStatus('idle', 'Idle');
}

function closeSSE() {
    if (evtSource) {
        evtSource.close();
        evtSource = null;
    }
    if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
    }
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function sendHeartbeat() {
    fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
    });
}

function startServer() {
    btnStart.disabled = true;
    btnStop.disabled = true;
    setStatus('starting', 'Starting…');
    logOutput.textContent = '';

    fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
    })
        .then((res) => {
            if (!res.ok) {
                return res.json().then((data) => {
                    throw new Error(data.error || ('HTTP ' + res.status));
                });
            }
            return res.json();
        })
        .catch((err) => {
            appendLog('[ERROR] ' + err.message);
            setStatus('idle', 'Idle');
            btnStart.disabled = false;
        });

    sendHeartbeat();
    heartbeatInterval = setInterval(sendHeartbeat, 3000);

    evtSource = new EventSource('/api/logs/' + sessionId);
    evtSource.onmessage = (event) => {
        if (event.data === '[SERVER STOPPED]') {
            closeSSE();
            resetUI();
        } else {
            appendLog(event.data);
        }
    };

    statusInterval = setInterval(() => {
        fetch('/api/status/' + sessionId)
            .then((res) => res.json())
            .then((data) => {
                if (data.ready) {
                    clearInterval(statusInterval);
                    statusInterval = null;
                    setStatus('running', 'Running');
                    btnStop.disabled = false;
                    serverAddress.textContent = 'mc.wnw.li:' + data.port;
                    serverInfo.classList.remove('hidden');
                    startCountdown(2 * 60 * 60 * 1000);
                }
            });
    }, 3000);
}

function stopServer() {
    setStatus('stopping', 'Stopping…');
    btnStop.disabled = true;
    closeSSE();

    fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
    });

    resetUI();
}

btnStart.addEventListener('click', startServer);
btnStop.addEventListener('click', stopServer);

window.addEventListener('beforeunload', () => {
    navigator.sendBeacon('/api/beacon', JSON.stringify({ sessionId }));
    closeSSE();
});
