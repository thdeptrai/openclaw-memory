const crypto = require('crypto');
const db = require('../models');
const vectorStore = require('./vectorStore');
const embeddingService = require('./embeddingService');
const summarizer = require('./summarizer');
const config = require('../config');
const runtimeConfig = require('../runtimeConfig');
const llmService = require('./llmService');

/**
 * Intelligence Service — Handles scoring, decay, consolidation, and dedup
 */
class IntelligenceService {

    // ==================== IMPORTANCE SCORING ====================

    /**
     * Boost importance when a memory is accessed
     */
    async boostOnAccess(memoryId) {
        await db.query(
            `UPDATE memories
       SET importance_score = LEAST(importance_score + 0.05, 1.0),
           access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = NOW()
       WHERE id = $1`,
            [memoryId]
        );
    }

    /**
     * Apply time-based decay to all memories
     * Memories that haven't been accessed recently lose importance
     */
    async applyDecay() {
        const result = await db.query(`
      UPDATE memories
      SET decay_factor = GREATEST(
        0.1,
        CASE
          WHEN last_accessed_at IS NULL THEN
            1.0 - (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) * 0.01
          ELSE
            1.0 - (EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0) * 0.005
        END
      ),
      importance_score = GREATEST(
        0.1,
        importance_score * GREATEST(
          0.1,
          CASE
            WHEN last_accessed_at IS NULL THEN
              1.0 - (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) * 0.01
            ELSE
              1.0 - (EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0) * 0.005
          END
        )
      )
      WHERE importance_score > 0.1
      RETURNING id
    `);

        console.log(`📉 Decay applied to ${result.rowCount} memories`);
        return result.rowCount;
    }

    // ==================== DUPLICATE DETECTION ====================

    /**
     * Generate content hash for duplicate detection
     */
    generateHash(content) {
        const normalized = content.toLowerCase().trim().replace(/\s+/g, ' ');
        return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    }

