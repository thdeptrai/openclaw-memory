const express = require('express');
const router = express.Router();
const intelligenceService = require('../services/intelligenceService');
const scheduler = require('../services/scheduler');
const db = require('../models');

/**
 * POST /api/intelligence/run
 * Manually trigger all intelligence tasks
 */
router.post('/run', async (req, res) => {
    try {
        const results = {};

        const { tasks = ['decay', 'dedup'] } = req.body;

        if (tasks.includes('decay')) {
            results.decayCount = await intelligenceService.applyDecay();
        }
        if (tasks.includes('dedup')) {
            results.mergedCount = await intelligenceService.detectAndMergeDuplicates();
        }

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('Intelligence run error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/intelligence/permissions/grant
 * Grant read permission between agents
 */
router.post('/permissions/grant', async (req, res) => {
    try {
        const { agentId, canReadFrom, level } = req.body;

        if (!agentId || !canReadFrom) {
            return res.status(400).json({ error: 'Missing required fields: agentId, canReadFrom' });
        }

        await intelligenceService.grantPermission(agentId, canReadFrom, level || 'read');
        res.json({ success: true, message: `Permission granted: ${agentId} can read from ${canReadFrom}` });
    } catch (error) {
        console.error('Grant permission error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/intelligence/permissions/revoke
 * Revoke read permission
 */
router.post('/permissions/revoke', async (req, res) => {
    try {
        const { agentId, canReadFrom } = req.body;

        if (!agentId || !canReadFrom) {
            return res.status(400).json({ error: 'Missing required fields: agentId, canReadFrom' });
        }

        await intelligenceService.revokePermission(agentId, canReadFrom);
        res.json({ success: true, message: `Permission revoked` });
    } catch (error) {
        console.error('Revoke permission error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/intelligence/permissions/team
 * Grant all-to-all permissions for a team of agents
 */
router.post('/permissions/team', async (req, res) => {
    try {
        const { agentIds } = req.body;

        if (!agentIds || !Array.isArray(agentIds) || agentIds.length < 2) {
            return res.status(400).json({ error: 'agentIds must be an array with at least 2 agent IDs' });
        }

        await intelligenceService.grantTeamAccess(agentIds);
        res.json({
            success: true,
            message: `Team access granted for ${agentIds.length} agents`,
            agents: agentIds,
        });
    } catch (error) {
        console.error('Team permission error:', error);
        res.status(500).json({ error: error.message });
    }
});


/**
 * GET /api/intelligence/stats
 * Get intelligence system stats
 */
router.get('/stats', async (req, res) => {
    try {
        const [memories, merged, agents, exchanges, conversations] = await Promise.all([
            db.query('SELECT COUNT(*) as total, AVG(importance_score) as avg_importance FROM memories WHERE merged_into IS NULL'),
            db.query('SELECT COUNT(*) as total FROM memories WHERE merged_into IS NOT NULL'),
            db.query('SELECT COUNT(*) as total FROM agents'),
            db.query('SELECT COUNT(*) as total FROM exchanges'),
            db.query('SELECT COUNT(*) as total FROM conversations'),
        ]);

        res.json({
            success: true,
            data: {
                activeMemories: parseInt(memories.rows[0].total),
                totalExchanges: parseInt(exchanges.rows[0].total),
                totalConversations: parseInt(conversations.rows[0].total),
                averageImportance: parseFloat(memories.rows[0].avg_importance || 0).toFixed(3),
                mergedDuplicates: parseInt(merged.rows[0].total),
                registeredAgents: parseInt(agents.rows[0].total),
            },
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
