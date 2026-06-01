import express from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { gameGroups, setupSocket } from './Backend/routes/ws/index.js';
import log from './Backend/function/log.js';
const console = { log: log('InitRouter') };



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const httpPort = process.env.PORT || 80;
const httpsPort = process.env.HTTPS_PORT || 443;

app.use(express.json());

// Routes
import { router as adminRouter } from './Backend/routes/admin/index.js';
import { router as mainRouter } from './Backend/routes/main/index.js';
import { router as gameRouter } from './Backend/routes/game/index.js';


app.use("/api/game", gameRouter)
app.use("/api/admin", adminRouter)
app.use("/api/main", mainRouter)
//app.use("/api/task", tasksRouter)
//app.use("/api/user", userRouter)
//app.use("/api/storage", adminRouter)
//app.use("/api/login", loginRouter)
//app.use("/api/shutdown", shutdownRouter)


app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'Frontend/Player-Join/index.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'Frontend/player.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'Frontend/Admin/index.html')));
app.get('/lobby', (req, res) => res.sendFile(path.join(__dirname, 'Frontend/lobby.html')));

// Static assets
app.use('/admin', express.static(path.join(__dirname, 'Frontend/Admin')));
app.use('/', express.static(path.join(__dirname, 'Frontend')));

// Catch all
app.use("", (req, res) => { res.redirect('/') })
//app.get("*", (req, res) => { res.redirect('/') });

// HTTP → HTTPS redirect
/*
http.createServer((req, res) => {
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, ':' + httpsPort);
    if ((req.headers.host || 'localhost').startsWith('127.0.0.1') || (req.headers.host || 'localhost').startsWith('localhost') || req.socket.remoteAddress === '::1') {
        return;
    }
    res.writeHead(301, { Location: 'https://' + host + req.url });
    res.end();
}).listen(httpPort, () => console.log(`HTTP redirect on port ${httpPort}`));
*/
http.createServer(app).listen(httpPort, () => {
    console.log(`HTTP server on port ${httpPort}`);
});

// HTTPS server + Socket.io
const privateKey = fs.readFileSync('./Cert/key.pem', 'utf8');
const certificate = fs.readFileSync('./Cert/cert.pem', 'utf8');
const httpsServer = https.createServer({ key: privateKey, cert: certificate }, app);
const io = new Server(httpsServer);

// Socket
setupSocket(io);

httpsServer.listen(httpsPort, () => console.log(`HTTPS server on port ${httpsPort}`));

// Logging
/*
const origLog = console.log;
if (!fs.existsSync('./LOG')) fs.mkdirSync('./LOG', { recursive: true });
console.log = function (message, ...rest) {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const day = now.toISOString().slice(0, 10);
    const formattedLine = `${ts}   ${message}`;
    fs.appendFileSync(`./LOG/LOG_${day}.log`, formattedLine + ' ' + rest.join(' ') + '\n');
    origLog(formattedLine, ...rest);
};
*/

console.log('Wiki Server started');
export default app;