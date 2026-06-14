# Technische Dokumentation: BBZW-M431-Wiki (OneBlock Wiki + Live Server Launcher)

Dieses Dokument beschreibt die technische Implementierung der Webanwendung. Es geht
Datei für Datei durch das Projekt und erklärt Aufbau, Zweck und Funktionsweise.

---

## Projektstruktur

```
project-root/
├── server.js              ← Express/HTTPS Backend (ESM, Single-File)
├── package.json           ← Projekt-Metadaten & Abhängigkeiten
├── public/                 ← statisch ausgelieferte Frontend-Dateien
│   ├── index.html          ← Wiki-Seite (alle Inhalte)
│   ├── style.css           ← Dark-Theme Styling
│   └── app.js               ← Frontend-Logik für den "Live Demo"-Launcher
├── Cert/
│   ├── cert.pem            ← Symlink auf Let's-Encrypt fullchain.pem
│   └── key.pem             ← Symlink auf Let's-Encrypt privkey.pem
├── paper-1.21.11-132.jar   ← Paper Minecraft-Server JAR (Basis für Demo-Server)
└── OneBlock-1.1.3.jar      ← OneBlock-Plugin JAR (wird in jede Demo-Instanz kopiert)
```

Keine Frontend-Frameworks: nur Vanilla HTML/CSS/JS. Einzige Backend-Abhängigkeit:
`express`.

---

## package.json

```json
{
  "name": "bbzw-m431-wiki",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^5.2.1"
  }
}
```

- `"type": "module"` → das Backend verwendet ES-Module-Syntax (`import`/`export`).
- `npm start` startet den Server normal, `npm run dev` startet ihn mit
  `--watch` (automatischer Neustart bei Dateiänderungen).
- Express ist die einzige Laufzeit-Abhängigkeit: kein Socket.IO, kein Frontend-Build-Schritt.

---

## server.js

Einzelne Datei, die das gesamte Backend implementiert: statischer Webserver für
`public/`, HTTPS-Terminierung und eine REST/SSE-API zum Starten, Überwachen und
Stoppen von temporären Minecraft-Demo-Servern.

### Konstanten (Zeilen 8–20)

