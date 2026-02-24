const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const vectorStore = require('./vectorStore');
const embeddingService = require('./embeddingService');
const summarizer = require('./summarizer');
const config = require('../config');
const eventBus = require('./eventBus');
const contradictionDetector = require('./contradictionDetector');
const factExtractor = require('./factExtractor');
const memoryDeduplicator = require('./memoryDeduplicator');
const graphService = require('./graphService');
const reranker = require('./reranker');

// Lazy-load to avoid circular dependency
let intelligenceService = null;

// ====================== CONTENT QUALITY SCORING ======================

// Patterns that indicate low-value content (greetings, filler)
const LOW_VALUE_PATTERNS = [
    /^(xin\s+)?ch[àa]o/i,
    /^hi\b/i, /^hello\b/i, /^hey\b/i,
    /^(ok|okay|ừ|uh|hmm|à|ờ)\s*$/i,
    /^(cảm ơn|thank|thanks)\s*$/i,
];

// Patterns that indicate preference/decision content (high value)
const PREFERENCE_PATTERNS = [
    /th[íi]ch\s+(d[ùu]ng|dùng|style|kiểu)/i,
    /th[íi]ch\s+.*h[ơo]n/i,
    /s[ởo]\s*th[íi]ch/i,
    /prefer/i,
    /ghi\s+nh[ậa]n.*s[ởo]\s*th[íi]ch/i,
    /ghi\s+nh[ậa]n/i,
];

// Patterns that indicate technical decision content
const DECISION_PATTERNS = [
    /đề\s*xuất/i, /khuyên\s*dùng/i,
    /nên\s*(dùng|sử\s*dụng|chọn)/i,
    /recommend/i, /suggest/i,
    /setup|config|cấu\s*hình/i,
];

/**
 * Score content quality (0.0 = garbage, 1.0 = critical info)
 */
function scoreContentImportance(userMsg, agentResp) {
    const combined = `${userMsg} ${agentResp}`;

    // Greeting/filler = very low
    if (LOW_VALUE_PATTERNS.some(p => p.test(userMsg.trim()))) {
        // But if agent response is substantial, medium score
        if (agentResp.length > 100) return 0.3;
        return 0.1;
    }

    let score = 0.5; // base

    // Preference statements = high
    if (PREFERENCE_PATTERNS.some(p => p.test(combined))) score = Math.max(score, 0.9);

    // Technical decisions = high
    if (DECISION_PATTERNS.some(p => p.test(combined))) score = Math.max(score, 0.8);

    // Long, detailed responses = boost
    if (agentResp.length > 200) score = Math.min(1.0, score + 0.1);
    if (agentResp.length > 400) score = Math.min(1.0, score + 0.1);

    return score;
}

/**
 * Detect if content contains preference tags
 */
function extractContentTags(userMsg, agentResp) {
    const combined = `${userMsg} ${agentResp}`;
    const tags = [];
    if (PREFERENCE_PATTERNS.some(p => p.test(combined))) tags.push('preference');
    if (DECISION_PATTERNS.some(p => p.test(combined))) tags.push('decision');
    if (/database|postgresql|mysql|mongo|redis/i.test(combined)) tags.push('database');
    if (/deploy|docker|server|nginx|ci\/cd/i.test(combined)) tags.push('devops');
    if (/design|ui|ux|color|font|animation|layout/i.test(combined)) tags.push('design');
    if (/security|auth|ssl|firewall|encrypt/i.test(combined)) tags.push('security');
    if (/test|jest|coverage|qa/i.test(combined)) tags.push('testing');
    if (/performance|cache|optimize|speed/i.test(combined)) tags.push('performance');
    return tags;
}
function getIntelligenceService() {
    if (!intelligenceService) {
        intelligenceService = require('./intelligenceService');
    }
    return intelligenceService;
}

/**
 * Core Memory Service — orchestrates all memory operations
 */

