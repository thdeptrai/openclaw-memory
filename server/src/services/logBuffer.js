/**
 * Log Buffer — In-memory ring buffer for server logs + SSE broadcast
 */
class LogBuffer {
    constructor(maxSize = 200) {
        this.logs = [];
        this.maxSize = maxSize;
        this.clients = new Set();
    }

    /**
     * Add a log entry and broadcast to SSE clients
     */
    push(level, message, meta = {}) {
        const entry = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            level,
            message,
            ...meta,
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxSize) {
            this.logs.shift();
        }

        // Broadcast to all SSE clients
        this.broadcast(entry);
        return entry;
    }

    info(msg, meta) { return this.push('info', msg, meta); }
    warn(msg, meta) { return this.push('warn', msg, meta); }
    error(msg, meta) { return this.push('error', msg, meta); }
    debug(msg, meta) { return this.push('debug', msg, meta); }

    /**
     * Get recent logs
     */
    getRecent(limit = 50) {
        return this.logs.slice(-limit).reverse();
    }

    /**
     * Register an SSE client
     */
    addClient(res) {
        this.clients.add(res);
        res.on('close', () => this.clients.delete(res));
    }

    /**
     * Broadcast to all SSE clients
     */
    broadcast(entry) {
        const data = `data: ${JSON.stringify(entry)}\n\n`;
        for (const client of this.clients) {
            try {
                client.write(data);
            } catch {
                this.clients.delete(client);
            }
        }
    }
}

// Singleton
const logBuffer = new LogBuffer();

// Intercept console.log to capture server logs
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
    originalLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (!msg.includes('SSE') && msg.trim()) {
        logBuffer.info(msg.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''));
    }
};

console.warn = (...args) => {
    originalWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    logBuffer.warn(msg.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''));
};

console.error = (...args) => {
    originalError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    logBuffer.error(msg.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''));
};

module.exports = logBuffer;