| Konstante | Wert | Zweck |
|---|---|---|
| `ROOT` | Verzeichnis dieser Datei | Basis für alle relativen Pfade |
| `PAPER_JAR` | `paper-1.21.11-132.jar` | Pfad zum Paper-Server-JAR (wird **nicht** kopiert, sondern direkt referenziert) |
| `PLUGIN_JAR` | `OneBlock-1.1.3.jar` | Quelle für den Plugin-Kopiervorgang pro Session |
| `CERT_PATH` / `KEY_PATH` | `Cert/cert.pem` / `Cert/key.pem` | TLS-Zertifikat/Key (Let's-Encrypt-Symlinks) |
| `MAX_SESSIONS` | `4` | Maximale Anzahl gleichzeitiger Demo-Server (Hostlimit ~7.8 GB RAM, je ~1.3 GB pro Instanz) |
| `TIMEOUT_MS` | 2 Stunden | Maximale Lebensdauer einer Demo-Session |
| `LOG_BUF_MAX` | `500` | Maximale Anzahl gepufferter Log-Zeilen pro Session |
| `HEARTBEAT_TIMEOUT_MS` | `8000` | Nach so vielen ms ohne Heartbeat wird die Session beendet |
| `HEARTBEAT_SWEEP_MS` | `2000` | Intervall, in dem alle Sessions auf abgelaufene Heartbeats geprüft werden |
| `PORT_MIN` / `PORT_MAX` | `25570`–`25665` | Portbereich für die Minecraft-Server-Instanzen |
| `HTTPS_PORT` | `process.env.PORT` oder `3001` | Port des HTTPS-Servers |

### Session-Verwaltung (`sessions`-Map, Zeile 22–32)

Jede aktive Demo-Server-Instanz wird in einer In-Memory-`Map<sessionId, session>`
gehalten. Eine `session` enthält:

- `proc`: das Java-Kindprozess-Objekt (`ChildProcess`)
- `port`: der zugewiesene Minecraft-Port
- `tmpDir`: Pfad zu `/tmp/mc-{sessionId}/` (isoliertes Arbeitsverzeichnis)
- `sseRes`: die offene SSE-`Response`, falls ein Client gerade Logs streamt (sonst `null`)
- `logBuffer`: Array der letzten bis zu 500 Logzeilen (für Replay bei (Re-)Connect)
- `ready`: `true`, sobald der Server hochgefahren ist (Log enthält `"Done ("`)
- `timeoutId`: Timer für das 2-Stunden-Limit
- `lastHeartbeat`: Zeitstempel des letzten Client-Heartbeats

### Hilfsfunktionen

- **`allocatePort()`**: iteriert `PORT_MIN`…`PORT_MAX` und liefert den ersten Port,
  der von keiner aktiven Session belegt ist, oder `null`, wenn alle belegt sind.
- **`cleanup(tmpDir)`**: löscht das temporäre Arbeitsverzeichnis rekursiv
  (`fs.rmSync(..., { recursive: true, force: true })`).
- **`sendSSE(session, data)`**: schreibt eine `data: ...\n\n`-Zeile an den
  verbundenen SSE-Client, falls einer verbunden ist.
- **`bufferLine(session, line)`**: fügt eine Logzeile zum `logBuffer` hinzu
  (FIFO, max. `LOG_BUF_MAX`) und leitet sie per SSE weiter.
- **`killSession(sessionId)`**: beendet eine Session vollständig:
  1. Timer (`timeoutId`) löschen, Session aus der Map entfernen
  2. `[SERVER STOPPED]`-Event an SSE-Client senden und Verbindung schliessen
  3. `"stop\n"` an `stdin` des Java-Prozesses schreiben (sauberes Herunterfahren)
  4. 10-Sekunden-Hard-Kill-Timer: falls der Prozess danach noch läuft, `SIGKILL`
     und Aufräumen des `tmpDir`
  5. Beendet sich der Prozess vorher selbst, wird der Hard-Kill-Timer
     abgebrochen und sofort aufgeräumt
- **`handleLine(session, sessionId, line)`**: wird für jede Zeile
  Server-Output aufgerufen:
  - puffert/streamt die Zeile (`bufferLine`)
  - setzt `ready = true`, wenn die Zeile `"Done ("` enthält (Paper-Startmeldung)
  - erkennt Spieler-Logins per Regex
    `/^\[.*\]: (\S+)\[.*\] logged in with entity id/` und schreibt
    `op {Spielername}\n` an `stdin`: **jeder** Spieler, der dem Demo-Server
    beitritt, erhält automatisch OP (Operator-Rechte, Stufe 4)
- **`makeLineHandler(session, sessionId)`**: Stream-Zeilenpuffer: sammelt
  Chunks von `stdout`/`stderr`, splittet bei `\n` und ruft `handleLine` pro
  vollständiger Zeile auf (Rest wird für den nächsten Chunk zwischengespeichert).

### Express-App & Middleware (Zeile 121–123)

```js
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
```

- `express.json()`: parst JSON-Bodies (`{ sessionId }`) für alle POST-Routen.
- `express.static(public/)`: liefert `index.html`, `style.css`, `app.js`
  direkt als statische Dateien aus.

### API-Endpunkte

#### `POST /api/start`

Erstellt und startet eine neue, isolierte Minecraft-Server-Instanz für eine
`sessionId`.

Ablauf:
1. **Validierung**: `400`, falls `sessionId` fehlt; `409`, falls die Session
   schon existiert; `503`, falls `MAX_SESSIONS` (4) erreicht ist; `503`, falls
   kein freier Port verfügbar ist.
2. **Arbeitsverzeichnis**: erstellt `/tmp/mc-{sessionId}/plugins/`.
3. **`eula.txt`**: schreibt `eula=true\n` (Pflicht für Paper-Start).
4. **`server.properties`**: generiert mit u. a.
   - `server-port={port}`: muss zum `--port`-CLI-Flag passen
   - `online-mode=false`: nötig für Demo-Spieler ohne Mojang-Account
   - `max-players=5`
   - `level-name=world`
   - `motd=OneBlock Demo @ mc.wnw.li`
   - `spawn-protection=0`
   - `op-permission-level=4`: OP-Spieler erhalten volle Admin-Rechte
   - `enable-rcon=false`, `enable-query=false`
   - `view-distance=6`, `simulation-distance=4`
5. **Plugin-Kopie**: `OneBlock-1.1.3.jar` wird in `tmpDir/plugins/` kopiert
   (das ~53 MB grosse Paper-JAR wird **nicht** kopiert, sondern per absolutem
   Pfad referenziert, um Plattenplatz/Zeit zu sparen).
6. **Prozessstart**:
   ```js
   spawn('java', [
     '-Xmx1G', '-Xms512M', '-XX:+UseG1GC',
     '-jar', PAPER_JAR, 'nogui', '--port', String(port),
   ], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] })
   ```
7. **Session-Registrierung**: Eintrag in `sessions`, 2h-Auto-Kill-Timer,
   `lastHeartbeat = Date.now()`.
8. **Stream-Handler**: `stdout`/`stderr` werden über `makeLineHandler`
   verarbeitet (Logbuffer, ready-Erkennung, Auto-OP).
9. **Prozessende**: löst `killSession` aus, falls die Session noch existiert
   (z. B. bei Absturz).
10. **Antwort**: `{ port }`.

#### `POST /api/heartbeat`

Aktualisiert `session.lastHeartbeat = Date.now()`. Wird vom Frontend alle
3 Sekunden aufgerufen, solange der Demo-Server aktiv ist. Antwort: `204 No Content`.

#### `POST /api/stop`

Ruft `killSession(sessionId)` auf und antwortet mit `{ ok: true }`. Wird vom
"Stop Server"-Button verwendet.

#### `POST /api/beacon`

Identisch zu `/api/stop`, aber ohne JSON-Antwortkörper (`204`). Wird über
`navigator.sendBeacon` beim Schliessen/Verlassen der Seite (`beforeunload`)
als Fallback-Cleanup aufgerufen: funktioniert auch, wenn der Tab abrupt
geschlossen wird.

#### `GET /api/status/:sessionId`

Liefert `{ running, port, ready }`:
- existiert keine Session → `{ running: false, port: null, ready: false }`
- existiert eine Session → `{ running: true, port, ready }`

Wird vom Frontend alle 3 Sekunden gepollt, bis `ready === true`.

#### `GET /api/logs/:sessionId`

Server-Sent-Events-Stream der Server-Konsole:
1. `404`, falls keine Session existiert.
2. Setzt SSE-Header (`text/event-stream`, `no-cache`, `keep-alive`) und
   `res.flushHeaders()`.
3. **Replay**: sendet den kompletten `logBuffer` (bis zu 500 Zeilen) sofort an
   den neu verbundenen Client: so sieht man auch beim späten Verbinden alle
   bisherigen Startup-Logs.
4. Registriert `res` als `session.sseRes`, sodass künftige Zeilen live
   weitergeleitet werden.
5. Bei Verbindungsabbruch (`req.on('close')`) wird `sseRes` wieder auf `null`
   gesetzt (keine Kill-Logik mehr hier: das übernimmt der Heartbeat-Sweep).

### Heartbeat-Sweep (Zeile 243–250)

```js
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
        if (now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
            killSession(sessionId);
        }
    }
}, HEARTBEAT_SWEEP_MS);
```

Läuft alle 2 Sekunden über alle aktiven Sessions. Hat ein Client länger als
8 Sekunden keinen Heartbeat gesendet (Tab geschlossen, Verbindung verloren,
Absturz etc.), wird die Session automatisch beendet. Das ist robuster und
schneller als sich nur auf das Schliessen der SSE-Verbindung zu verlassen
(TCP-Close-Events können verzögert oder gar nicht ankommen).

### HTTPS-Server (Zeile 252–255)

```js
https.createServer({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
}, app).listen(HTTPS_PORT, () => console.log('HTTPS :' + HTTPS_PORT));
```

Liest das Let's-Encrypt-Zertifikat (`Cert/cert.pem`, `Cert/key.pem`,
Symlinks auf `/etc/letsencrypt/live/wiki.wnw.li/...`) und startet den
HTTPS-Server auf Port `3001` (bzw. `$PORT`).

