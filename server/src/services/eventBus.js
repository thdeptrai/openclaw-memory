/**
 * EventBus — Centralized event system for real-time dashboard updates
 * Replaces LogBuffer with typed event broadcasting via SSE
 *
 * Event types:
 *   log            — Server log entry (info/warn/error/debug)
 *   exchange:new   — New exchange stored
 *   memory:new     — New memory extracted (fact/decision/etc)
 *   summarize:done — Summarization completed
 *   agent:new      — New agent registered
 *   stats:update   — Periodic stats snapshot
 */
class EventBus {
    constructor(maxLogs = 500) {
        this.logs = [];
        this.maxLogs = maxLogs;
        this.clients = new Set();
        this.recentEvents = [];     // Recent non-log events for new clients
        this.maxRecentEvents = 50;
    }

    // ======== LOG METHODS (backward compat) ========

    push(level, message, meta = {}) {
        const entry = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            level,
            message,
            source: meta.source || null,
            ...meta,
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) this.logs.shift();

        this.broadcast({ type: 'log', data: entry });
        return entry;
    }

    info(msg, meta = {}) { return this.push('info', msg, meta); }
    warn(msg, meta = {}) { return this.push('warn', msg, meta); }
    error(msg, meta = {}) { return this.push('error', msg, meta); }
    debug(msg, meta = {}) { return this.push('debug', msg, meta); }

    getRecent(limit = 50) {
        return this.logs.slice(-limit).reverse();
    }

    // ======== TYPED EVENTS ========

    /**
     * Emit a typed event to all SSE clients + store in recent events
     */
    emit(type, data = {}) {
        const event = {
            type,
            data: {
                ...data,
                timestamp: data.timestamp || new Date().toISOString(),
            },
        };

        // Store for new client catch-up
        this.recentEvents.push(event);
        if (this.recentEvents.length > this.maxRecentEvents) {
            this.recentEvents.shift();
        }

        this.broadcast(event);
    }

    getRecentEvents(limit = 20) {
        return this.recentEvents.slice(-limit).reverse();
    }

    // ======== SSE CLIENT MANAGEMENT ========

    addClient(res) {
        this.clients.add(res);
        res.on('close', () => this.clients.delete(res));

        // Send recent events for catch-up
        for (const event of this.recentEvents.slice(-20)) {
            try {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch { /* ignore */ }
        }
    }

    broadcast(event) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of this.clients) {
            try {
                client.write(data);
            } catch {
                this.clients.delete(client);
            }
        }
    }

    get clientCount() {
        return this.clients.size;
    }
}

// ======== SINGLETON ========
const eventBus = new EventBus();

// ======== INTERCEPT console.log/warn/error ========
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

const stripAnsi = (str) =>
    str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

console.log = (...args) => {
    originalLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (!msg.includes('SSE') && msg.trim()) {
        eventBus.info(stripAnsi(msg));
    }
};

console.warn = (...args) => {
    originalWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    eventBus.warn(stripAnsi(msg));
};

console.error = (...args) => {
    originalError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    eventBus.error(stripAnsi(msg));
};

module.exports = eventBus;
