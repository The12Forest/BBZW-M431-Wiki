# BBZW-M431-Wiki

Wiki-Webseite für das OneBlock-Plugin ([The12Forest/OneBlock-Plugin](https://github.com/The12Forest/OneBlock-Plugin))
mit integriertem Live-Demo-Launcher: Besucher können direkt im Browser einen
temporären Paper-Minecraft-Server mit vorinstalliertem OneBlock-Plugin starten,
darin spielen und ihn nach max. 2 Stunden (oder beim Verlassen der Seite)
wieder automatisch herunterfahren lassen.

Technische Details zur Implementierung: siehe [`Tecnical doc/Technische-Dokumentation.md`](./Tecnical%20doc/Technische-Dokumentation.md).

## Stack

- Backend: Node.js (ESM) + [Express](https://expressjs.com/) (einzige Abhängigkeit)
- Frontend: reines HTML/CSS/JavaScript (kein Framework)
- Echtzeit-Logs: Server-Sent-Events (SSE), kein WebSocket/Socket.IO
- Demo-Server: [Paper](https://papermc.io/) 1.21.11 + OneBlock-Plugin, pro Session
  isoliert in `/tmp/mc-{sessionId}/`

## Setup & Start

Voraussetzungen: Node.js 18+, Java 21+, sowie `paper-1.21.11-132.jar` und
`OneBlock-1.1.3.jar` im Projektroot, und gültige Zertifikate unter `Cert/cert.pem`
und `Cert/key.pem`.

```bash
npm install
npm start        # Produktionsstart (node server.js)
npm run dev       # Entwicklung mit Auto-Restart (node --watch server.js)
```

Standardmässig läuft der HTTPS-Server auf Port `3001` (überschreibbar via
Umgebungsvariable `PORT`).

## Projektstruktur

```
project-root/
├── server.js              # Express/HTTPS Backend
├── package.json
├── public/
│   ├── index.html          # Wiki-Inhalte + Live-Demo-Launcher
│   ├── style.css            # Dark-Theme
│   └── app.js                # Launcher-Logik (Start/Stop/Logs/Heartbeat)
├── Cert/                    # Symlinks auf Let's-Encrypt-Zertifikat
├── paper-1.21.11-132.jar    # Paper-Server-JAR (Basis für Demo-Server)
├── OneBlock-1.1.3.jar       # Plugin-JAR (wird pro Session kopiert)
└── Tecnical doc/            # Technische Dokumentation
```

## Aufgaben

- Aufgaben sind in der Checkliste
- Bewertungsraster nochmals anschauen
- Manuel: Server aufsetzen