---

## public/index.html

Einzelne HTML-Seite, die alle Wiki-Inhalte enthält. Bindet `style.css` und
`app.js` (mit `defer`) ein. Navigation über Anker-Links zu den folgenden
Abschnitten:

| Abschnitt | Inhalt |
|---|---|
| `#overview` | Titel, Lead-Text, Meta-Tags (Paper/Spigot/Purpur/Open Source), Beschreibung, Feature-Grid (6 Karten), Kompatibilitätstabelle |
| `#install` | Voraussetzungen, 5 nummerierte Installationsschritte, Hinweis-Callout (Neustart erforderlich) |
| `#phases` | Erklärung des Level-/Break-Count-Systems, Tabelle mit allen 28 Leveln + Infinity-Level (`'0'`), Callout zu Anpassbarkeit |
| `#commands` | Befehlstabelle (`set`/`add`, `delete`/`remove`, `deletebyid`, `deleteAllOnebLocks`, `list`), Berechtigungstabelle (`OneBlock.Admin`), Warnungs-Callout |
| `#config` | Pfad zu `config.yml`, Optionstabelle, Beispielkonfiguration (Level `'1'` und `'0'`), Callout mit Link zu den Bukkit-JavaDocs |
| `#try` | Live-Demo-Launcher: Start/Stop-Buttons, Status-Anzeige, Countdown, Serveradresse, Live-Log-Ausgabe |

