const { Pool } = require('pg');
const crypto = require('crypto');
const config = require('../config');

const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    user: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL error:', err);
});

// ==================== AGENTS ====================

async function registerAgent(id, name, description = '') {
    // Generate API key for new agents
    const apiKey = crypto.randomBytes(32).toString('hex');
    const result = await pool.query(
        `INSERT INTO agents (id, name, description, api_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = $2, description = $3
     RETURNING *`,
        [id, name, description, apiKey]
    );
    return result.rows[0];
}

async function findAgentByApiKey(apiKey) {
    const result = await pool.query(
        'SELECT * FROM agents WHERE api_key = $1',
        [apiKey]
    );
    return result.rows[0] || null;
}

async function regenerateApiKey(agentId) {
    const newKey = crypto.randomBytes(32).toString('hex');
    const result = await pool.query(
        'UPDATE agents SET api_key = $1 WHERE id = $2 RETURNING *',
        [newKey, agentId]
    );
    return result.rows[0] || null;
}

async function getAgent(id) {
    const result = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
    return result.rows[0] || null;
}

async function getAllAgents() {
    const result = await pool.query(`
        SELECT a.*,
               COUNT(DISTINCT c.id)::int AS conversation_count,
               COUNT(e.id)::int AS exchange_count,
               MAX(e.created_at) AS last_active_at
        FROM agents a
        LEFT JOIN conversations c ON c.agent_id = a.id
        LEFT JOIN exchanges e ON e.conversation_id = c.id
        GROUP BY a.id
        ORDER BY a.created_at
    `);
    return result.rows;
}

// ==================== CONVERSATIONS ====================

async function createConversation(agentId, userId = 'default', title = '', topic = null, id = null) {
    if (id) {
        const result = await pool.query(
            `INSERT INTO conversations (id, agent_id, user_id, title, profile)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
            [id, agentId, userId, title, JSON.stringify(topic ? { topic } : {})]
        );
        return result.rows[0];
    }
    const result = await pool.query(
        `INSERT INTO conversations (agent_id, user_id, title, profile)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
        [agentId, userId, title, JSON.stringify(topic ? { topic } : {})]
    );
    return result.rows[0];
}

async function getConversation(id) {
    const result = await pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
    return result.rows[0] || null;
}

async function updateConversation(id, updates) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
    }

    values.push(id);
    const result = await pool.query(
        `UPDATE conversations SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
    );
    return result.rows[0];
}

async function getAgentConversations(agentId, limit = 20) {
    const result = await pool.query(
        `SELECT * FROM conversations WHERE agent_id = $1
     ORDER BY started_at DESC LIMIT $2`,
        [agentId, limit]
    );
    return result.rows;
}

async function updateConversationProfile(id, profileUpdate) {
    // Merge new profile data into existing profile
    const result = await pool.query(
        `UPDATE conversations 
     SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
     WHERE id = $2 RETURNING *`,
        [JSON.stringify(profileUpdate), id]
    );
    return result.rows[0];
}

async function getConversationProfile(id) {
    const result = await pool.query(
        'SELECT profile FROM conversations WHERE id = $1',
        [id]
    );
    if (!result.rows[0]) return {};
    return result.rows[0].profile || {};
}

// ==================== EXCHANGES ====================

async function addExchange(conversationId, userMessage, agentResponse) {
    // Get next sequence number
    const seqResult = await pool.query(
        'SELECT COALESCE(MAX(sequence_num), 0) + 1 as next_seq FROM exchanges WHERE conversation_id = $1',
        [conversationId]
    );
    const sequenceNum = seqResult.rows[0].next_seq;

    const result = await pool.query(
        `INSERT INTO exchanges (conversation_id, user_message, agent_response, sequence_num)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
        [conversationId, userMessage, agentResponse, sequenceNum]
    );

    // Update conversation message count
    await pool.query(
        'UPDATE conversations SET message_count = message_count + 1 WHERE id = $1',
        [conversationId]
    );

    return result.rows[0];
}

async function getExchanges(conversationId, limit = 50) {
    const result = await pool.query(
        `SELECT * FROM exchanges WHERE conversation_id = $1
     ORDER BY sequence_num ASC LIMIT $2`,
        [conversationId, limit]
    );
    return result.rows;
}

async function getRecentExchanges(conversationId, limit = 5) {
    const result = await pool.query(
        `SELECT * FROM exchanges WHERE conversation_id = $1
     ORDER BY sequence_num DESC LIMIT $2`,
        [conversationId, limit]
    );
    return result.rows.reverse();
}

async function getExchangeCount(conversationId) {
    const result = await pool.query(
        'SELECT COUNT(*) as count FROM exchanges WHERE conversation_id = $1',
        [conversationId]
    );
    return parseInt(result.rows[0].count);
}

