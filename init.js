import express from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { setupMcSocket } from './Backend/routes/ws/mc-server.js';
import log from './Backend/function/log.js';

const console = { log: log('Server') };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpPort = process.env.PORT || 80;
const httpsPort = process.env.HTTPS_PORT || 443;

app.use(express.json());

// In-process rate limiter — 100 req / 15 min per IP, no external dependency
const rateLimitStore = new Map();
app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const now = Date.now();
    let entry = rateLimitStore.get(ip);
    if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + 15 * 60 * 1000 };
    entry.count++;
    rateLimitStore.set(ip, entry);
    if (entry.count > 100) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    next();
});

// Static assets served from Frontend/
app.use('/', express.static(path.join(__dirname, 'Frontend')));

// Fallback — serve index.html for any unmatched route
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'Frontend/index.html'));
});

// HTTP server
http.createServer(app).listen(httpPort, () => {
    console.log(`HTTP server on port ${httpPort}`);
});

// HTTPS server + Socket.io
const privateKey = fs.readFileSync('./Cert/key.pem', 'utf8');
const certificate = fs.readFileSync('./Cert/cert.pem', 'utf8');
const httpsServer = https.createServer({ key: privateKey, cert: certificate }, app);
const io = new Server(httpsServer);
setupMcSocket(io);
httpsServer.listen(httpsPort, () => console.log(`HTTPS server on port ${httpsPort}`));

console.log('OneBlock Wiki server started');
export default app;
