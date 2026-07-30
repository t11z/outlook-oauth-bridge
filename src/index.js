// umask before anything touches the filesystem, so no file/directory can
// leak through a missed mode argument anywhere downstream.
process.umask(0o077);

import { config } from './config.js';
import { preflight, store, generateCredential, hashPassword } from './store.js';
import { events } from './events.js';
import { queue } from './queue.js';
import * as smtp from './smtp.js';
import * as web from './web/server.js';

function printFirstRunBanner(generated) {
    const lines = [
        'outlook-oauth-bridge — first run',
        `Web GUI : http://<host>:${config.httpPort}`,
        `Password: ${generated.webPassword}`,
        `SMTP    : <host>:${config.smtpPort}  (STARTTLS off)`,
        `Username: bridge`,
        `Password: ${generated.smtpPassword}`,
        'This block is printed only once. Save it now.',
    ];
    const width = Math.max(...lines.map((l) => l.length)) + 2;
    const bar = '═'.repeat(width);
    process.stdout.write(`\n╔${bar}╗\n`);
    for (const line of lines) {
        process.stdout.write(`║ ${line.padEnd(width - 1)}║\n`);
    }
    process.stdout.write(`╚${bar}╝\n\n`);
}

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    events.emitEvent('shutdown', { signal });

    // Stop accepting new SMTP connections, let whatever the queue is
    // mid-send finish, then stop the web GUI. Bounded so a stuck send
    // can't block the container from ever stopping.
    const drain = (async () => {
        await smtp.stop();
        await queue.stop();
        await web.stop();
    })();
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 30_000))]);

    process.exit(0);
}

async function bootstrap() {
    await preflight();

    const { firstRun, generated } = await store.load();

    if (firstRun) {
        printFirstRunBanner(generated);
    } else if (config.resetPassword) {
        const newWebPassword = generateCredential(24);
        await store.mutate((state) => {
            state.web.passwordHash = hashPassword(newWebPassword);
            state.web.passwordIsGenerated = true;
        });
        printFirstRunBanner({ webPassword: newWebPassword, smtpPassword: store.state.smtp.password });
    }

    events.emitEvent('boot', { instanceId: store.state.instanceId, firstRun });

    // smtp.start() throws synchronously if settings.requireTls is on
    // without real certs configured (see smtp.js) — that must reach
    // bootstrap().catch and exit 1 rather than silently falling back to a
    // self-signed cert, so it is called directly here, not wrapped.
    smtp.start();
    await queue.start();
    await web.start();

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
});