// ==================== MEMORIES ====================

async function addMemory({ type, content, sourceConversationId, sourceAgentId, importanceScore = 0.5, tags = [], metadata = {}, topic = 'general', scope = 'unknown', category = null, contentHash = null, actorId = 'user', memoryType = 'knowledge' }) {
    // Auto-generate content hash if not provided (MD5 for O(1) exact-match dedup)
    const hash = contentHash || require('crypto').createHash('md5').update(content).digest('hex');
    const result = await pool.query(
        `INSERT INTO memories (type, content, source_conversation_id, source_agent_id, importance_score, tags, metadata, topic, scope, category, content_hash, actor_id, memory_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
        [type, content, sourceConversationId, sourceAgentId, importanceScore, tags, JSON.stringify(metadata), topic, scope, category, hash, actorId, memoryType]
    );
    return result.rows[0];
}

/**
 * Check if a memory with the exact content hash already exists for an agent.
 * Returns the existing memory if found, null otherwise.
 */
async function findMemoryByHash(contentHash, agentId) {
    const result = await pool.query(
        `SELECT * FROM memories WHERE content_hash = $1 AND source_agent_id = $2 AND is_active = true LIMIT 1`,
        [contentHash, agentId]
    );
    return result.rows[0] || null;
}

async function supersedeMemory(oldMemoryId, newMemoryId) {
    await pool.query(
        'UPDATE memories SET superseded_by = $1 WHERE id = $2',
        [newMemoryId, oldMemoryId]
    );
}

async function getActiveMemoriesByTopic(topic, agentId = null, limit = 20) {
    let sql = `SELECT * FROM memories WHERE superseded_by IS NULL AND topic = $1`;
    const params = [topic];
    let idx = 2;
    if (agentId) {
        sql += ` AND source_agent_id = $${idx}`;
        params.push(agentId);
        idx++;
    }
    sql += ` ORDER BY importance_score DESC, created_at DESC LIMIT $${idx}`;
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
}

async function getMemoriesByAgent(agentId, limit = 20) {
    const result = await pool.query(
        `SELECT * FROM memories WHERE source_agent_id = $1
     ORDER BY created_at DESC LIMIT $2`,
        [agentId, limit]
    );
    return result.rows;
}

async function getMemoriesByConversation(conversationId, limit = 50) {
    const result = await pool.query(
        `SELECT m.* FROM memories m
     JOIN memory_conversations mc ON mc.memory_id = m.id
     WHERE mc.conversation_id = $1 AND m.superseded_by IS NULL
     ORDER BY m.created_at DESC LIMIT $2`,
        [conversationId, limit]
    );
    return result.rows;
}

async function linkMemoryToConversation(memoryId, conversationId) {
    if (!memoryId || !conversationId) return;
    await pool.query(
        `INSERT INTO memory_conversations (memory_id, conversation_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [memoryId, conversationId]
    );
}

async function migrateMemoryLinks(oldMemoryId, newMemoryId) {
    if (!oldMemoryId || !newMemoryId) return;
    // Copy all conversation links from old memory to new memory
    await pool.query(
        `INSERT INTO memory_conversations (memory_id, conversation_id)
     SELECT $2, conversation_id FROM memory_conversations WHERE memory_id = $1
     ON CONFLICT DO NOTHING`,
        [oldMemoryId, newMemoryId]
    );
}

async function getRecentMemories(agentId, limit = 10) {
    const result = await pool.query(
        `SELECT * FROM memories WHERE source_agent_id = $1
     ORDER BY importance_score DESC, created_at DESC LIMIT $2`,
        [agentId, limit]
    );
    return result.rows;
}

async function searchMemories(query, agentId = null, limit = 20) {
    let sql = `SELECT * FROM memories WHERE content ILIKE $1 AND superseded_by IS NULL`;
    const params = [`%${query}%`];
    let paramIndex = 2;

    if (agentId) {
        sql += ` AND source_agent_id = $${paramIndex}`;
        params.push(agentId);
        paramIndex++;
    }

    sql += ` ORDER BY importance_score DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await pool.query(sql, params);
    return result.rows;
}

async function updateMemoryAccess(memoryId) {
    await pool.query(
        'UPDATE memories SET last_accessed_at = NOW() WHERE id = $1',
        [memoryId]
    );
}

// ==================== SUMMARIES ====================

async function addSummary({ conversationId, fromSequence, toSequence, summaryText, factsExtracted = [], decisionsMade = [] }) {
    const result = await pool.query(
        `INSERT INTO summaries (conversation_id, from_sequence, to_sequence, summary_text, facts_extracted, decisions_made)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        [conversationId, fromSequence, toSequence, summaryText, JSON.stringify(factsExtracted), JSON.stringify(decisionsMade)]
    );
    return result.rows[0];
}