    /**
     * Find and merge duplicate memories
     */
    async detectAndMergeDuplicates() {
        let mergedCount = 0;

        // Step 1: Update hashes for memories without one
        const unhashed = await db.query(
            `SELECT id, content FROM memories WHERE content_hash IS NULL AND merged_into IS NULL`
        );

        for (const row of unhashed.rows) {
            const hash = this.generateHash(row.content);
            await db.query('UPDATE memories SET content_hash = $1 WHERE id = $2', [hash, row.id]);
        }

        // Step 2: Find exact hash duplicates
        const duplicates = await db.query(`
      SELECT content_hash, array_agg(id ORDER BY importance_score DESC, created_at ASC) as ids,
             COUNT(*) as cnt
      FROM memories
      WHERE content_hash IS NOT NULL AND merged_into IS NULL
      GROUP BY content_hash
      HAVING COUNT(*) > 1
    `);

        for (const group of duplicates.rows) {
            const ids = group.ids;
            const keepId = ids[0]; // Keep highest importance
            const mergeIds = ids.slice(1);

            // Merge: boost importance of kept memory, mark others
            const boostAmount = mergeIds.length * 0.05;
            await db.query(
                `UPDATE memories SET importance_score = LEAST(importance_score + $1, 1.0) WHERE id = $2`,
                [boostAmount, keepId]
            );

            for (const mergeId of mergeIds) {
                await db.query(
                    `UPDATE memories SET merged_into = $1 WHERE id = $2`,
                    [keepId, mergeId]
                );
            }

            mergedCount += mergeIds.length;
        }

        // Step 3: Find near-duplicate via embedding similarity
        try {
            const recentMemories = await db.query(
                `SELECT id, content FROM memories
         WHERE merged_into IS NULL AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC LIMIT 100`
            );

            for (const mem of recentMemories.rows) {
                const embedding = await embeddingService.generateEmbedding(mem.content);
                const similar = await vectorStore.searchSimilar(embedding, { limit: 5 });

                for (const match of similar) {
                    if (match.id !== mem.id && match.score > 0.95) {
                        // Very high similarity — likely duplicate
                        const existingMem = await db.query('SELECT * FROM memories WHERE id = $1', [match.id]);
                        if (existingMem.rows.length > 0 && !existingMem.rows[0].merged_into) {
                            // Keep the older one, merge newer
                            await db.query('UPDATE memories SET merged_into = $1 WHERE id = $2', [match.id, mem.id]);
                            await db.query(
                                'UPDATE memories SET importance_score = LEAST(importance_score + 0.05, 1.0) WHERE id = $1',
                                [match.id]
                            );
                            mergedCount++;
                            break;
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️ Near-duplicate detection skipped:', err.message);
        }

        console.log(`🔗 Merged ${mergedCount} duplicate memories`);
        return mergedCount;
    }

    // ==================== KNOWLEDGE CONSOLIDATION ====================

    /**
     * Consolidate ALL memories into a coherent knowledge base.
     * Strategy: FULL REBUILD — LLM produces a complete, deduplicated KB from all facts.
     * This avoids topic drift, semantic duplicates, and contradictions.
     */
    async consolidateKnowledge() {
        // 1. Get ALL active fact/decision/insight memories (not just recent)
        const allMemories = await db.query(`
      SELECT m.content, m.type, m.created_at, a.name as agent_name, m.id as memory_id
      FROM memories m
      JOIN agents a ON m.source_agent_id = a.id
      WHERE m.merged_into IS NULL
        AND m.type IN ('fact', 'decision', 'insight')
      ORDER BY m.created_at DESC
    `);

        if (allMemories.rows.length < 1) {
            console.log('📚 No memories to consolidate');
            return 0;
        }

        console.log(`📚 Consolidating ${allMemories.rows.length} memories into knowledge base...`);

        // 2. Dynamic token-budget batching — pack memories until context window is ~70% full
        const provider = runtimeConfig.get('llm.provider') || 'minimax';
        const isMiniMax = provider === 'minimax';

        const CHARS_PER_TOKEN = 3.5;
        // MiniMax: 2013 total tokens (input + output combined!)
        // Budget: ~1000 input + ~1000 output = ~2000 (under 2013 limit)
        const MAX_INPUT_TOKENS = isMiniMax ? 1000 : 28000;
        const MAX_TOKENS_OUTPUT = isMiniMax ? 1000 : 2000;

        // Reserve tokens for system prompt (~60 for MiniMax, ~80 for Ollama)
        // + user prompt template overhead (~140 for MiniMax, ~200 for Ollama)
        const PROMPT_OVERHEAD_TOKENS = isMiniMax ? 200 : 280;
        // Use 70% of remaining budget for memories (leave margin for safety)
        const MEMORY_TOKEN_BUDGET = Math.floor((MAX_INPUT_TOKENS - PROMPT_OVERHEAD_TOKENS) * 0.7);
        const MEMORY_CHAR_BUDGET = Math.floor(MEMORY_TOKEN_BUDGET * CHARS_PER_TOKEN);

        // Build batches by filling each one up to the char budget
        const batches = [];
        let currentBatch = [];
        let currentChars = 0;

        for (const mem of allMemories.rows) {
            // Format: "[2026-02-21] content..." — date prefix is ~13 chars
            const memText = mem.content.substring(0, isMiniMax ? 200 : 500);
            const lineChars = 13 + memText.length + 1; // date + content + newline

            if (currentChars + lineChars > MEMORY_CHAR_BUDGET && currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [];
                currentChars = 0;
            }

            currentBatch.push(mem);
            currentChars += lineChars;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);

        const avgPerBatch = Math.round(allMemories.rows.length / Math.max(1, batches.length));
        console.log(`  📦 ${batches.length} batches, avg ${avgPerBatch}/batch (budget: ${MEMORY_CHAR_BUDGET} chars ≈ ${MEMORY_TOKEN_BUDGET} tokens, provider: ${provider})`);

        const allEntries = [];
        const allMemoryIds = allMemories.rows.map(r => r.memory_id);

        // 3. Compact prompts for MiniMax
        const kbSystemPrompt = isMiniMax
            ? 'Build KB from memories. Return JSON array: [{"topic":"...", "content":"...", "confidence":0.9}]. Keep original language.'
            : 'You are building a knowledge base from AI agent memories. Return ONLY a JSON array of knowledge entries.';

        // 4. Process each batch
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx];
            const memoriesText = batch.map(m => {
                const date = new Date(m.created_at).toISOString().split('T')[0];
                return `[${date}] ${m.content.substring(0, isMiniMax ? 200 : 500)}`;
            }).join('\n');

            // Build compact user prompt
            const kbUserPrompt = isMiniMax
                ? `Batch ${batchIdx + 1}/${batches.length}. Group into 3-8 topics. Newest date wins contradictions.\n\nMEMORIES:\n${memoriesText}\n\nReturn JSON array only.`
                : `This is batch ${batchIdx + 1} of ${batches.length}.

RULES:
1. Create MULTIPLE topic entries — each topic should cover a DISTINCT subject area
2. Topics must be broad categories (e.g. "User Location", "Tech Stack Preferences")
3. If memories CONTRADICT each other, ONLY keep the NEWEST information (check dates)
4. Each entry: 1-3 sentences of CURRENT facts only
5. Create 3-8 topics per batch
6. Keep the ORIGINAL LANGUAGE (Vietnamese stays Vietnamese)

MEMORIES:
${memoriesText}

Return a JSON array:
[{ "topic": "Broad Topic", "content": "Current facts.", "confidence": 0.9 }]

Return ONLY the JSON array.`;

            try {
                const response = await llmService.chatJSON(kbSystemPrompt, kbUserPrompt, {
                    maxTokens: MAX_TOKENS_OUTPUT,
                    timeout: isMiniMax ? 60000 : 180000,
                    purpose: 'kb_consolidation',
                });

                let entries;
                if (Array.isArray(response)) {
                    entries = response;
                } else if (typeof response === 'object' && response !== null) {
                    entries = response.entries || response.data || Object.values(response).find(v => Array.isArray(v)) || [];
                } else {
                    entries = [];
                }

                console.log(`  📦 Batch ${batchIdx + 1}/${batches.length}: ${entries.length} entries from ${batch.length} memories`);
                allEntries.push(...entries.filter(e => e.topic && e.content));
            } catch (err) {
                console.warn(`  ⚠️ Batch ${batchIdx + 1} failed: ${err.message.substring(0, 100)}`);

                // Fallback: local extraction for this batch (no LLM)
                const localEntries = this._localKBExtraction(batch);
                if (localEntries.length > 0) {
                    console.log(`  📦 Batch ${batchIdx + 1}: ${localEntries.length} entries via local fallback`);
                    allEntries.push(...localEntries);
                }
            }
        }

        if (allEntries.length === 0) {
            console.log('📚 LLM returned empty entries, skipping rebuild');
            return 0;
        }

        // 4. Deduplicate entries by topic (merge entries with same/similar topics)
        const topicMap = new Map();
        for (const entry of allEntries) {
            const normalizedTopic = entry.topic.trim().toLowerCase();
            if (topicMap.has(normalizedTopic)) {
                // Merge content
                const existing = topicMap.get(normalizedTopic);
                existing.content += ' ' + entry.content;
                existing.confidence = Math.max(existing.confidence || 0.5, entry.confidence || 0.5);
            } else {
                topicMap.set(normalizedTopic, { ...entry });
            }
        }

        const finalEntries = Array.from(topicMap.values());

        // 5. Get agent IDs for tracking
        const agentIdRows = await db.query(
            `SELECT DISTINCT source_agent_id FROM memories WHERE merged_into IS NULL`
        );
        const sourceAgentIds = agentIdRows.rows.map(r => r.source_agent_id);

        // 6. FULL REBUILD: clear old KB and insert new coherent version
        await db.query('DELETE FROM knowledge_base');

        let insertedCount = 0;
        for (const entry of finalEntries) {
            if (!entry.topic || !entry.content) continue;
            await db.query(
                `INSERT INTO knowledge_base (topic, content, source_agent_ids, confidence_score, source_memory_ids)
       VALUES ($1, $2, $3, $4, $5)`,
                [
                    entry.topic.substring(0, 300),
                    entry.content,
                    sourceAgentIds,
                    entry.confidence || 0.5,
                    allMemoryIds,
                ]
            );
            insertedCount++;
        }

        console.log(`📚 Knowledge base rebuilt: ${insertedCount} entries from ${allMemories.rows.length} memories`);
        return insertedCount;
    }

    /**
     * Mem0-style incremental KB consolidation.
     * For each new fact: search existing KB → LLM decides ADD/UPDATE/DELETE/NOOP → execute.
     * Called immediately after fact extraction (not batched).
     * @param {Array<{content: string, type: string}>} newFacts - newly extracted facts
     */
    async consolidateNewFacts(newFacts) {
        if (!newFacts || newFacts.length === 0) return { added: 0, updated: 0, deleted: 0, unchanged: 0 };

        const stats = { added: 0, updated: 0, deleted: 0, unchanged: 0 };
        const provider = runtimeConfig.get('llm.provider') || 'minimax';
        const isMiniMax = provider === 'minimax';

        for (const fact of newFacts) {
            try {
                const factText = fact.content || fact;
                if (!factText || factText.length < 5) continue;

                // 1. Search existing KB for similar entries
                let existingEntries = [];
                try {
                    const kbResults = await db.query(
                        `SELECT id, topic, content, confidence_score FROM knowledge_base
                         ORDER BY confidence_score DESC LIMIT 50`
                    );

                    // Simple keyword matching to find related KB entries
                    const factWords = factText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    existingEntries = kbResults.rows
                        .map(kb => {
                            const kbText = (kb.topic + ' ' + kb.content).toLowerCase();
                            const hits = factWords.filter(w => kbText.includes(w)).length;
                            return { ...kb, relevance: hits / Math.max(factWords.length, 1) };
                        })
                        .filter(kb => kb.relevance > 0.2)
                        .sort((a, b) => b.relevance - a.relevance)
                        .slice(0, 5);
                } catch { /* KB table may not exist yet */ }

                // 2. LLM decides: ADD, UPDATE, DELETE, or NOOP
                const existingFormatted = existingEntries.length > 0
                    ? existingEntries.map((e, i) => `[${i}] topic="${e.topic}" | ${e.content}`).join('\n')
                    : '(empty)';

                const systemPrompt = isMiniMax
                    ? 'You manage a knowledge base. Given a new fact and existing KB entries, decide: ADD (new entry), UPDATE (modify existing), DELETE (contradicts existing), or NOOP (already known). Return JSON only.'
                    : `You are a smart KB manager. Compare a new fact against existing KB entries and decide the action.
Operations:
- ADD: new information not in KB → create new entry with topic and content
- UPDATE: enriches or corrects an existing entry → specify which entry ID to update
- DELETE: directly contradicts an existing entry → specify which entry ID to delete
- NOOP: fact already captured in KB → no change needed
Return JSON only. Keep the ORIGINAL LANGUAGE of the fact.`;

                const userPrompt = `EXISTING KB:
${existingFormatted}

NEW FACT: "${factText}"

Return JSON:
{"action": "ADD|UPDATE|DELETE|NOOP", "entry_id": null_or_index, "topic": "...", "content": "...", "confidence": 0.9}

- For ADD: provide topic + content for the new entry
- For UPDATE: provide entry_id (index) + updated content
- For DELETE: provide entry_id (index)
- For NOOP: just return action=NOOP
Return ONLY the JSON.`;

                const decision = await llmService.chatJSON(systemPrompt, userPrompt, {
                    maxTokens: isMiniMax ? 500 : 1000,
                    timeout: isMiniMax ? 30000 : 60000,
                    purpose: 'kb_consolidation',
                });

                if (!decision || !decision.action) continue;

                // 3. Execute the decision
                const action = decision.action.toUpperCase();

                if (action === 'ADD' && decision.topic && decision.content) {
                    await db.query(
                        `INSERT INTO knowledge_base (topic, content, confidence_score, source_memories, last_updated)
                         VALUES ($1, $2, $3, $4, NOW())`,
                        [decision.topic, decision.content, decision.confidence || 0.8, JSON.stringify([])]
                    );
                    stats.added++;
                    console.log(`  📥 KB ADD: "${decision.topic}" → ${decision.content.substring(0, 60)}...`);

                } else if (action === 'UPDATE' && decision.entry_id != null) {
                    const idx = parseInt(decision.entry_id);
                    if (idx >= 0 && idx < existingEntries.length) {
                        const target = existingEntries[idx];
                        await db.query(
                            `UPDATE knowledge_base SET content = $1, confidence_score = $2, last_updated = NOW()
                             WHERE id = $3`,
                            [decision.content || target.content, decision.confidence || target.confidence_score, target.id]
                        );
                        stats.updated++;
                        console.log(`  ✏️ KB UPDATE [${target.topic}]: ${(decision.content || '').substring(0, 60)}...`);
                    }

                } else if (action === 'DELETE' && decision.entry_id != null) {
                    const idx = parseInt(decision.entry_id);
                    if (idx >= 0 && idx < existingEntries.length) {
                        const target = existingEntries[idx];
                        await db.query(`DELETE FROM knowledge_base WHERE id = $1`, [target.id]);
                        stats.deleted++;
                        console.log(`  🗑️ KB DELETE [${target.topic}]: contradicted`);
                    }

                } else {
                    stats.unchanged++;
                }

            } catch (err) {
                console.warn(`  ⚠️ KB consolidation failed for fact: ${err.message}`);
            }
        }

        if (stats.added + stats.updated + stats.deleted > 0) {
            console.log(`📚 KB incremental update: +${stats.added} ✏️${stats.updated} 🗑️${stats.deleted} =${stats.unchanged}`);
        }
        return stats;
    }

    // ==================== LOCAL KB EXTRACTION (fallback) ====================

    /**
     * Group memories into topic entries without LLM.
     * Simple keyword-based grouping as fallback when LLM fails.
     */
    _localKBExtraction(memories) {
        const topics = new Map();
        const TOPIC_KEYWORDS = {
            'Tech Stack': /react|node|express|postgresql|qdrant|docker|redis|nginx|typescript|python|api|backend|frontend/i,
            'Architecture': /architecture|pattern|design|module|service|layer|microservice|monolith/i,
            'Database': /database|sql|query|migration|schema|table|index|postgres/i,
            'Deployment': /deploy|docker|ci\/cd|server|hosting|production|staging/i,
            'Testing': /test|jest|coverage|qa|unit|integration|e2e/i,
            'Security': /auth|security|token|password|encrypt|ssl|permission/i,
            'User Preferences': /thích|prefer|muốn|sở thích|style|convention/i,
            'Performance': /performance|cache|optimize|speed|latency|memory/i,
        };

        for (const mem of memories) {
            let matched = false;
            for (const [topic, pattern] of Object.entries(TOPIC_KEYWORDS)) {
                if (pattern.test(mem.content)) {
                    if (!topics.has(topic)) topics.set(topic, []);
                    topics.get(topic).push(mem.content.substring(0, 150));
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                const topic = 'General Knowledge';
                if (!topics.has(topic)) topics.set(topic, []);
                topics.get(topic).push(mem.content.substring(0, 150));
            }
        }

        return Array.from(topics.entries()).map(([topic, contents]) => ({
            topic,
            content: contents.slice(0, 5).join('. '),
            // More memories backing a topic = higher confidence
            confidence: Math.min(0.9, 0.7 + contents.length * 0.05),
        }));
    }

    // ==================== PERMISSIONS ====================

    /**
     * Check if an agent can read memories from another agent
     */
    async canAgentRead(requestingAgentId, targetAgentId) {
        // Same agent always allowed
        if (requestingAgentId === targetAgentId) return true;

        // Check explicit permissions
        const result = await db.query(
            `SELECT * FROM agent_permissions
       WHERE agent_id = $1 AND can_read_from = $2`,
            [requestingAgentId, targetAgentId]
        );

        // If no explicit permission, default to shared memories only
        return result.rows.length > 0;
    }

    /**
     * Grant read permission between agents
     */
    async grantPermission(agentId, canReadFrom, level = 'read') {
        await db.query(
            `INSERT INTO agent_permissions (agent_id, can_read_from, permission_level)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, can_read_from) DO UPDATE SET permission_level = $3`,
            [agentId, canReadFrom, level]
        );
    }

    /**
     * Revoke permission
     */
    async revokePermission(agentId, canReadFrom) {
        await db.query(
            `DELETE FROM agent_permissions WHERE agent_id = $1 AND can_read_from = $2`,
            [agentId, canReadFrom]
        );
    }

    /**
     * Grant all-to-all read permissions for a list of agents
     */
    async grantTeamAccess(agentIds) {
        for (const a of agentIds) {
            for (const b of agentIds) {
                if (a !== b) {
                    await this.grantPermission(a, b);
                }
            }
        }
    }

    /**
     * Get memories respecting visibility & permissions
     */
    async getAccessibleMemories(requestingAgentId, query, limit = 20) {
        // Get agents this one can read from
        const perms = await db.query(
            `SELECT can_read_from FROM agent_permissions WHERE agent_id = $1`,
            [requestingAgentId]
        );
        const allowedAgents = [requestingAgentId, ...perms.rows.map(r => r.can_read_from)];

        const placeholders = allowedAgents.map((_, i) => `$${i + 2}`).join(', ');
        const result = await db.query(
            `SELECT * FROM memories
       WHERE merged_into IS NULL
         AND (visibility = 'shared' OR source_agent_id IN (${placeholders}))
         AND content ILIKE $1
       ORDER BY importance_score DESC, created_at DESC
       LIMIT $${allowedAgents.length + 2}`,
            [`%${query}%`, ...allowedAgents, limit]
        );

        return result.rows;
    }
}

module.exports = new IntelligenceService();
