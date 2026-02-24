const config = require('../config');
const db = require('../models');
const eventBus = require('../services/eventBus');

/**
 * API Key Authentication Middleware
 * 
 * Two-tier auth:
 *   1. Master key (MEMOLO_MASTER_KEY env var) — admin access
 *   2. Per-agent key (stored in agents.api_key) — agent-specific access
 * 
 * Skips:
 *   - GET /api/health (monitoring)
 *   - All requests when MEMOLO_MASTER_KEY is not set (local dev mode)
 */
function apiKeyAuth(req, res, next) {
    // Skip auth for health, logs/SSE (EventSource can't set headers), and API info
    if (
        req.path === '/api/health' || req.path === '/health' ||
        req.path.startsWith('/api/logs') ||
        req.path === '/api'
    ) {
        return next();
    }

    // Skip auth for dashboard (non-API routes: static files, SPA)
    if (!req.path.startsWith('/api/')) {
        return next();
    }

    // GET requests are read-only → allow without auth (dashboard needs this)
    if (req.method === 'GET') {
        return next();
    }

    // These POST endpoints are read-only queries (dashboard uses them)
    const readOnlyPosts = ['/api/memory/search', '/api/memory/recall', '/api/intelligence/run'];
    if (req.method === 'POST' && readOnlyPosts.includes(req.path)) {
        return next();
    }

    // Dev mode: no master key configured → auth disabled
    const masterKey = config.security.masterKey;
    if (!masterKey) {
        return next();
    }

    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        eventBus.push('warn', `🔒 Auth rejected: no API key — ${req.method} ${req.path}`, { source: 'auth' });
        return res.status(401).json({
            error: 'API key required',
            hint: 'Set X-API-Key header. Register agent with master key to get a per-agent key.',
        });
    }

    // Check master key first (fast path, no DB query)
    if (apiKey === masterKey) {
        req.authType = 'master';
        return next();
    }

    // Check per-agent key (DB lookup)
    db.findAgentByApiKey(apiKey)
        .then(agent => {
            if (agent) {
                req.authType = 'agent';
                req.authAgent = agent;
                return next();
            }
            eventBus.push('warn', `🔒 Auth rejected: invalid key — ${req.method} ${req.path}`, { source: 'auth' });
            return res.status(401).json({ error: 'Invalid API key' });
        })
        .catch(err => {
            console.error('Auth error:', err.message);
            return res.status(500).json({ error: 'Authentication check failed' });
        });
}

module.exports = apiKeyAuth;