async function getSummaries(conversationId) {
    const result = await pool.query(
        'SELECT * FROM summaries WHERE conversation_id = $1 ORDER BY from_sequence ASC',
        [conversationId]
    );
    return result.rows;
}

async function getLatestSummarySequence(conversationId) {
    const result = await pool.query(
        'SELECT COALESCE(MAX(to_sequence), 0) as last_seq FROM summaries WHERE conversation_id = $1',
        [conversationId]
    );
    return parseInt(result.rows[0].last_seq);
}

async function setSummarizationStatus(conversationId, status, { retryCount, failedAt, pendingFrom, pendingTo } = {}) {
    const sets = ['summarization_status = $2'];
    const params = [conversationId, status];
    let idx = 3;
    if (retryCount !== undefined) { sets.push(`summarization_retry_count = $${idx++}`); params.push(retryCount); }
    if (failedAt !== undefined) { sets.push(`summarization_failed_at = $${idx++}`); params.push(failedAt); }
    if (pendingFrom !== undefined) { sets.push(`summarization_pending_from = $${idx++}`); params.push(pendingFrom); }
    if (pendingTo !== undefined) { sets.push(`summarization_pending_to = $${idx++}`); params.push(pendingTo); }
    await pool.query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function getUnsummarizedConversations(threshold = 5) {
    const result = await pool.query(`
        SELECT c.id, c.agent_id, c.summarization_status, c.summarization_retry_count,
               c.summarization_failed_at, c.summarization_pending_from, c.summarization_pending_to,
               COUNT(e.id)::int as exchange_count,
               MAX(e.sequence_num)::int as max_sequence,
               COALESCE(MAX(s.to_sequence), 0)::int as last_summarized,
               MAX(e.created_at) as last_exchange_at
        FROM conversations c
        JOIN exchanges e ON e.conversation_id = c.id
        LEFT JOIN summaries s ON s.conversation_id = c.id
        GROUP BY c.id
        HAVING (
            COALESCE(c.summarization_status, 'idle') IN ('failed', 'pending')
            OR (COALESCE(c.summarization_status, 'idle') = 'in_progress' AND c.summarization_failed_at < NOW() - INTERVAL '10 minutes')
            OR (
                COALESCE(c.summarization_status, 'idle') IN ('idle', 'completed')
                AND MAX(e.sequence_num) - COALESCE(MAX(s.to_sequence), 0) >= $1
            )
            OR (
                COALESCE(c.summarization_status, 'idle') = 'idle'
                AND MAX(e.sequence_num) - COALESCE(MAX(s.to_sequence), 0) > 0
                AND MAX(e.created_at) < NOW() - INTERVAL '10 minutes'
            )
        )
    `, [threshold]);
    return result.rows;
}

async function addSummaryWithMemories({ conversationId, fromSequence, toSequence, summaryText, factsExtracted = [], decisionsMade = [] }, memories = []) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Insert summary
        const summaryResult = await client.query(
            `INSERT INTO summaries (conversation_id, from_sequence, to_sequence, summary_text, facts_extracted, decisions_made)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [conversationId, fromSequence, toSequence, summaryText, JSON.stringify(factsExtracted), JSON.stringify(decisionsMade)]
        );
        const summary = summaryResult.rows[0];

        // Insert all memories in same transaction
        const savedMemories = [];
        for (const mem of memories) {
            const memResult = await client.query(
                `INSERT INTO memories (type, content, source_conversation_id, source_agent_id, importance_score, tags, metadata, topic, scope, category)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [mem.type, mem.content, mem.sourceConversationId, mem.sourceAgentId,
                mem.importanceScore || 0.5, mem.tags || [], JSON.stringify(mem.metadata || {}),
                mem.topic || 'general', mem.scope || 'unknown', mem.category || null]
            );
            savedMemories.push(memResult.rows[0]);
        }

        await client.query('COMMIT');
        return { summary, memories: savedMemories };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ==================== MEMORY HISTORY ====================

