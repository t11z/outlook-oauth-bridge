import { EventEmitter } from 'node:events';

const FEED_CAP = 200;

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
        this.feed = [];
        this._seq = 0;
    }

    // type: 'queued' | 'sending' | 'sent' | 'retry' | 'dead' | 'auth' | 'counters' | 'paused' | 'resumed' | 'auth-failure'
    //
    // `seq` is this bus's own ring-buffer sequence number. It is intentionally
    // NOT named `id` — several event types (queued/sending/sent/retry/dead)
    // pass their own semantic `id` (the spool message id) in `data`, and that
    // must win untouched. Naming both `id` previously let a caller-less event
    // (e.g. 'auth') silently fall back to displaying the raw sequence number.
    emitEvent(type, data = {}) {
        const event = { seq: ++this._seq, type, at: Date.now(), ...data };

        this.feed.push(event);
        if (this.feed.length > FEED_CAP) this.feed.shift();

        process.stdout.write(JSON.stringify({ level: 'info', type, ...data, at: event.at }) + '\n');

        this.emit('event', event);
        return event;
    }

    recentFeed() {
        return this.feed;
    }
}

export const events = new EventBus();
