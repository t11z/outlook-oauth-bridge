import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { events } from '../events.js';
import { queue } from '../queue.js';
import { handleApi } from './api.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

// Fixed allowlist — never resolve a request path into public/. There are
// exactly three files; nothing here is user-influenced.
const STATIC_ROUTES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

let staticAssets = null; // route -> { content, type, etag } — loaded once; these files never change at runtime

async function loadStaticAssets() {
    const map = new Map();
    for (const [route, entry] of Object.entries(STATIC_ROUTES)) {
        const content = await fs.readFile(path.join(PUBLIC_DIR, entry.file));
        const etag = `"${crypto.createHash('sha1').update(content).digest('hex')}"`;
        map.set(route, { content, type: entry.type, etag });
    }
    return map;
}

function serveStatic(req, res, asset) {
    if (req.headers['if-none-match'] === asset.etag) {
        res.writeHead(304);
        return res.end();
    }
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ETag: asset.etag });
    res.end(asset.content);
}

// No secrets here — this is the one unauthenticated route, and the only
// thing hitting it is the Docker healthcheck.
function handleHealthz(req, res) {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), smtp: 'listening', queue: queue.status().depth });
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

let server = null;

export async function start() {
    if (server) return server;
    staticAssets = await loadStaticAssets();

    server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

            if (req.method === 'GET' && url.pathname === '/healthz') return handleHealthz(req, res);
            if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

            if (req.method === 'GET' && staticAssets.has(url.pathname)) {
                return serveStatic(req, res, staticAssets.get(url.pathname));
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        } catch (err) {
            events.emitEvent('error', { message: `web request handler crashed: ${err.message}` });
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal error');
            }
        }
    });

    await new Promise((resolve) => server.listen(config.httpPort, config.bind, resolve));
    events.emitEvent('web-listening', { port: config.httpPort, bind: config.bind });
    return server;
}

export function stop() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => {
            server = null;
            resolve();
        });
        // Idle keep-alive connections (including open SSE streams) would
        // otherwise block close() indefinitely.
        server.closeAllConnections?.();
    });
}