async function addMemoryHistory({ memoryId, event, oldContent = null, newContent = null, changedBy = 'system', changeReason = null, metadata = {} }) {
    const result = await pool.query(
        `INSERT INTO memory_history (memory_id, event, old_content, new_content, changed_by, change_reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
        [memoryId, event, oldContent, newContent, changedBy, changeReason, JSON.stringify(metadata)]
    );
    return result.rows[0];
}

async function getMemoryHistory(memoryId, limit = 50) {
    const result = await pool.query(
        'SELECT * FROM memory_history WHERE memory_id = $1 ORDER BY created_at DESC LIMIT $2',
        [memoryId, limit]
    );
    return result.rows;
}

async function getRecentHistory(limit = 50) {
    const result = await pool.query(
        `SELECT mh.*, m.type as memory_type, m.source_agent_id
     FROM memory_history mh
     LEFT JOIN memories m ON m.id = mh.memory_id
     ORDER BY mh.created_at DESC LIMIT $1`,
        [limit]
    );
    return result.rows;
}

// ==================== CROSS-AGENT ==

async function searchAcrossAgents(query, excludeAgentId = null, limit = 20) {
    let sql = `
    SELECT m.*, a.name as agent_name
    FROM memories m
    JOIN agents a ON m.source_agent_id = a.id
    WHERE m.content ILIKE $1
  `;
    const params = [`%${query}%`];
    let paramIndex = 2;

    if (excludeAgentId) {
        sql += ` AND m.source_agent_id != $${paramIndex}`;
        params.push(excludeAgentId);
        paramIndex++;
    }

    sql += ` ORDER BY m.importance_score DESC, m.created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await pool.query(sql, params);
    return result.rows;
}

/**
 * Given an array of memory IDs, return only those that are active (not superseded).
 */
async function getActiveMemoryIds(ids) {
    if (!ids || ids.length === 0) return [];
    const result = await pool.query(
        `SELECT id::text FROM memories WHERE id = ANY($1::uuid[]) AND superseded_by IS NULL`,
        [ids]
    );
    return result.rows.map(r => r.id);
}

// ==================== UTILS ====================

async function query(sql, params) {
    return pool.query(sql, params);
}

// ==================== CATEGORIES ====================

async function getCategories(agentId) {
    const result = await pool.query(
        'SELECT * FROM memory_categories WHERE agent_id = $1 ORDER BY name',
        [agentId]
    );
    return result.rows;
}

async function addCategory(agentId, name, description = '') {
    const result = await pool.query(
        `INSERT INTO memory_categories (agent_id, name, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, name) DO NOTHING
         RETURNING *`,
        [agentId, name, description]
    );
    return result.rows[0] || null;
}

async function linkMemoryToCategory(memoryId, categoryId) {
    if (!memoryId || !categoryId) return;
    await pool.query(
        `INSERT INTO memory_category_items (memory_id, category_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [memoryId, categoryId]
    );
    // Increment memory count
    await pool.query(
        'UPDATE memory_categories SET memory_count = memory_count + 1 WHERE id = $1',
        [categoryId]
    );
}

async function updateCategorySummary(categoryId, summary) {
    await pool.query(
        'UPDATE memory_categories SET summary = $1, summary_updated_at = NOW() WHERE id = $2',
        [summary, categoryId]
    );
}

async function getCategoryMemories(categoryId, limit = 50) {
    const result = await pool.query(
        `SELECT m.* FROM memories m
         JOIN memory_category_items mc ON mc.memory_id = m.id
         WHERE mc.category_id = $1 AND m.superseded_by IS NULL
         ORDER BY m.importance_score DESC, m.created_at DESC LIMIT $2`,
        [categoryId, limit]
    );
    return result.rows;
}

async function reinforceMemory(memoryId) {
    await pool.query(
        'UPDATE memories SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1 WHERE id = $1',
        [memoryId]
    );
}

async function close() {
    await pool.end();
}

module.exports = {
    pool,
    query,
    close,
    // Agents
    registerAgent,
    getAgent,
    getAllAgents,
    findAgentByApiKey,
    regenerateApiKey,
    // Conversations
    createConversation,
    getConversation,
    updateConversation,
    getAgentConversations,
    updateConversationProfile,
    getConversationProfile,
    // Exchanges
    addExchange,
    getExchanges,
    getRecentExchanges,
    getExchangeCount,
    // Memories
    addMemory,
    findMemoryByHash,
    supersedeMemory,
    getMemoriesByAgent,
    getMemoriesByConversation,
    linkMemoryToConversation,
    migrateMemoryLinks,
    getRecentMemories,
    getActiveMemoriesByTopic,
    searchMemories,
    getActiveMemoryIds,
    updateMemoryAccess,
    reinforceMemory,
    // Categories
    getCategories,
    addCategory,
    linkMemoryToCategory,
    updateCategorySummary,
    getCategoryMemories,
    // Summaries
    addSummary,
    addSummaryWithMemories,
    getSummaries,
    getLatestSummarySequence,
    // Summarization Status
    setSummarizationStatus,
    getUnsummarizedConversations,
    // Cross-Agent
    searchAcrossAgents,
    // Memory History
    addMemoryHistory,
    getMemoryHistory,
    getRecentHistory,
};