### Live-Demo-Launcher-Markup (`#try`)

```html
<div class="launcher-bar">
  <button id="btn-start" class="btn btn-green">▶ Start Server</button>
  <button id="btn-stop"  class="btn btn-red" disabled>■ Stop Server</button>
  <span class="launcher-status">
    <span id="status-dot"  class="status-dot idle"></span>
    <span id="status-text">Idle</span>
  </span>
  <span id="countdown" class="countdown hidden"></span>
</div>

<div id="server-info" class="server-info hidden">
  <span class="server-info-label">Connect in Minecraft:</span>
  <code id="server-address"></code>
  <span class="server-info-sub">Java Edition → Multiplayer → Direct Connect</span>
</div>

<pre id="log-output" class="log-output"></pre>
```

Diese Elemente werden 1:1 von `app.js` über ihre IDs angesteuert.

---

## public/style.css

Dunkles Minecraft-inspiriertes Theme, ausschliesslich mit System-Fonts und
CSS-Variablen aufgebaut (kein externer Font-Download).

### CSS-Variablen (`:root`)

```css
--bg: #1a1a18;        /* Seitenhintergrund */
--bg-raised: #222220; /* Karten, Header, Callouts */
--bg-inset: #111110;  /* Code/Pre-Hintergrund */
--line: #333330;      /* Rahmen-/Trennfarbe */
--text: #d4cfc7;      /* Haupttext */
--text-dim: #7a7570;  /* Sekundärtext, Tabellenköpfe */
--accent: #8fbc5a;    /* Grün (running/Erfolg) */
--accent-dk: #6a9040; /* dunkleres Grün (Rahmen) */
--warn: #c9a84c;      /* Warnfarbe (starting/Hinweise) */
--code-fg: #b8c9a0;   /* Code-Textfarbe */
--header-h: 52px;     /* Höhe des fixen Headers */
--radius: 5px;        /* einheitlicher Border-Radius */
--mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
```

### Wichtige Komponenten

- **`.site-header`**: fixer Header (Höhe `var(--header-h)`), Brand-Name links,
  Navigationslinks rechts; Links erhalten beim Hover einen `--bg-inset`-Hintergrund.
- **Typografie**: `h2` als kleine, grossgeschriebene Section-Labels
  (`font-size: 13px`, `letter-spacing: 0.1em`, `color: var(--text-dim)`);
  `.lead` für Untertitel; `p` in `var(--text)`.
