const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const vectorStore = require('./vectorStore');
const embeddingService = require('./embeddingService');
const config = require('../config');
const eventBus = require('./eventBus');
const contradictionDetector = require('./contradictionDetector');
const factExtractor = require('./factExtractor');
const memoryDeduplicator = require('./memoryDeduplicator');
const graphService = require('./graphService');
const reranker = require('./reranker');
const llmService = require('./llmService');
const categoryService = require('./categoryService');

// Lazy-load to avoid circular dependency
let intelligenceService = null;


function getIntelligenceService() {
    if (!intelligenceService) {
        intelligenceService = require('./intelligenceService');
    }
    return intelligenceService;
}

/**
 * Core Memory Service — orchestrates all memory operations
 */


// Feature flag — enable real-time fact extraction (default: true)
const runtimeConfig = require('../runtimeConfig');

class MemoryService {

    /**
     * Store a conversation exchange and index it
     */
    async store({ agentId, conversationId, userMessage, agentResponse, tags = [], metadata = {}, topic = null }) {
        // Auto-register agent if needed
        await db.registerAgent(agentId, agentId);

        // Resolve conversation topic from existing profile or explicit param
        let conversationTopic = topic || 'general';

        // Create conversation if needed
        if (!conversationId) {
            const conv = await db.createConversation(agentId, 'default', '', topic);
            conversationId = conv.id;
        } else {
            // Verify conversation exists, create if not
            const existing = await db.getConversation(conversationId);
            if (!existing) {
                await db.createConversation(agentId, 'default', '', topic, conversationId);
            } else {
                // Inherit topic from existing conversation profile
                const profile = existing.profile || {};
                if (!topic && profile.topic) {
                    conversationTopic = profile.topic;
                }
                // If explicit topic provided and differs, update conversation
                if (topic && profile.topic !== topic) {
                    await db.updateConversationProfile(conversationId, { topic });
                }
            }
        }

        // Store raw exchange
        const exchange = await db.addExchange(conversationId, userMessage, agentResponse);

        // Emit real-time event
        eventBus.emit('exchange:new', {
            exchangeId: exchange.id,
            conversationId,
            agentId,
            userMessage: userMessage.substring(0, 200),
            agentResponse: agentResponse.substring(0, 200),
            sequenceNum: exchange.sequence_num,
        });

        // Mem0 style: Do NOT embed raw exchanges into Qdrant.
        // Only extracted facts get embedded (via batchProcessor → memoryDeduplicator).
        // Exchanges are kept in Postgres only (for history/audit).

        // === Real-time Fact Extraction + Dedup (via batch processor) ===
        if (runtimeConfig.get('factExtraction.enabled')) {
            const batchProcessor = require('./batchProcessor');
            batchProcessor.enqueue({
                agentId,
                conversationId,
                userMessage,
                agentResponse,
                topic: conversationTopic,
            });
        }

        return {
            exchangeId: exchange.id,
            conversationId,
            sequenceNum: exchange.sequence_num,
            factExtractionEnabled: runtimeConfig.get('factExtraction.enabled'),
        };
    }

