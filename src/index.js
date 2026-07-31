// umask before anything touches the filesystem, so no file/directory can
// leak through a missed mode argument anywhere downstream.
process.umask(0o077);

import { config } from './config.js';
import { preflight, store, generateCredential, hashPassword } from './store.js';
import { events } from './events.js';
import { queue } from './queue.js';
import * as smtp from './smtp.js';
import * as web from './web/server.js';
import { shutdown } from './shutdown.js';

function printFirstRunBanner(generated) {
    const lines = [
        'outlook-oauth-bridge — first run',
        `Web GUI : http://<host>:${config.httpPort}`,
        `Password: ${generated.webPassword}`,
        `SMTP    : <host>:${smtp.configuredPort()}  (STARTTLS off)`,
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
    // without real certs configured, and rejects if the configured SMTP
    // port can't be bound (e.g. a privileged port with no permission) —
    // both must reach bootstrap().catch and exit 1 with a clear message
    // rather than a bare stack trace or a silently half-started server.
    await smtp.start();
    await queue.start();
    await web.start();

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
});
