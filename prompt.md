# Rebuild Prompt — OneBlock Wiki with Live Server Spawning

Build a complete Node.js web application from scratch with the following specification. Do not use any frontend frameworks (no React, Vue, etc.) — only vanilla HTML, CSS, and JavaScript. The only backend dependency is `express`.

---

## Project Structure

```
project-root/
├── server.js
├── package.json
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── Cert/
│   ├── cert.pem    ← symlink to Let's Encrypt fullchain
│   └── key.pem     ← symlink to Let's Encrypt privkey
├── paper-1.21.11-132.jar   ← Minecraft server JAR (stays in root)
└── OneBlock-1.1.3.jar      ← Plugin JAR (stays in root)
```

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

---

## server.js

Single-file Express backend. ESM (`import`/`export`). No Socket.IO.

### Constants

```js
const ROOT       = path.dirname(fileURLToPath(import.meta.url));
const PAPER_JAR  = path.join(ROOT, 'paper-1.21.11-132.jar');
const PLUGIN_JAR = path.join(ROOT, 'OneBlock-1.1.3.jar');
const CERT_PATH  = path.join(ROOT, 'Cert', 'cert.pem');
const KEY_PATH   = path.join(ROOT, 'Cert', 'key.pem');
const MAX_SESSIONS = 4;
const TIMEOUT_MS   = 2 * 60 * 60 * 1000;   // 2 hours
const LOG_BUF_MAX  = 500;
const PORT_MIN     = 25565;
const PORT_MAX     = 25665;
const HTTPS_PORT   = parseInt(process.env.PORT ?? '3001', 10);
```

### Session Map

```
Map<sessionId, {
  proc:      ChildProcess,
  port:      number,
  tmpDir:    string,        // /tmp/mc-{sessionId}
  sseRes:    Response|null,
  logBuffer: string[],      // capped at LOG_BUF_MAX lines
  ready:     boolean,       // true when stdout contains "Done ("
  timeoutId: Timeout,
  killTimer: Timeout|null,
}>
```

### Port Allocation

