const express = require('express');
const router = express.Router();
const eventBus = require('../services/eventBus');
const db = require('../models');

/**
 * GET /api/logs — Recent logs
 */
router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit || '50');
    res.json({ success: true, data: eventBus.getRecent(limit) });
});

/**
 * GET /api/logs/events — Recent typed events (non-log)
 */
router.get('/events', (req, res) => {
    const limit = parseInt(req.query.limit || '20');
    res.json({ success: true, data: eventBus.getRecentEvents(limit) });
});

/**
 * GET /api/logs/stream — SSE endpoint for ALL real-time events
 * Events: log, exchange:new, memory:new, summarize:done, stats:update
 */
router.get('/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    // Send connected event
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Register client (eventBus will send recent events for catch-up)
    eventBus.addClient(res);

    // Push stats every 10s to this client
    const statsInterval = setInterval(async () => {
        try {
            const stats = await getQuickStats();
            const event = { type: 'stats:update', data: stats };
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch { /* ignore */ }
    }, 10000);

    // Keepalive every 30s
    const keepalive = setInterval(() => {
        res.write(':keepalive\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(statsInterval);
        clearInterval(keepalive);
    });
});

/**
 * Quick stats for periodic push (lightweight query)
 */
async function getQuickStats() {
    try {
        const [memResult, agentResult, convResult, exResult] = await Promise.all([
            db.query(`SELECT 
                COUNT(*) FILTER(WHERE superseded_by IS NULL) as active,
                COUNT(*) FILTER(WHERE superseded_by IS NOT NULL) as superseded,
                COUNT(*) as total
                FROM memories`),
            db.query('SELECT COUNT(*) as cnt FROM agents'),
            db.query('SELECT COUNT(*) as cnt FROM conversations'),
            db.query('SELECT COUNT(*) as cnt FROM exchanges'),
        ]);
        return {
            activeMemories: parseInt(memResult.rows[0].active),
            supersededMemories: parseInt(memResult.rows[0].superseded),
            totalMemories: parseInt(memResult.rows[0].total),
            registeredAgents: parseInt(agentResult.rows[0].cnt),
            totalConversations: parseInt(convResult.rows[0].cnt),
            totalExchanges: parseInt(exResult.rows[0].cnt),
            sseClients: eventBus.clientCount,
            timestamp: new Date().toISOString(),
        };
    } catch {
        return {};
    }
}

module.exports = router;
