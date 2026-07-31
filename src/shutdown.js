import { events } from './events.js';
import * as smtp from './smtp.js';
import { queue } from './queue.js';
import * as web from './web/server.js';

let shuttingDown = false;

// Shared by index.js's SIGTERM/SIGINT handlers and the GUI's "Restart
// bridge" button (web/api.js) — both need the identical drain sequence, and
// living here (rather than in index.js) avoids api.js having to import
// index.js just to trigger it.
export async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    events.emitEvent('shutdown', { reason });

    // Stop accepting new SMTP connections, let whatever the queue is
    // mid-send finish, then stop the web GUI. Bounded so a stuck send can't
    // block the process from ever exiting.
    const drain = (async () => {
        await smtp.stop();
        await queue.stop();
        await web.stop();
    })();
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 30_000))]);

    process.exit(0);
}