Iterate PORT_MIN–PORT_MAX, return first port not in use by any active session.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/start` | Body `{sessionId}` — creates tmp dir, spawns Java, returns `{port}` |
| POST | `/api/stop` | Body `{sessionId}` — gracefully stops server |
| POST | `/api/beacon` | Body `{sessionId}` — same as stop, called by `navigator.sendBeacon` |
| GET | `/api/status/:sessionId` | Returns `{running, port, ready}` |
| GET | `/api/logs/:sessionId` | SSE stream of server stdout/stderr |

### POST /api/start logic

1. Return 409 if session already exists
2. Return 503 if `sessions.size >= MAX_SESSIONS`
3. Allocate port, return 503 if none free
4. Create `tmpDir = /tmp/mc-{sessionId}/` and `tmpDir/plugins/`
5. Write `eula.txt` with content `eula=true\n`
6. Write `server.properties`:
   ```
   server-port={port}
   online-mode=false
   max-players=5
   level-name=world
   motd=OneBlock Demo — wiki.wnw.li
   spawn-protection=0
   enable-rcon=false
   enable-query=false
   view-distance=6
   simulation-distance=4
   ```
7. `fs.copyFileSync(PLUGIN_JAR, tmpDir/plugins/OneBlock-1.1.3.jar)`
8. Spawn Java:
   ```js
   spawn('java', ['-Xmx1G', '-Xms512M', '-XX:+UseG1GC',
     '-jar', PAPER_JAR, 'nogui', '--port', String(port)],
     { cwd: tmpDir, stdio: ['pipe','pipe','pipe'] })
   ```
9. Register session, set 2h auto-kill timeout
10. stdout/stderr handler: buffer lines (cap 500), set `ready=true` when line includes `"Done ("`, auto-op player on login (match `logged in with entity id`, write `op {name}\n` to stdin), forward line to SSE if connected
11. On process `close`: call `killSession` if session still exists
12. Return `{ port }`

### killSession(sessionId)

```
1. Clear all timers
2. Delete from sessions map
3. Send "data: [SERVER STOPPED]\n\n" to sseRes, end it
4. Write "stop\n" to proc.stdin
5. Set 10s hard-kill timeout: proc.kill('SIGKILL') then cleanup
6. On proc close: clearTimeout hard-kill, cleanup
```

### cleanup(tmpDir)

`fs.rmSync(tmpDir, { recursive: true, force: true })`

### SSE endpoint `/api/logs/:sessionId`

1. Return 404 if session not found
2. Cancel any pending `killTimer`
3. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, call `res.flushHeaders()`
4. Replay all lines in `logBuffer`
5. Set `session.sseRes = res`
6. On `req.on('close')`: set `session.sseRes = null`, start 10s `killTimer` (grace period for page reload)

### HTTPS server

```js
https.createServer({
  cert: fs.readFileSync(CERT_PATH),
  key:  fs.readFileSync(KEY_PATH),
}, app).listen(HTTPS_PORT, () => console.log('HTTPS :' + HTTPS_PORT));
```

Serve `public/` as static files via `express.static`.

---

## public/style.css

Dark Minecraft-themed design. No external fonts required — use system fonts. Use these CSS variables:

```css
:root {
    --bg:        #1a1a18;
    --bg-raised: #222220;
    --bg-inset:  #111110;
    --line:      #333330;
    --text:      #d4cfc7;
    --text-dim:  #7a7570;
    --accent:    #8fbc5a;
    --accent-dk: #6a9040;
    --warn:      #c9a84c;
    --code-fg:   #b8c9a0;
    --header-h:  52px;
    --radius:    5px;
    --mono:      'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
}
```

### Required components

**Fixed header** (`.site-header`): dark background, brand name + nav links. Nav links highlight on hover.

**Typography**: `h2` as uppercase section labels (`font-size: 13px`, `letter-spacing: 0.1em`, `color: var(--text-dim)`). `.lead` for subtitle text. `p` in `var(--text)`.

**Numbered steps** (`ol.steps`): custom counter with green square badge, each step in a raised card.

**Code/pre**: monospace, `var(--bg-inset)` background, `var(--code-fg)` text, subtle border.

**Tables**: full-width, alternating hover on rows, uppercase column headers in `var(--text-dim)`.

**Badges** (`.badge`): small inline monospace label. Tags (`.tag.green`, `.tag.blue`): colored chip.

**Callout** (`.callout`): uniform 1px border on all sides (NO special left border), `var(--bg-raised)` background. `.callout.warning` highlights strong text in `var(--warn)`.

**Feature grid** (`.feature-grid`): 2-column CSS grid with 1px gap on `var(--line)` background, each card in `var(--bg-raised)`.

**Launcher bar** (`.launcher-bar`): flexbox row with buttons, status dot, and countdown.

**Status dot** (`.status-dot`): 7px circle. States: `.idle` = dim, `.starting` = warn + pulse animation, `.running` = accent green, `.stopping` = red + pulse.

**Buttons** (`.btn`): `.btn-green` (green tint) and `.btn-red` (red tint). Disabled state at 35% opacity.

**Server info box** (`.server-info`): green-tinted bar showing connection address, hidden by default.

**Log output** (`#log-output` / `.log-output`): `340px` tall, `#0a0a09` background, `#8a9980` text, monospace 12px, `overflow-y: auto`, `white-space: pre-wrap`.

**Scrollbars**: thin (5px), transparent track, `var(--line)` thumb.

**Responsive**: stack feature grid to 1 column below 600px.

---

## public/index.html

Single HTML page. Link `style.css` and `app.js` (defer). No Socket.IO script.

### Navigation sections

`#overview`, `#install`, `#phases`, `#commands`, `#config`, `#try`

### Section content

**#overview**
- H1: `OneBlock` + `.badge` "Plugin"
- `.lead` description
- Meta tags: Paper 1.21.x (green), Spigot (green), Purpur (green), Open Source (blue)
- 2-paragraph description of the plugin
- Feature grid (6 cards): Unlimited OneBlocks, Dynamic Progression, Persistent Data, Griefing Protection, Multiverse Support, Lightweight
- Compatibility table: Minecraft Version, Server Software, Optional Dependency, Permission Node

**#install**
- Requirements list (Paper/Spigot/Purpur 1.21.x, Java 21+, OP access)
- `ol.steps` with 5 steps: Download, Place in plugins/, Restart server, Configure, Create first OneBlock (`/oneblock set <x> <y> <z>`)
- Callout tip about restart requirement