// Concurrency lock — prevents duplicate summarization for same conversation
const summarizationLocks = new Set();

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

        // Score content importance and extract tags
        const importanceScore = scoreContentImportance(userMessage, agentResponse);
        const contentTags = extractContentTags(userMessage, agentResponse);

        // Generate embedding for the exchange
        const textForEmbedding = `User: ${userMessage}\nAgent: ${agentResponse}`;
        try {
            const embedding = await embeddingService.generateEmbedding(textForEmbedding);

            // Index in Qdrant with quality-scored importance + topic context
            await vectorStore.upsertVector(exchange.id, embedding, {
                memory_id: exchange.id,
                agent_id: agentId,
                type: 'exchange',
                content: textForEmbedding.substring(0, 500),
                user_message: userMessage.substring(0, 300),
                conversation_id: conversationId,
                importance_score: importanceScore,
                content_tags: contentTags,
                topic: conversationTopic,
                scope: 'unknown',
                created_at: new Date().toISOString(),
            });
        } catch (err) {
            console.warn('⚠️ Embedding/indexing failed, exchange still stored:', err.message);
        }

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

        // Check if summarization is needed
        const lastSummarizedSeq = await db.getLatestSummarySequence(conversationId);
        const unsummarizedCount = exchange.sequence_num - lastSummarizedSeq;

        if (unsummarizedCount >= config.memory.summarizeAfterExchanges) {
            // Skip if already running for this conversation
            if (summarizationLocks.has(conversationId)) {
                eventBus.push('info', `⏳ Summarization already running for ${conversationId}, skipping`, { source: 'summarizer' });
            } else {
                // Mark pending in DB + trigger
                await db.setSummarizationStatus(conversationId, 'pending', {
                    pendingFrom: lastSummarizedSeq + 1,
                    pendingTo: exchange.sequence_num,
                });
                this.triggerSummarization(conversationId, agentId, lastSummarizedSeq + 1, exchange.sequence_num)
                    .catch(err => {
                        console.error(`⚠️ Summarization error for ${conversationId}:`, err.message);
                    });
            }
        }

        return {
            exchangeId: exchange.id,
            conversationId,
            sequenceNum: exchange.sequence_num,
            summarizationTriggered: unsummarizedCount >= config.memory.summarizeAfterExchanges,
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
            summaries: [],
            knowledgeBase: [],
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

        // 1. Semantic search via Qdrant — use ENRICHED query for better matching
        // Two-pass strategy: when topic is active, first search with topic filter,
        // then search broadly for universal/general content. Merge + deduplicate.
        try {
            const embedding = await embeddingService.generateEmbedding(enrichedQuery);
            const searchLimit = limit * 3; // Get 3x candidates for re-ranking
            let semanticResults;

            if (activeTopic) {
                // Pass 1: Topic-filtered search — guaranteed topic-relevant results
                const topicResults = await vectorStore.searchSimilar(embedding, {
                    limit: searchLimit,
                    agentId: agentId && !includeOtherAgents ? agentId : null,
                    topic: activeTopic,
                    scoreThreshold: 0.35,
                });

                // Pass 2: Broad search — picks up universal prefs, general knowledge, cross-project
                const broadResults = await vectorStore.searchSimilar(embedding, {
                    limit: Math.ceil(searchLimit / 2),
                    agentId: agentId && !includeOtherAgents ? agentId : null,
                    scoreThreshold: 0.45, // higher threshold for non-topic content
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
                    scoreThreshold: 0.40,
                });
            }

            // Re-rank results with keyword boost + importance score
            let rankedResults = semanticResults.map(r => {
                let finalScore = r.score;
                const content = (r.payload.content || '').toLowerCase();
                const userMsg = (r.payload.user_message || '').toLowerCase();
                const importance = r.payload.importance_score || 0.5;
                const tags = r.payload.content_tags || [];

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

                // Preference query boost: boost results tagged as preference
                if (isPreferenceQuery && tags.includes('preference')) {
                    finalScore += 0.2;
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
                    agentId: r.payload.agent_id,
                    conversationId: r.payload.conversation_id,
                    importanceScore: importance,
                    contentTags: tags,
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
            const FACT_TYPES = new Set(['fact', 'decision', 'insight', 'preference']);
            rankedResults = rankedResults.filter(r => {
                const memType = (r.payload && r.payload.type) || 'exchange';
                return FACT_TYPES.has(memType);
            });

            // Sort by re-ranked score and take top N
            rankedResults.sort((a, b) => b.score - a.score);
            results.semanticMemories = rankedResults.slice(0, limit);

            // Boost importance of accessed memories
            const intel = getIntelligenceService();
            for (const mem of results.semanticMemories) {
                intel.boostOnAccess(mem.id).catch(() => { });
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

        // Task B: Cross-agent memories (permission-aware)
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

        // Task C: Knowledge base entries — keyword relevance + text hybrid search
        parallelTasks.push((async () => {
            try {
                const kbEntries = new Map();

                // C1: Keyword relevance scoring
                const allKb = await db.query(
                    `SELECT id, topic, content, confidence_score FROM knowledge_base ORDER BY confidence_score DESC`
                );
                const queryWords = enrichedQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                for (const k of allKb.rows) {
                    const kText = (k.topic + ' ' + k.content).toLowerCase();
                    const matchCount = queryWords.filter(w => kText.includes(w)).length;
                    if (matchCount > 0) {
                        const relevance = (matchCount / Math.max(queryWords.length, 1)) * (k.confidence_score || 0.5);
                        kbEntries.set(k.id, {
                            id: k.id, topic: k.topic, content: k.content,
                            confidence: k.confidence_score, relevance,
                        });
                    }
                }

                // C2: Text ILIKE fallback
                const kbTextResults = await db.query(
                    `SELECT id, topic, content, confidence_score FROM knowledge_base
                     WHERE topic ILIKE $1 OR content ILIKE $1
                     ORDER BY confidence_score DESC LIMIT 5`,
                    [`%${query.substring(0, 100)}%`]
                );
                for (const k of kbTextResults.rows) {
                    if (!kbEntries.has(k.id)) {
                        kbEntries.set(k.id, {
                            id: k.id, topic: k.topic, content: k.content,
                            confidence: k.confidence_score, relevance: k.confidence_score * 0.5,
                        });
                    }
                }

                // Sort by relevance, take top 8
                results.knowledgeBase = Array.from(kbEntries.values())
                    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
                    .slice(0, 8);
            } catch { /* knowledge_base table may not exist */ }
        })());

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

    /**
     * Trigger summarization for a conversation chunk
     * With: concurrency lock, DB status tracking, transactional commit
     */
    async triggerSummarization(conversationId, agentId, fromSeq, toSeq) {
        // === Concurrency lock ===
        if (summarizationLocks.has(conversationId)) {
            eventBus.push('info', `⏳ Skipping duplicate summarization for ${conversationId}`, { source: 'summarizer' });
            return null;
        }
        summarizationLocks.add(conversationId);

        try {
            // === Mark in-progress ===
            await db.setSummarizationStatus(conversationId, 'in_progress', {
                failedAt: new Date().toISOString(), // timestamp for stuck detection
                pendingFrom: fromSeq,
                pendingTo: toSeq,
            });

            eventBus.push('info', `🔄 Summarizing ${conversationId}, exchanges ${fromSeq}-${toSeq}`, { source: 'summarizer' });

            // Get exchanges in range
            const allExchanges = await db.getExchanges(conversationId, 100);
            const exchangesToSummarize = allExchanges.filter(
                ex => ex.sequence_num >= fromSeq && ex.sequence_num <= toSeq
            );

            if (exchangesToSummarize.length === 0) {
                await db.setSummarizationStatus(conversationId, 'idle');
                return null;
            }

            // === Call summarizer ===
            const summaryData = await summarizer.summarizeExchanges(exchangesToSummarize);

            // Extract project/scope/domain
            const project = (summaryData.project || 'general').substring(0, 100);
            const scope = (summaryData.scope || 'unknown').substring(0, 20);
            const domain = (summaryData.domain || null)?.substring(0, 50) || null;

            // --- Build/Update Conversation Profile ---
            try {
                const existingProfile = await db.getConversationProfile(conversationId);
                const newProfile = this._buildProfile(summaryData, existingProfile);
                await db.updateConversationProfile(conversationId, newProfile);
                console.log(`📋 Profile updated for ${conversationId}: topic=${newProfile.topic}, scope=${newProfile.scope}`);
            } catch (err) {
                console.warn('⚠️ Profile update failed:', err.message);
            }

            // === Build memory records ===
            const memoriesToSave = [];

            // Facts
            if (summaryData.facts) {
                for (const fact of summaryData.facts) {
                    const factScope = (summaryData.preferences || []).some(p => fact.includes(p.substring(0, 30)))
                        ? 'universal' : scope;
                    memoriesToSave.push({
                        type: 'fact',
                        content: fact,
                        sourceConversationId: conversationId,
                        sourceAgentId: agentId,
                        importanceScore: 0.7,
                        tags: summaryData.topics || [],
                        topic: project,
                        scope: factScope,
                        category: domain,
                    });
                }
            }

            // Decisions
            if (summaryData.decisions) {
                for (const decision of summaryData.decisions) {
                    memoriesToSave.push({
                        type: 'decision',
                        content: decision,
                        sourceConversationId: conversationId,
                        sourceAgentId: agentId,
                        importanceScore: 0.8,
                        tags: summaryData.topics || [],
                        topic: project,
                        scope: scope === 'unknown' ? 'project' : scope,
                        category: domain,
                    });
                }
            }

            // === Atomic commit: summary + all memories in one transaction ===
            const { summary, memories: savedMemories } = await db.addSummaryWithMemories({
                conversationId,
                fromSequence: fromSeq,
                toSequence: toSeq,
                summaryText: summaryData.summary,
                factsExtracted: summaryData.facts || [],
                decisionsMade: summaryData.decisions || [],
            }, memoriesToSave);

            // Emit events for each saved memory
            for (const mem of savedMemories) {
                eventBus.emit('memory:new', {
                    memoryId: mem.id,
                    type: mem.type,
                    content: mem.content.substring(0, 200),
                    agentId,
                    conversationId,
                    topic: project,
                });
            }

            // === Embeddings (outside transaction — recoverable) ===
            for (const mem of savedMemories) {
                try {
                    const embedding = await embeddingService.generateEmbedding(mem.content);
                    await vectorStore.upsertVector(mem.id, embedding, {
                        memory_id: mem.id,
                        agent_id: agentId,
                        type: mem.type,
                        content: mem.content,
                        conversation_id: conversationId,
                        importance_score: mem.importance_score,
                        topic: project,
                        scope: mem.scope || 'unknown',
                        category: domain || '',
                        created_at: new Date().toISOString(),
                    });
                } catch (err) {
                    console.warn(`⚠️ ${mem.type} embedding failed:`, err.message);
                }
            }

            // Index summary embedding
            try {
                const summaryEmbedding = await embeddingService.generateEmbedding(summaryData.summary);
                await vectorStore.upsertVector(summary.id, summaryEmbedding, {
                    memory_id: summary.id,
                    agent_id: agentId,
                    type: 'summary',
                    content: summaryData.summary,
                    conversation_id: conversationId,
                    importance_score: 0.6,
                    topic: project,
                    scope: scope,
                    created_at: new Date().toISOString(),
                });
            } catch (err) {
                console.warn('⚠️ Summary embedding failed:', err.message);
            }

            // === Mark completed ===
            await db.setSummarizationStatus(conversationId, 'completed', {
                retryCount: 0,
                failedAt: null,
                pendingFrom: null,
                pendingTo: null,
            });

            eventBus.push('info', `✅ Summarization complete for ${conversationId} [topic=${project}, scope=${scope}] — ${savedMemories.length} memories`, { source: 'summarizer' });

            // --- Run contradiction detection ---
            try {
                const recentMemories = await db.getActiveMemoriesByTopic(project, agentId, 20);
                const justCreated = recentMemories.filter(m => {
                    const age = Date.now() - new Date(m.created_at).getTime();
                    return age < 30000;
                });
                const newMemories = justCreated.map(m => ({
                    id: m.id, type: m.type, content: m.content, topic: m.topic, scope: m.scope,
                }));
                if (newMemories.length > 0) {
                    const superseded = await contradictionDetector.detectAndSupersede(newMemories, agentId);
                    if (superseded.length > 0) {
                        console.log(`🔄 ${superseded.length} contradictions resolved`);
                    }
                }
            } catch (err) {
                console.warn('⚠️ Contradiction detection failed:', err.message);
            }

            eventBus.emit('summarize:done', {
                conversationId,
                agentId,
                factsCount: (summaryData.facts || []).length,
                decisionsCount: (summaryData.decisions || []).length,
                summary: summaryData.summary.substring(0, 200),
                topic: project,
            });

            return summary;

        } catch (err) {
            // === Mark failed with retry tracking ===
            try {
                const conv = await db.getConversation(conversationId);
                const retryCount = (conv?.summarization_retry_count || 0) + 1;
                await db.setSummarizationStatus(conversationId, 'failed', {
                    retryCount,
                    failedAt: new Date().toISOString(),
                    pendingFrom: fromSeq,
                    pendingTo: toSeq,
                });
                eventBus.push('warn', `❌ Summarization failed for ${conversationId} (retry ${retryCount}): ${err.message}`, { source: 'summarizer' });
            } catch (statusErr) {
                console.error('Failed to update summarization status:', statusErr.message);
            }
            throw err;
        } finally {
            summarizationLocks.delete(conversationId);
        }
    }

    /**
     * Sweep for unsummarized conversations — called by scheduler
     */
    async sweepUnsummarized() {
        try {
            const conversations = await db.getUnsummarizedConversations(config.memory.summarizeAfterExchanges);
            if (conversations.length === 0) return;

            eventBus.push('info', `🧹 Sweep found ${conversations.length} conversation(s) needing summarization`, { source: 'summarizer' });

            for (const conv of conversations) {
                // Skip if max retries exceeded (5)
                if (conv.summarization_retry_count >= 5) {
                    eventBus.push('warn', `⏭️ Skipping ${conv.id}: max retries (${conv.summarization_retry_count}) exceeded`, { source: 'summarizer' });
                    continue;
                }

                // Check backoff: 2min * 2^retryCount
                if (conv.summarization_failed_at) {
                    const backoffMs = 120000 * Math.pow(2, conv.summarization_retry_count || 0);
                    const elapsed = Date.now() - new Date(conv.summarization_failed_at).getTime();
                    if (elapsed < backoffMs) continue; // Wait longer
                }

                const fromSeq = conv.summarization_pending_from || (conv.last_summarized + 1);
                const toSeq = conv.summarization_pending_to || conv.max_sequence || conv.exchange_count;

                eventBus.push('info', `🔁 Retrying summarization for ${conv.id} (attempt ${(conv.summarization_retry_count || 0) + 1})`, { source: 'summarizer' });

                this.triggerSummarization(conv.id, conv.agent_id, fromSeq, toSeq)
                    .catch(err => console.error(`Sweep retry failed for ${conv.id}:`, err.message));
            }
        } catch (err) {
            console.error('Sweep error:', err.message);
        }
    }

    /**
     * End a conversation and trigger final summarization
     */
    async endConversation(conversationId) {
        const conv = await db.getConversation(conversationId);
        if (!conv) throw new Error('Conversation not found');

        // Update conversation status
        await db.updateConversation(conversationId, {
            status: 'ended',
            ended_at: new Date().toISOString(),
        });

        // Trigger final summarization for any remaining exchanges
        const lastSummarizedSeq = await db.getLatestSummarySequence(conversationId);
        const exchangeCount = await db.getExchangeCount(conversationId);

        if (exchangeCount > lastSummarizedSeq) {
            await this.triggerSummarization(conversationId, conv.agent_id, lastSummarizedSeq + 1, exchangeCount);
        }

        return { status: 'ended', conversationId };
    }

    // ====================== QUERY ENRICHMENT ======================

    /**
     * Enrich a raw query with conversation profile context.
     * This makes semantic search naturally return more contextually relevant results
     * without needing to detect or filter by topic at recall time.
     */
    _enrichQuery(rawQuery, profile) {
        if (!profile || Object.keys(profile).length === 0) return rawQuery;

        const parts = [rawQuery];

        if (profile.topic && profile.topic !== 'general') {
            parts.push(`Project: ${profile.topic}`);
        }
        if (profile.entities && profile.entities.length > 0) {
            parts.push(`Tech: ${profile.entities.slice(0, 5).join(', ')}`);
        }
        if (profile.domain) {
            parts.push(`Domain: ${profile.domain}`);
        }

        const enriched = parts.join('. ');
        if (enriched !== rawQuery) {
            console.log(`🔍 Query enriched: "${rawQuery.substring(0, 60)}..." → +${enriched.length - rawQuery.length} chars context`);
        }
        return enriched;
    }

    // ====================== PROFILE BUILDER ======================

    /**
     * Build/merge conversation profile from summarizer output.
     * Profile accumulates context over multiple summarization rounds.
     */
    _buildProfile(summaryData, existingProfile = {}) {
        const existing = existingProfile || {};

        // Merge entities (accumulate, deduplicate)
        const existingEntities = existing.entities || [];
        const newEntities = summaryData.entities || [];
        const allEntities = [...new Set([...existingEntities, ...newEntities])];

        // Merge topics
        const existingTopics = existing.topics || [];
        const newTopics = summaryData.topics || [];
        const allTopics = [...new Set([...existingTopics, ...newTopics])];

        // Topic: prefer explicit project from summarizer, else keep existing
        const topic = (summaryData.project && summaryData.project !== 'general')
            ? summaryData.project
            : existing.topic || 'general';

        // Scope: escalate from unknown → detected
        const scope = (summaryData.scope && summaryData.scope !== 'unknown')
            ? summaryData.scope
            : existing.scope || 'unknown';

        // Domain: prefer latest
        const domain = summaryData.domain || existing.domain || null;

        return {
            topic,
            scope,
            domain,
            entities: allEntities.slice(0, 20), // cap at 20
            topics: allTopics.slice(0, 10),
            lastUpdated: new Date().toISOString(),
        };
    }
}

module.exports = new MemoryService();
