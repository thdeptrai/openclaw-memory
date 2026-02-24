const express = require('express');
const router = express.Router();
const memoryService = require('../services/memoryService');
const db = require('../models');
const eventBus = require('../services/eventBus');
const { buildContextFromMemories } = require('../utils/contextBuilder');

/**
 * POST /api/memory/store
 * Store a conversation exchange
 */
router.post('/store', async (req, res) => {
    try {
        const { agentId, conversationId, userMessage, agentResponse, tags, metadata, topic } = req.body;

        if (!agentId || !userMessage || !agentResponse) {
            return res.status(400).json({
                error: 'Missing required fields: agentId, userMessage, agentResponse',
            });
        }

        const result = await memoryService.store({
            agentId,
            conversationId,
            userMessage,
            agentResponse,
            tags: tags || [],
            metadata: metadata || {},
            topic: topic || null,
        });

        eventBus.push('info', `📥 Store: agent=${agentId} conv=${result.conversationId}`, { source: 'api' });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Store error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/recall
 * Retrieve relevant memories for a query
 */
router.post('/recall', async (req, res) => {
    try {
        const { query, agentId, conversationId, limit, includeOtherAgents, format, topic } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'Missing required field: query' });
        }

        const memories = await memoryService.recall(query, {
            agentId,
            conversationId,
            limit: limit || 10,
            includeOtherAgents: includeOtherAgents !== false,
            topic: topic || null,
        });

        // Optionally return formatted context string for direct LLM injection
        if (format === 'context') {
            const context = buildContextFromMemories(memories);
            return res.json({ success: true, context, raw: memories });
        }

        eventBus.push('info', `🔍 Recall: query="${query?.substring(0, 40)}..." agent=${agentId || 'all'}`, { source: 'api' });
        res.json({ success: true, data: memories });
    } catch (error) {
        console.error('Recall error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/search
 * Full-text + semantic search across all agents
 */
router.post('/search', async (req, res) => {
    try {
        const { query, agentId, limit } = req.body;

        // If empty query, return all recent memories from DB
        if (!query || !query.trim()) {
            const memories = await db.searchMemories('', agentId, limit || 50);
            return res.json({ success: true, data: memories });
        }

        const results = await memoryService.search(query, {
            agentId,
            limit: limit || 20,
        });

        eventBus.push('info', `🔎 Search: query="${(query || '').substring(0, 40)}" results=${results.length}`, { source: 'api' });
        res.json({ success: true, data: results });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/summarize
 * Manually trigger summarization for a conversation
 */
router.post('/summarize', async (req, res) => {
    try {
        const { conversationId } = req.body;

        if (!conversationId) {
            return res.status(400).json({ error: 'Missing required field: conversationId' });
        }

        const conv = await db.getConversation(conversationId);
        if (!conv) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const lastSeq = await db.getLatestSummarySequence(conversationId);
        const count = await db.getExchangeCount(conversationId);

        if (count <= lastSeq) {
            return res.json({ success: true, message: 'Nothing new to summarize' });
        }

        const summary = await memoryService.triggerSummarization(
            conversationId, conv.agent_id, lastSeq + 1, count
        );

        res.json({ success: true, data: summary });
    } catch (error) {
        console.error('Summarize error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/conversations/:id
 * Get conversation details with exchanges
 */
router.get('/conversations/:id', async (req, res) => {
    try {
        const conv = await db.getConversation(req.params.id);
        if (!conv) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const exchanges = await db.getExchanges(conv.id);
        const summaries = await db.getSummaries(conv.id);
        const memories = await db.getMemoriesByConversation(conv.id);

        res.json({
            success: true,
            data: { ...conv, exchanges, summaries, memories },
        });
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/conversations/:id/end
 * End a conversation and trigger final summarization
 */
router.post('/conversations/:id/end', async (req, res) => {
    try {
        const result = await memoryService.endConversation(req.params.id);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('End conversation error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/agents/:agentId/recent
 * Get recent memories for an agent
 */
router.get('/agents/:agentId/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '20');
        const memories = await db.getRecentMemories(req.params.agentId, limit);
        const conversations = await db.getAgentConversations(req.params.agentId, 10);

        res.json({
            success: true,
            data: { memories, recentConversations: conversations },
        });
    } catch (error) {
        console.error('Get agent memories error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/agents/register
 * Register a new agent — returns API key for authentication
 */
router.post('/agents/register', async (req, res) => {
    try {
        const { id, name, description } = req.body;

        if (!id || !name) {
            return res.status(400).json({ error: 'Missing required fields: id, name' });
        }

        const agent = await db.registerAgent(id, name, description || '');
        eventBus.emit('agent:new', { agentId: id, name, description: description || '' });
        res.json({
            success: true,
            data: {
                id: agent.id,
                name: agent.name,
                description: agent.description,
                apiKey: agent.api_key,
                created_at: agent.created_at,
            },
        });
    } catch (error) {
        console.error('Register agent error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/agents/:id/regenerate-key
 * Generate a new API key for an agent (invalidates old key)
 */
router.post('/agents/:id/regenerate-key', async (req, res) => {
    try {
        const agent = await db.regenerateApiKey(req.params.id);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        res.json({
            success: true,
            data: {
                id: agent.id,
                name: agent.name,
                apiKey: agent.api_key,
            },
        });
    } catch (error) {
        console.error('Regenerate key error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/agents
 * List all registered agents
 */
router.get('/agents', async (req, res) => {
    try {
        const agents = await db.getAllAgents();
        res.json({ success: true, data: agents });
    } catch (error) {
        console.error('List agents error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/exchanges
 * List all exchanges across all agents (for dashboard)
 */
router.get('/exchanges', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50');
        const agentId = req.query.agentId || null;

        let sql = `
            SELECT e.*, c.agent_id 
            FROM exchanges e 
            JOIN conversations c ON e.conversation_id = c.id
        `;
        const params = [];
        let paramIndex = 1;

        if (agentId) {
            sql += ` WHERE c.agent_id = $${paramIndex}`;
            params.push(agentId);
            paramIndex++;
        }

        sql += ` ORDER BY e.created_at DESC LIMIT $${paramIndex}`;
        params.push(limit);

        const result = await db.query(sql, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List exchanges error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/conversations
 * List all conversations (for dashboard)
 */
router.get('/conversations', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50');
        const result = await db.query(
            `SELECT c.*, a.name as agent_name,
                    (SELECT COUNT(*) FROM exchanges e WHERE e.conversation_id = c.id) as exchange_count,
                    (SELECT MAX(e.created_at) FROM exchanges e WHERE e.conversation_id = c.id) as last_exchange_at
             FROM conversations c 
             LEFT JOIN agents a ON c.agent_id = a.id 
             ORDER BY COALESCE((SELECT MAX(e.created_at) FROM exchanges e WHERE e.conversation_id = c.id), c.started_at) DESC 
             LIMIT $1`,
            [limit]
        );
        // Add updated_at for frontend
        const data = result.rows.map(r => ({
            ...r,
            updated_at: r.last_exchange_at || r.started_at,
        }));
        res.json({ success: true, data });
    } catch (error) {
        console.error('List conversations error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/memory/:id
 * Update memory metadata — confirm, reject, supersede, change scope/topic
 */
router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { action, supersededBy, topic, scope, importance } = req.body;

        // Validate memory exists
        const existing = await db.query('SELECT * FROM memories WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Memory not found' });
        }

        const memory = existing.rows[0];
        const updates = [];
        const values = [];
        let paramIdx = 1;

        switch (action) {
            case 'confirm':
                // Mark as confirmed — boost importance
                updates.push(`importance_score = LEAST(importance_score + 0.1, 1.0)`);
                updates.push(`tags = array_append(tags, 'confirmed')`);
                break;

            case 'reject':
                // Mark as rejected — set importance to 0 (soft delete)
                updates.push(`importance_score = 0`);
                updates.push(`tags = array_append(tags, 'rejected')`);
                break;

            case 'supersede':
                // Manually supersede by another memory
                if (!supersededBy) {
                    return res.status(400).json({ error: 'supersededBy is required for supersede action' });
                }
                await db.supersedeMemory(id, supersededBy);
                return res.json({ success: true, message: `Memory ${id} superseded by ${supersededBy}` });

            case 'update':
                // Update topic, scope, or importance
                if (topic !== undefined) { updates.push(`topic = $${paramIdx++}`); values.push(topic); }
                if (scope !== undefined) { updates.push(`scope = $${paramIdx++}`); values.push(scope); }
                if (importance !== undefined) { updates.push(`importance_score = $${paramIdx++}`); values.push(importance); }
                break;

            default:
                return res.status(400).json({ error: `Unknown action: ${action}. Valid: confirm, reject, supersede, update` });
        }

        if (updates.length > 0) {
            values.push(id);
            const sql = `UPDATE memories SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
            const result = await db.query(sql, values);

            eventBus.emit('memory:updated', {
                memoryId: id,
                action,
                agentId: memory.source_agent_id,
            });

            res.json({ success: true, data: result.rows[0] });
        } else {
            res.json({ success: true, data: memory });
        }
    } catch (error) {
        console.error('Patch memory error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/memories
 * List all memories with optional filters for dashboard management
 */
router.get('/memories', async (req, res) => {
    try {
        const { topic, scope, type, agentId, superseded, limit = 50 } = req.query;

        let sql = `
            SELECT m.*, a.name as agent_name
            FROM memories m
            LEFT JOIN agents a ON m.source_agent_id = a.id
            WHERE 1=1
        `;
        const values = [];
        let paramIdx = 1;

        if (topic) { sql += ` AND m.topic = $${paramIdx++}`; values.push(topic); }
        if (scope) { sql += ` AND m.scope = $${paramIdx++}`; values.push(scope); }
        if (type) { sql += ` AND m.type = $${paramIdx++}`; values.push(type); }
        if (agentId) { sql += ` AND m.source_agent_id = $${paramIdx++}`; values.push(agentId); }
        if (superseded === 'true') {
            sql += ` AND m.superseded_by IS NOT NULL`;
        } else if (superseded === 'false') {
            sql += ` AND m.superseded_by IS NULL`;
        }

        sql += ` ORDER BY m.created_at DESC LIMIT $${paramIdx++}`;
        values.push(parseInt(limit));

        const result = await db.query(sql, values);
        res.json({ success: true, data: result.rows, total: result.rows.length });
    } catch (error) {
        console.error('List memories error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/topics
 * List all unique topics with memory counts
 */
router.get('/topics', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                COALESCE(topic, 'general') as topic,
                COUNT(*) as memory_count,
                COUNT(*) FILTER(WHERE superseded_by IS NULL) as active_count,
                COUNT(*) FILTER(WHERE superseded_by IS NOT NULL) as superseded_count,
                MAX(created_at) as last_activity
            FROM memories
            GROUP BY COALESCE(topic, 'general')
            ORDER BY MAX(created_at) DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List topics error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/memory/memories/add
 * Manually add a memory (user-created knowledge)
 */
router.post('/memories/add', async (req, res) => {
    try {
        const { content, type = 'fact', agentId, tags = [], topic = 'general', importance = 0.7 } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const embeddingService = require('../services/embeddingService');
        const vectorStore = require('../services/vectorStore');

        // Create memory in PG
        const mem = await db.addMemory({
            type,
            content: content.trim(),
            sourceConversationId: null,
            sourceAgentId: agentId || null,
            importanceScore: importance,
            tags,
            topic,
            scope: 'universal',
            category: null,
            contentHash: require('crypto').createHash('md5').update(content.trim()).digest('hex'),
            actorId: 'manual',
        });

        // Generate embedding and index in Qdrant
        try {
            const embedding = await embeddingService.generateEmbedding(content.trim());
            await vectorStore.upsertVector(mem.id, embedding, {
                memory_id: mem.id,
                agent_id: agentId || 'manual',
                type,
                content: content.trim().substring(0, 500),
                importance_score: importance,
                topic,
                scope: 'universal',
                created_at: new Date().toISOString(),
            });
        } catch (embErr) {
            console.warn('⚠️ Manual memory: embedding failed, memory still saved:', embErr.message);
        }

        eventBus.push('info', `✏️ Manual memory added: "${content.substring(0, 50)}..."`, { source: 'dashboard' });
        res.json({ success: true, data: mem });
    } catch (error) {
        console.error('Add memory error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/memory/:id
 * Delete a specific memory by ID (from both PG and Qdrant)
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const vectorStore = require('../services/vectorStore');

        // Delete from PG
        const result = await db.query(
            'DELETE FROM memories WHERE id = $1 RETURNING id, content',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Memory not found' });
        }

        // Delete from Qdrant vector store
        try {
            await vectorStore.deleteVector(id);
            await vectorStore.deleteByFilter('memory_id', id);
        } catch (vecErr) {
            console.warn('⚠️ Vector deletion failed (non-critical):', vecErr.message);
        }

        // Delete conversation links
        try {
            await db.query('DELETE FROM memory_conversations WHERE memory_id = $1', [id]);
        } catch { /* non-critical */ }

        eventBus.push('info', `🗑️ Memory deleted: ${id.substring(0, 8)}...`, { source: 'dashboard' });
        res.json({ success: true, deleted: id });
    } catch (error) {
        console.error('Delete memory error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/memories/:id/history
 * Get audit trail for a specific memory
 */
router.get('/memories/:id/history', async (req, res) => {
    try {
        const history = await db.getMemoryHistory(req.params.id);
        res.json({ success: true, data: history });
    } catch (error) {
        console.error('Memory history error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/memory/history
 * Get recent memory changes (global audit log)
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50');
        const history = await db.getRecentHistory(limit);
        res.json({ success: true, data: history });
    } catch (error) {
        console.error('Recent history error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
