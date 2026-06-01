import { spawn } from 'child_process';
import path from 'path';
import log from './../../function/log.js';

const console = { log: log('MinecraftSocket') };
let io_instance = null;

// Konfiguration
const MAX_SERVERS = 4;
const START_PORT = 25565; // Server 1: 25565, Server 2: 25566, etc.
const MINECRAFT_TIMEOUT_MS = 30 * 60 * 1000; // 30 Minuten
const LOG_PREFIX = "[MC-Host] ";

// Hier speichern wir die aktiven Server
// Struktur: { [gameId]: { process, timeoutId, port, playerId } }
let activeServers = {};

function setupSocket(io) {
    io_instance = io;

    io.on('connection', (socket) => {

        socket.on('join-game', (data) => {
            const { gameId, playerId } = data;

            socket.gameId = gameId;
            socket.playerId = playerId;
            socket.join(`game-${gameId}`);

            // 1. Fall: Server für dieses Game läuft bereits
            if (activeServers[gameId]) {
                const currentPort = activeServers[gameId].port;
                socket.emit('mc-log', `--- Du wurdest mit dem laufenden Server verbunden (Port: ${currentPort}) ---`);
                return;
            }

            // 2. Fall: Maximales Server-Limit erreicht
            const currentServerCount = Object.keys(activeServers).length;
            if (currentServerCount >= MAX_SERVERS) {
                console.log(LOG_PREFIX + `Anfrage abgelehnt. Maximum von ${MAX_SERVERS} Servern erreicht.`);
                socket.emit('mc-log', `[SYSTEM] Alle Server-Slots belegt (${MAX_SERVERS}/${MAX_SERVERS}). Bitte warte, bis ein Server frei wird.`);
                return;
            }

            // 3. Fall: Freien Port finden (25565, 25566, 25567, 25568)
            const assignedPort = findFreePort();
            if (!assignedPort) {
                socket.emit('mc-log', `[SYSTEM] Fehler: Kein freier Port verfügbar.`);
                return;
            }

            console.log(LOG_PREFIX + `Starte Server für Game ${gameId} auf Port ${assignedPort}...`);
            socket.emit('mc-log', `[SYSTEM] Server wird gestartet auf Port ${assignedPort}...`);

            // Minecraft Server starten und den Port als Argument übergeben (--port)
            // WICHTIG: Jeder Server sollte idealerweise in einem eigenen Unterordner oder mit separaten Welt-Ordnern laufen,
            // wenn sie parallel existieren sollen. Hier nutzen wir einen gemeinsamen Ordner, übergeben aber den Port.
            const minecraftProcess = spawn('java', [
                '-Xmx2G', 
                '-Xms2G', 
                '-jar', 'server.jar', 
                'nogui', 
                '--port', assignedPort.toString() // Erzwingt den dynamischen Port
            ], {
                cwd: path.resolve('./minecraft-server-folder'), 
            });

            // Server im State registrieren
            activeServers[gameId] = {
                process: minecraftProcess,
                timeoutId: null,
                port: assignedPort,
                playerId: playerId
            };

            // 30-Minuten-Timer starten
            startServerTimeout(gameId);

            // Realtime Logs an den Client senden
            minecraftProcess.stdout.on('data', (data) => {
                io.to(`game-${gameId}`).emit('mc-log', data.toString());
            });

            minecraftProcess.stderr.on('data', (data) => {
                io.to(`game-${gameId}`).emit('mc-log', `[ERROR] ${data.toString()}`);
            });

            // Wenn der Server beendet wird (egal ob durch 'stop' oder Crash)
            minecraftProcess.on('close', (code) => {
                console.log(LOG_PREFIX + `Server für Game ${gameId} (Port ${assignedPort}) geschlossen. Code: ${code}`);
                io.to(`game-${gameId}`).emit('mc-log', `--- Server gestoppt (Port: ${assignedPort}) ---`);
                
                if (activeServers[gameId]) {
                    clearTimeout(activeServers[gameId].timeoutId);
                    delete activeServers[gameId];
                }
            });
        });

        // Befehle aus dem Web-Interface an die MC-Konsole senden
        socket.on('send-command', (command) => {
            const serverInfo = activeServers[socket.gameId];
            if (serverInfo && serverInfo.process) {
                serverInfo.process.stdin.write(command + '\n');
            }
        });

        // Tab geschlossen / Disconnect -> Server stoppen
        socket.on('disconnect', () => {
            if (socket.gameId && activeServers[socket.gameId]) {
                console.log(LOG_PREFIX + `Spieler ${socket.playerId} hat den Tab geschlossen. Stoppe Server...`);
                stopMinecraftServer(socket.gameId, "Client Disconnect");
            }
        });
    });
}

// Hilfsfunktion: Findet den ersten freien Port im erlaubten Bereich
function findFreePort() {
    const usedPorts = Object.values(activeServers).map(s => s.port);
    for (let i = 0; i < MAX_SERVERS; i++) {
        const testPort = START_PORT + i;
        if (!usedPorts.includes(testPort)) {
            return testPort;
        }
    }
    return null;
}

// Minecraft Server sauber beenden
function stopMinecraftServer(gameId, reason) {
    const serverInfo = activeServers[gameId];
    if (serverInfo && serverInfo.process) {
        console.log(LOG_PREFIX + `Stoppe Server ${gameId} (Port ${serverInfo.port}). Grund: ${reason}`);
        
        if (serverInfo.timeoutId) clearTimeout(serverInfo.timeoutId);

        // Befehl zum Speichern und Schließen senden
        serverInfo.process.stdin.write('stop\n');

        // Notfall-Kill, falls der Server hängt
        setTimeout(() => {
            if (activeServers[gameId]) {
                console.log(LOG_PREFIX + `Server auf Port ${serverInfo.port} reagiert nicht. Erzwinge SIGKILL...`);
                serverInfo.process.kill('SIGKILL');
                delete activeServers[gameId];
            }
        }, 10000);
    }
}

// 30-Minuten-Timeout Timer
function startServerTimeout(gameId) {
    if (!activeServers[gameId]) return;

    activeServers[gameId].timeoutId = setTimeout(() => {
        console.log(LOG_PREFIX + `Timeout: 30 Minuten abgelaufen für Game ${gameId}.`);
        stopMinecraftServer(gameId, "30-Minuten-Limit erreicht");
    }, MINECRAFT_TIMEOUT_MS);
}

export { setupSocket, activeServers, io_instance };