- **`ol.steps`**: nummerierte Installationsschritte: eigener CSS-Zähler
  (`counter-reset: step`), jeder Schritt als Karte (`var(--bg-raised)`, Rahmen)
  mit grünem quadratischem Badge (`::before`, `var(--accent)`-Hintergrund).
- **`code` / `pre`**: Monospace, `var(--bg-inset)`-Hintergrund,
  `var(--code-fg)`-Text, dezenter `var(--line)`-Rahmen.
- **Tabellen**: volle Breite, grossgeschriebene Spaltenköpfe in
  `var(--text-dim)`, alternierender Hover-Hintergrund (`var(--bg-raised)`)
  pro Zeile.
- **`.badge`**: kleines, monospace Inline-Label (z. B. "Plugin").
- **`.tag.green` / `.tag.blue`**: farbige Pill-Chips für Meta-Infos
  (Kompatibilität, Lizenz).
- **`.callout`**: **einheitlicher 1px-Rahmen auf allen Seiten** (bewusst
  **kein** spezieller linker Rahmen), Hintergrund `var(--bg-raised)`.
  `.callout.warning` hebt `<strong>`-Text in `var(--warn)` hervor.
- **`.feature-grid`**: 2-spaltiges CSS-Grid mit 1px-Abstand auf
  `var(--line)`-Hintergrund, jede Karte `var(--bg-raised)`; auf Bildschirmen
  < 600px einspaltig.
- **`.launcher-bar`**: Flex-Reihe mit Buttons, Status-Punkt und Countdown.
- **`.status-dot`**: 7px-Kreis, vier Zustände:
  - `.idle` → `var(--text-dim)` (gedimmt)
  - `.starting` → `var(--warn)` + Puls-Animation
  - `.running` → `var(--accent)` (grün)
  - `.stopping` → Rot (`#c9594c`) + Puls-Animation
- **`.btn` / `.btn-green` / `.btn-red`**: grün- bzw. rot-getönte Buttons;
  `:disabled` → 35% Opazität.
- **`.server-info`**: grün getönte Box mit Verbindungsadresse, standardmässig
  via `.hidden` ausgeblendet.
- **`#log-output` / `.log-output`**: 340px hoch, Hintergrund `#0a0a09`,
  Text `#8a9980`, Monospace 12px, `overflow-y: auto`,
  `white-space: pre-wrap` (für Live-Logs).
- **Scrollbars**: dünn (5px), transparente Track, `var(--line)`-Thumb
  (sowohl `::-webkit-scrollbar-*` als auch `scrollbar-width`/`scrollbar-color`).
- **Responsive**: bei `max-width: 600px` wird `.feature-grid` einspaltig und
  `.site-nav` ausgeblendet.

---

## public/app.js

Vanilla JavaScript (`'use strict'`, keine Imports), steuert ausschliesslich
den Live-Demo-Launcher im `#try`-Abschnitt.

### Session-ID

```js
const sessionId = crypto.randomUUID();
```

Wird einmal pro Seitenaufruf generiert (nicht persistiert in `localStorage`),
jeder Browser-Tab/Reload erhält eine neue, eindeutige Session-ID, die in
allen API-Aufrufen mitgeschickt wird.

### Zustandsvariablen

```js
let evtSource         = null; // aktive EventSource (SSE) für Logs
let statusInterval    = null; // Polling-Intervall für /api/status
let countdownInterval = null; // Countdown-Timer (2h-Limit)
let heartbeatInterval = null; // Intervall für /api/heartbeat
```

### DOM-Referenzen

Alle interaktiven Elemente werden beim Laden per ID referenziert:
`btn-start`, `btn-stop`, `status-dot`, `status-text`, `countdown`,
`server-info`, `server-address`, `log-output`.

### Hilfsfunktionen

- **`setStatus(state, text)`**: setzt die CSS-Klasse des Status-Punkts
  (`idle`/`starting`/`running`/`stopping`) und den Statustext.
- **`appendLog(line)`**: hängt eine Zeile + `\n` an `#log-output` an und
  scrollt automatisch nach unten.
