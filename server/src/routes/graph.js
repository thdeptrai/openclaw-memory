/**
 * Graph API Routes — Knowledge Graph endpoints
 */
const express = require('express');
const router = express.Router();
const graphService = require('../services/graphService');

/**
 * GET /api/graph/entities/:agentId
 * Get all entities for an agent
 */
router.get('/entities/:agentId', async (req, res) => {
    try {
        const type = req.query.type || null;
        const limit = parseInt(req.query.limit || '100');
        const entities = await graphService.getEntities(req.params.agentId, { type, limit });
        res.json({ success: true, data: entities });
    } catch (error) {
        console.error('Get entities error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/graph/entities/search
 * Search entities by name
 */
router.get('/entities/search', async (req, res) => {
    try {
        const { query, agentId } = req.query;
        if (!query) return res.status(400).json({ error: 'Missing query parameter' });
        const entities = await graphService.searchEntities(query, agentId);
        res.json({ success: true, data: entities });
    } catch (error) {
        console.error('Search entities error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/graph/neighborhood/:entityNameOrId
 * Get entity neighborhood (entity + connections)
 */
router.get('/neighborhood/:entityNameOrId', async (req, res) => {
    try {
        const agentId = req.query.agentId;
        if (!agentId) return res.status(400).json({ error: 'Missing agentId query parameter' });
        const neighborhood = await graphService.getEntityNeighborhood(req.params.entityNameOrId, agentId);
        res.json({ success: true, data: neighborhood });
    } catch (error) {
        console.error('Neighborhood error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/graph/:agentId
 * Get full graph for an agent (for visualization)
 */
router.get('/:agentId', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '200');
        const graph = await graphService.getAgentGraph(req.params.agentId, limit);
        res.json({ success: true, data: graph });
    } catch (error) {
        console.error('Agent graph error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