**#phases**
- Explanation of break-count system
- Table with all 28 levels + infinity row:
  - Columns: Level, Theme, Example Drops, Size
  - Levels 1–28 with Minecraft-themed names (Podzol & Melon, Desert, Birch Forest, Mining, Deep Mining, Lush Cave, Dripstone Cave, Rich Mining, Mushroom Island, Jungle, Snow, Swamp, Sea, Nether Basics, Crimson Forest, Warped Forest, Basalt Deltas, Soul Sand Valley, Nether Fortress, Nether Riches, Stronghold, End, End Cities, Ancient, Builder's Paradise, Redstone Engineer, Magic & Enchanting, The End Game)
  - ∞ Infinity row at the bottom
- Callout: drops are customisable

**#commands**
- Command table: set, delete, deletebyid, deleteAllOneBlocks, list
- Aliases table: /ob, /the12forest
- Permissions table: OneBlock.Admin
- Warning callout about deleteAllOneBlocks

**#config**
- File location pre block
- Options table: Max_Level, ThenComesInfinity, Level_N.level-size, Level_N.blocks, Level_N.mobs
- Example config.yml showing Level_1 and Level_0 (infinity)
- Callout linking to Bukkit JavaDocs

**#try**
- `.lead` text
- Callout explaining how the system works (fresh Paper server, auto-deleted on leave, max 4 slots)
- Launcher bar:
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
  ```
- Server info box:
  ```html
  <div id="server-info" class="server-info hidden">
    <span class="server-info-label">Connect in Minecraft:</span>
    <code id="server-address"></code>
    <span class="server-info-sub">Java Edition → Multiplayer → Direct Connect</span>
  </div>
  ```
- Log output:
  ```html
  <pre id="log-output" class="log-output"></pre>
  ```

---

## public/app.js

Vanilla JS, no imports, `'use strict'`.

### Session ID

```js
const sessionId = crypto.randomUUID();
```

Generated once per page load. Not stored in localStorage.

### State variables

```js
let evtSource         = null;
let statusInterval    = null;
let countdownInterval = null;
```

### DOM references

Grab all interactive elements by ID on load: `btn-start`, `btn-stop`, `status-dot`, `status-text`, `countdown`, `server-info`, `server-address`, `log-output`.

### Helper functions

- `setStatus(state, text)` — sets dot class and status text
- `appendLog(line)` — appends line + `\n` to log pre, auto-scrolls to bottom
- `startCountdown(durationMs)` — shows `m:ss remaining`, calls `stopServer()` at 0
- `resetUI()` — re-enables start, disables stop, hides server-info, clears countdown
- `closeSSE()` — closes EventSource and clears status polling interval

### startServer()

1. Disable both buttons, set status to "starting", clear log
2. `fetch('/api/start', POST, {sessionId})` — on error show in log and re-enable start button
3. Open `new EventSource('/api/logs/' + sessionId)`
4. `evtSource.onmessage`: if data is `[SERVER STOPPED]` → closeSSE + resetUI; else appendLog
5. Start polling `GET /api/status/{sessionId}` every 3 seconds until `ready === true`
6. On ready: setStatus running, enable stop, show server address (`wiki.wnw.li:{port}`), startCountdown(2h)

### stopServer()

1. setStatus stopping, disable stop button
2. closeSSE()
3. `fetch('/api/stop', POST, {sessionId})`
4. resetUI()

### Event listeners

```js
btnStart.addEventListener('click', startServer);
btnStop.addEventListener('click',  stopServer);
window.addEventListener('beforeunload', () => {
    navigator.sendBeacon('/api/beacon', JSON.stringify({ sessionId }));
    closeSSE();
});
```

---

## Key Technical Rules

1. **SSE only** — no WebSocket, no Socket.IO
2. **PAPER_JAR used via absolute path** in spawn — never copy the 53 MB JAR per session
3. **online-mode=false** in server.properties — required for demo servers
4. **MAX_SESSIONS = 4** — host has ~7.8 GB RAM, each instance uses ~1.3 GB
5. **Isolated /tmp/mc-{id}/** — fully separate cwd per session, no shared state
6. **10s grace period** on SSE close before killing — allows page reload without destroying the server
7. **Log buffer replay** on new SSE connection — client always sees startup logs even if it connects late
8. **beforeunload beacon** as fallback cleanup — fires even when tab is force-closed
9. **No left border on callouts** — uniform 1px border on all sides only
10. **Port configured in both** `--port` CLI flag and `server.properties` — consistency
