const express = require('express');
const router = express.Router();
const db = require('../models');
const vectorStore = require('../services/vectorStore');
const { checkOllamaHealth } = require('../services/embeddingService');

router.get('/', async (req, res) => {
    const checks = {
        server: 'ok',
        postgres: 'checking...',
        qdrant: 'checking...',
        ollama: 'checking...',
    };

    // Check PostgreSQL
    try {
        await db.query('SELECT 1');
        checks.postgres = 'ok';
    } catch {
        checks.postgres = 'error';
    }

    // Check Qdrant
    try {
        const ok = await vectorStore.checkHealth();
        checks.qdrant = ok ? 'ok' : 'error';
    } catch {
        checks.qdrant = 'error';
    }

    // Check Ollama
    try {
        const result = await checkOllamaHealth();
        checks.ollama = result.available ? (result.hasModel ? 'ok' : 'missing model') : 'error';
    } catch {
        checks.ollama = 'error';
    }

    const allOk = Object.values(checks).every(v => v === 'ok');

    res.status(allOk ? 200 : 503).json({
        status: allOk ? 'healthy' : 'degraded',
        checks,
        timestamp: new Date().toISOString(),
    });
});

module.exports = router;