    /**
     * Recall relevant memories for a query
     * Mem0-style: returns extracted facts only — no raw exchanges
     */
    async recall(query, { agentId, conversationId = null, limit = 10, includeOtherAgents = true, topic = null } = {}) {
        const results = {
            semanticMemories: [],  // facts, decisions, insights, preferences only
            crossAgentMemories: [],
            categorySummaries: [],
            summaries: [],
            conversationProfile: null,
        };

        // --- Query Enrichment: use conversation profile for better semantic match ---
        let enrichedQuery = query;
        let activeProfile = {};
        if (conversationId) {
            try {
                activeProfile = await db.getConversationProfile(conversationId);
                results.conversationProfile = activeProfile;
                enrichedQuery = this._enrichQuery(query, activeProfile);
            } catch { /* profile not available, use raw query */ }
        }
        // Override topic from explicit param
        const activeTopic = topic || activeProfile.topic || null;

        // Detect query intent for smart boosting
        const isPreferenceQuery = /th[íi]ch|s[ởo]\s*th[íi]ch|prefer|mu[ốo]n\s*d[ùu]ng|chọn\s*gì/i.test(query);
        const queryKeywords = query.toLowerCase()
            .replace(/[^\w\sàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2);

        // === Smart Retrieval: Query Rewriting (opt-in, +1 LLM call) ===
        if (runtimeConfig.get('retrieval.queryRewriting') && conversationId) {
            try {
                const recentExchanges = await db.getRecentExchanges(conversationId, 3);
                if (recentExchanges.length > 0) {
                    const historyContext = recentExchanges.map(e =>
                        `User: ${(e.user_message || '').substring(0, 200)}\nAgent: ${(e.agent_response || '').substring(0, 200)}`
                    ).join('\n---\n');
                    const rewriteResult = await llmService.chatJSON(
                        `You rewrite queries to be self-contained by resolving pronouns, references, and ambiguities using conversation history. Return JSON: {"rewritten_query": "..."}`,
                        `RECENT CONVERSATION:\n${historyContext}\n\nORIGINAL QUERY: ${enrichedQuery}\n\nRewrite this query to be fully self-contained. If already clear, return the original.`,
                        { maxTokens: 200, timeout: 10000, purpose: 'query_rewrite' }
                    );
                    if (rewriteResult.rewritten_query && rewriteResult.rewritten_query.length > 5) {
                        enrichedQuery = rewriteResult.rewritten_query;
                        console.log(`🔄 Query rewritten: "${query}" → "${enrichedQuery}"`);
                    }
                }
            } catch (err) {
                console.warn('⚠️ Query rewriting failed:', err.message);
            }
        }

        // 1. Semantic search via Qdrant — use ENRICHED query for better matching
        // Two-pass strategy: when topic is active, first search with topic filter,
        // then search broadly for universal/general content. Merge + deduplicate.
        try {
            const embedding = await embeddingService.generateEmbedding(enrichedQuery);
            const searchLimit = limit * 3; // Get 3x candidates for re-ranking
            const baseThreshold = runtimeConfig.get('memory.vectorScoreThreshold') || 0.3;
            let semanticResults;

            if (activeTopic) {
                // Pass 1: Topic-filtered search — guaranteed topic-relevant results
                const topicResults = await vectorStore.searchSimilar(embedding, {
                    limit: searchLimit,
                    agentId: agentId && !includeOtherAgents ? agentId : null,
                    topic: activeTopic,
                    scoreThreshold: baseThreshold,
                });

                // Pass 2: Broad search — picks up universal prefs, general knowledge, cross-project
                const broadResults = await vectorStore.searchSimilar(embedding, {
                    limit: Math.ceil(searchLimit / 2),
                    agentId: agentId && !includeOtherAgents ? agentId : null,
                    scoreThreshold: baseThreshold + 0.10, // higher threshold for non-topic content
                });

                // Merge and deduplicate (topic results first)
                const seenIds = new Set();
                semanticResults = [];
                for (const r of topicResults) {
                    seenIds.add(r.id);
                    semanticResults.push(r);
                }
                for (const r of broadResults) {
                    if (!seenIds.has(r.id)) {
                        seenIds.add(r.id);
                        semanticResults.push(r);
                    }
                }
            } else {
                // No topic context — single broad search
                semanticResults = await vectorStore.searchSimilar(embedding, {
                    limit: searchLimit,
                    agentId: agentId && !includeOtherAgents ? agentId : null,
                    scoreThreshold: baseThreshold + 0.05,
                });
            }

            // Re-rank results with keyword boost + importance score
            let rankedResults = semanticResults.map(r => {
                let finalScore = r.score;
                const content = (r.payload.content || '').toLowerCase();
                const userMsg = (r.payload.user_message || '').toLowerCase();
                const importance = r.payload.importance_score || 0.5;

                // Penalize low-importance (greetings)
                if (importance < 0.2) {
                    finalScore *= 0.3; // Heavy penalty for greetings
                } else if (importance < 0.4) {
                    finalScore *= 0.6;
                }

                // Boost for importance
                finalScore *= (0.7 + importance * 0.3);

                // Keyword match boost
                let keywordHits = 0;
                for (const kw of queryKeywords) {
                    if (content.includes(kw) || userMsg.includes(kw)) keywordHits++;
                }
                if (queryKeywords.length > 0) {
                    const keywordRatio = keywordHits / queryKeywords.length;
                    finalScore += keywordRatio * 0.15; // up to +0.15 for keyword match
                }

                // Agent filter boost: if agentId specified, boost matching agent
                if (agentId && r.payload.agent_id === agentId) {
                    finalScore += 0.05;
                }

                // Topic-aware soft boost (NEVER hard filter)
                // The boost/penalty must be strong enough to overcome semantic similarity
                // when two projects discuss the same technology (e.g., PostgreSQL in both)
                const memTopic = r.payload.topic || 'general';
                const memScope = r.payload.scope || 'unknown';
                if (activeTopic) {
                    // Extract base topic name (e.g., "shoply-abc" → "shoply", "ecommerce-app" stays as-is)
                    const baseActive = activeTopic.replace(/-[a-z0-9]{3,6}$/i, '').toLowerCase();
                    const baseMem = memTopic.replace(/-[a-z0-9]{3,6}$/i, '').toLowerCase();

                    if (memTopic === activeTopic) {
                        finalScore += 0.25; // Exact topic match → strongest boost
                    } else if (baseMem === baseActive && baseMem !== 'general') {
                        finalScore += 0.10; // Same project base name → moderate boost
                    } else if (memTopic !== 'general' && memScope !== 'universal') {
                        finalScore -= 0.10; // Different project → penalty (not for universal/general)
                    }
                }
                if (memScope === 'universal') {
                    finalScore += 0.08; // Universal knowledge always boosted (prefs, style)
                }

                // Recency boost — newer memories get SIGNIFICANT advantage
                // This is critical for resolving contradictions (e.g., old "lives in Saigon" vs new "moved to Da Nang")
                const createdAt = r.payload.created_at ? new Date(r.payload.created_at) : null;
                if (createdAt) {
                    const ageMs = Date.now() - createdAt.getTime();
                    const ageDays = ageMs / (1000 * 60 * 60 * 24);

                    if (ageDays < 1) {
                        finalScore *= 1.15; // Very recent: +15% boost
                    } else if (ageDays < 3) {
                        finalScore *= 1.10; // Recent: +10%
                    } else if (ageDays < 7) {
                        finalScore *= 1.05; // This week: +5%
                    } else if (ageDays > 30) {
                        finalScore *= 0.90; // Older than a month: -10% penalty
                    }
                }

                return {
                    id: r.id,
                    score: Math.min(1.0, finalScore),
                    originalScore: r.score,
                    content: r.payload.content,
                    userMessage: r.payload.user_message,
                    type: r.payload.type,
                    memoryType: r.payload.memory_type || 'knowledge',
                    agentId: r.payload.agent_id,
                    conversationId: r.payload.conversation_id,
                    importanceScore: importance,
                    topic: memTopic,
                    scope: memScope,
                    createdAt: r.payload.created_at,
                };
            });

            // Filter by agentId if specified (even when includeOtherAgents=true, prioritize)
            if (agentId && !includeOtherAgents) {
                rankedResults = rankedResults.filter(r => r.agentId === agentId);
            }

            // Filter out superseded/merged memories — these are outdated facts
            if (rankedResults.length > 0) {
                try {
                    const memIds = rankedResults.map(r => r.id);
                    const obsolete = await db.query(
                        `SELECT id FROM memories WHERE id = ANY($1) AND merged_into IS NOT NULL`,
                        [memIds]
                    );
                    if (obsolete.rows.length > 0) {
                        const obsoleteIds = new Set(obsolete.rows.map(r => r.id));
                        rankedResults = rankedResults.filter(r => !obsoleteIds.has(r.id));
                    }
                } catch { /* non-critical — proceed without filter */ }
            }

            // Mem0-style: exclude raw exchanges — only return extracted facts
            // Note: after re-ranking, results are flat objects (r.type, not r.payload.type)
            const FACT_TYPES = new Set(['fact', 'decision', 'insight', 'preference']);
            rankedResults = rankedResults.filter(r => {
                const memType = r.type || 'exchange';
                return FACT_TYPES.has(memType);
            });

            // Sort by re-ranked score and take top N
            rankedResults.sort((a, b) => b.score - a.score);
            results.semanticMemories = rankedResults.slice(0, limit);

            // Boost importance of accessed memories + reinforcement
            const intel = getIntelligenceService();
            for (const mem of results.semanticMemories) {
                intel.boostOnAccess(mem.id).catch(() => { });
                db.reinforceMemory(mem.id).catch(() => { });
            }
        } catch (err) {
            console.warn('⚠️ Semantic search failed:', err.message);
        }

        // 2-5: Run independent data sources IN PARALLEL
        // These are all read-only queries that don't depend on each other.
        const parallelTasks = [];

        // Task A: Summaries only (no raw exchanges — Mem0 style)
        parallelTasks.push(conversationId ? (async () => {
            const summaries = await db.getSummaries(conversationId);
            results.summaries = summaries.map(s => ({
                id: s.id,
                summary: s.summary_text,
                facts: s.facts_extracted,
                decisions: s.decisions_made,
                fromSeq: s.from_sequence,
                toSeq: s.to_sequence,
            }));
        })() : Promise.resolve());

        // Task B: Category summaries (always fetch if available)
        parallelTasks.push(agentId ? (async () => {
            try {
                const categories = await categoryService.getCategoriesWithCache(agentId);
                const withSummaries = categories.filter(c => c.summary && c.summary.length > 0);
                if (withSummaries.length > 0) {
                    results.categorySummaries = withSummaries.map(c => ({
                        name: c.name,
                        summary: c.summary,
                        memoryCount: c.memory_count,
                        updatedAt: c.summary_updated_at,
                    }));
                }
            } catch { /* categories may not exist yet */ }
        })() : Promise.resolve());

        // Task C: Cross-agent memories (permission-aware)
        parallelTasks.push((includeOtherAgents && agentId) ? (async () => {
            try {
                const intel = getIntelligenceService();
                const crossMemories = await intel.getAccessibleMemories(
                    agentId, query, Math.ceil(limit / 3)
                );
                results.crossAgentMemories = crossMemories
                    .filter(m => m.source_agent_id !== agentId)
                    .map(m => ({
                        id: m.id,
                        type: m.type,
                        content: m.content,
                        agentId: m.source_agent_id,
                        importanceScore: m.importance_score,
                        createdAt: m.created_at,
                    }));
            } catch {
                // Fallback to simple cross-agent search
                try {
                    const crossMemories = await db.searchAcrossAgents(query, agentId, Math.ceil(limit / 3));
                    results.crossAgentMemories = crossMemories.map(m => ({
                        id: m.id,
                        type: m.type,
                        content: m.content,
                        agentId: m.source_agent_id,
                        agentName: m.agent_name,
                        importanceScore: m.importance_score,
                        createdAt: m.created_at,
                    }));
                } catch { /* cross-agent not available */ }
            }
        })() : Promise.resolve());

        // KB removed (Mem0 style) — facts in Qdrant are the knowledge base

        // Task D: Graph neighborhood (OPTIMIZED — batch search, cap at 3 entities)
        parallelTasks.push(agentId ? (async () => {
            try {
                const queryWords = query.split(/\s+/).filter(w => w.length > 2).slice(0, 5);
                // Single-pass: search all words, deduplicate, cap at 3
                const allEntities = new Map();
                const searchResults = await Promise.allSettled(
                    queryWords.map(word => graphService.searchEntities(word, agentId, 2))
                );
                for (const r of searchResults) {
                    if (r.status === 'fulfilled') {
                        for (const ent of r.value) {
                            if (!allEntities.has(ent.id) && allEntities.size < 3) {
                                allEntities.set(ent.id, ent);
                            }
                        }
                    }
                }
                // Fetch neighborhoods in parallel (max 3)
                if (allEntities.size > 0) {
                    const neighborhoods = await Promise.allSettled(
                        Array.from(allEntities.values()).map(async (ent) => {
                            const n = await graphService.getEntityNeighborhood(ent.id, agentId);
                            return {
                                entity: ent,
                                relationships: n.relationships.slice(0, 5),
                                neighbors: n.neighbors.slice(0, 5),
                            };
                        })
                    );
                    const graphEntities = neighborhoods
                        .filter(r => r.status === 'fulfilled')
                        .map(r => r.value);
                    if (graphEntities.length > 0) {
                        results.graphContext = graphEntities;
                    }
                }
            } catch { /* graph tables may not exist */ }
        })() : Promise.resolve());

        // Wait for ALL parallel tasks to complete (failures are handled individually)
        await Promise.allSettled(parallelTasks);

        // 6. LLM Reranking — runs after semantic search is ready
        if (results.semanticMemories.length > 2) {
            try {
                results.semanticMemories = await reranker.rerank(query, results.semanticMemories, { limit });
            } catch {
                // reranking failed, keep original order
            }
        }

        return results;
    }

    /**
     * Full-text + semantic search across all agents
     */
    async search(query, { agentId = null, limit = 20 } = {}) {
        const results = [];

        // Semantic search
        try {
            const embedding = await embeddingService.generateEmbedding(query);
            const semanticResults = await vectorStore.searchSimilar(embedding, {
                limit,
                agentId,
            });

            // Cross-check against PG to filter out superseded memories
            const semanticIds = semanticResults.map(r => r.id);
            let activeIds = new Set(semanticIds);
            if (semanticIds.length > 0) {
                const pgActive = await db.getActiveMemoryIds(semanticIds);
                activeIds = new Set(pgActive);
            }

            for (const r of semanticResults) {
                if (!activeIds.has(r.id)) continue; // skip superseded
                results.push({
                    id: r.id,
                    score: r.score,
                    source: 'semantic',
                    content: r.payload.content,
                    type: r.payload.type,
                    agentId: r.payload.agent_id,
                    conversationId: r.payload.conversation_id,
                    status: 'active',
                });
            }
        } catch (err) {
            console.warn('⚠️ Semantic search failed:', err.message);
        }

        // PostgreSQL text search
        try {
            const dbResults = await db.searchMemories(query, agentId, limit);
            for (const m of dbResults) {
                // Avoid duplicates
                if (!results.find(r => r.id === m.id)) {
                    results.push({
                        id: m.id,
                        score: m.importance_score,
                        source: 'text',
                        content: m.content,
                        type: m.type,
                        agentId: m.source_agent_id,
                        conversationId: m.source_conversation_id,
                        status: 'active',
                    });
                }
            }
        } catch (err) {
            console.warn('⚠️ Text search failed:', err.message);
        }

        // Sort by score descending
        results.sort((a, b) => (b.score || 0) - (a.score || 0));
        return results.slice(0, limit);
    }
}

module.exports = new MemoryService();