- **`startCountdown(durationMs)`**: zeigt `m:ss remaining` an und ruft nach
  Ablauf automatisch `stopServer()` auf (2-Stunden-Limit).
- **`resetUI()`**: aktiviert "Start", deaktiviert "Stop", blendet
  Server-Info & Countdown aus, setzt Status auf `idle`.
- **`closeSSE()`**: schliesst die `EventSource` und räumt
  `statusInterval` **und** `heartbeatInterval` auf.
- **`sendHeartbeat()`**: `POST /api/heartbeat` mit `{ sessionId }`.

### `startServer()`

1. Deaktiviert beide Buttons, setzt Status auf `"starting"`, leert das Log.
2. `POST /api/start`: bei Fehler wird die Meldung ins Log geschrieben und
   "Start" wieder aktiviert.
3. Sendet sofort einen Heartbeat und startet danach `heartbeatInterval`
   (alle **3 Sekunden** `sendHeartbeat()`).
4. Öffnet `EventSource('/api/logs/' + sessionId)`:
   - Nachricht `[SERVER STOPPED]` → `closeSSE()` + `resetUI()`
   - alle anderen Nachrichten → `appendLog(...)`
5. Startet `statusInterval` (alle 3 Sekunden `GET /api/status/:sessionId`),
   bis `ready === true`. Sobald bereit:
   - Intervall stoppen, Status auf `"running"`, "Stop"-Button aktivieren
   - Serveradresse `mc.wnw.li:{port}` anzeigen
   - `startCountdown(2h)` starten

### `stopServer()`

1. Status auf `"stopping"`, "Stop"-Button deaktivieren.
2. `closeSSE()`: beendet SSE, Status-Polling und Heartbeat.
3. `POST /api/stop` mit `{ sessionId }`.
4. `resetUI()`.

### Event-Listener

```js
btnStart.addEventListener('click', startServer);
btnStop.addEventListener('click',  stopServer);

window.addEventListener('beforeunload', () => {
    navigator.sendBeacon('/api/beacon', JSON.stringify({ sessionId }));
    closeSSE();
});
```

`navigator.sendBeacon` garantiert, dass der Cleanup-Request auch beim
abrupten Schliessen des Tabs noch zuverlässig abgesendet wird: als
zusätzliche Absicherung neben dem serverseitigen Heartbeat-Sweep.

---

## Zusammenfassung der wichtigsten technischen Regeln

1. **Nur SSE**, kein WebSocket/Socket.IO: Logs werden per
   Server-Sent-Events gestreamt.
2. **Paper-JAR wird nie kopiert**: alle Sessions referenzieren den
   53 MB grossen `paper-1.21.11-132.jar` per absolutem Pfad.
3. **`online-mode=false`** ist Pflicht, da Demo-Spieler keinen
   Mojang-Account benötigen.
4. **`MAX_SESSIONS = 4`**: Limit basierend auf verfügbarem RAM
   (~1.3 GB pro Instanz, ~7.8 GB Host-RAM).
5. **Isoliertes `/tmp/mc-{sessionId}/`** pro Session: kein gemeinsamer
   Zustand zwischen Demo-Servern.
6. **Aktiver Heartbeat (alle 3s, Timeout 8s)** ersetzt die frühere
   SSE-Grace-Period: erkennt geschlossene Tabs zuverlässig und schnell.
7. **Log-Buffer-Replay** bei neuer SSE-Verbindung: auch bei spätem
   Verbinden sind alle bisherigen Logs sichtbar.
8. **`beforeunload`-Beacon** als zusätzlicher Fallback-Cleanup.
9. **Keine linke Sonderrandlinie bei Callouts**: einheitlicher 1px-Rahmen
   auf allen vier Seiten.
10. **Port-Konsistenz**: derselbe Port wird sowohl als `--port`-CLI-Flag
    als auch in `server.properties` (`server-port`) gesetzt.
11. **Automatisches OP**: jeder Spieler, der einer Demo-Instanz beitritt,
    erhält via `op {name}` volle Operator-Rechte (`op-permission-level=4`).
