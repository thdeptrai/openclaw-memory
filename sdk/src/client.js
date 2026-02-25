/**
 * MemoryClient — Lightweight client for Memolo Memory Server
 *
 * Usage:
 *   const { MemoryClient } = require('memolo');
 *   const memory = new MemoryClient({ agentId: 'my-agent', apiKey: 'your-api-key', serverUrl: 'http://192.168.1.100:7437' });
 *   const memories = await memory.recall('what did we discuss about auth?');
 *   await memory.store({ conversationId, userMessage, agentResponse });
 */
class MemoryClient {
    constructor({ agentId, agentName = '', apiKey = '', serverUrl = 'http://localhost:7437' }) {
        if (!agentId) throw new Error('agentId is required');
        this.agentId = agentId;
        this.agentName = agentName || agentId;
        this.apiKey = apiKey;
        this.serverUrl = serverUrl.replace(/\/$/, '');
        this._registered = false;
    }

    /**
     * Register this agent with the Memory Server
     */
    async register() {
        if (this._registered) return;
        try {
            await this._request('POST', '/api/memory/agents/register', {
                id: this.agentId,
                name: this.agentName,
            });
            this._registered = true;
        } catch (err) {
            console.warn(`[memolo] Agent registration warning: ${err.message}`);
        }
    }

    /**
     * Recall relevant memories for a query
     * @param {string} query - The user's message or search query
     * @param {Object} options
     * @param {string} options.conversationId - Current conversation ID
     * @param {number} options.limit - Max memories to return (default: 10)
     * @param {boolean} options.includeOtherAgents - Include memories from other agents (default: true)
     * @param {string} options.format - 'raw' or 'context' (default: 'context')
     * @returns {Object} memories object with context string and raw data
     */
    async recall(query, { conversationId = null, limit = 10, includeOtherAgents = true, format = 'context' } = {}) {
        await this.register();

        const response = await this._request('POST', '/api/memory/recall', {
            query,
            agentId: this.agentId,
            conversationId,
            limit,
            includeOtherAgents,
            format,
        });

        return response.data || response;
    }

    /**
     * Store a conversation exchange
     * @param {Object} exchange
     * @param {string} exchange.conversationId - Conversation ID (auto-created if null)
     * @param {string} exchange.userMessage - User's message
     * @param {string} exchange.agentResponse - Agent's response
     * @param {string[]} exchange.tags - Optional tags
     * @param {Object} exchange.metadata - Optional metadata
     */
    async store({ conversationId = null, userMessage, agentResponse, tags = [], metadata = {} }) {
        await this.register();

        if (!userMessage || !agentResponse) {
            throw new Error('userMessage and agentResponse are required');
        }

        const response = await this._request('POST', '/api/memory/store', {
            agentId: this.agentId,
            conversationId,
            userMessage,
            agentResponse,
            tags,
            metadata,
        });

        return response.data || response;
    }

    /**
     * Build a context string from memories for LLM prompt injection
     * @param {Object} memories - Recalled memories object
     * @param {string} userMessage - Current user message
     * @returns {string} Formatted context string
     */
    buildContext(memories, userMessage) {
        // If memories already contains a context string (from format='context')
        if (memories.context) return memories.context;

        // Build from raw data
        const parts = [];

        if (memories.raw) {
            const raw = memories.raw;

            if (raw.semanticMemories?.length > 0) {
                parts.push('\n[Relevant Memories]');
                for (const m of raw.semanticMemories) {
                    parts.push(`- [${m.agentId}] ${m.content}`);
                }
            }

            if (raw.crossAgentMemories?.length > 0) {
                parts.push('\n[From Other Agents]');
                for (const m of raw.crossAgentMemories) {
                    parts.push(`- [${m.agentName || m.agentId}] ${m.content}`);
                }
            }

            if (raw.recentExchanges?.length > 0) {
                parts.push('\n[Recent Messages]');
                for (const ex of raw.recentExchanges) {
                    parts.push(`User: ${ex.userMessage}`);
                    parts.push(`Agent: ${ex.agentResponse}`);
                }
            }
        }

        return parts.join('\n');
    }

    /**
     * Search across all agents' memories
     */
    async searchAcrossAgents(query, limit = 20) {
        const response = await this._request('POST', '/api/memory/search', {
            query,
            limit,
        });
        return response.data || response;
    }

    /**
     * Get conversation details
     */
    async getConversation(conversationId) {
        const response = await this._request('GET', `/api/memory/conversations/${conversationId}`);
        return response.data || response;
    }

    /**
     * End a conversation
     */
    async endConversation(conversationId) {
        const response = await this._request('POST', `/api/memory/conversations/${conversationId}/end`);
        return response.data || response;
    }

    /**
     * Get recent memories for this agent
     */
    async getRecentMemories(limit = 20) {
        const response = await this._request('GET', `/api/memory/agents/${this.agentId}/recent?limit=${limit}`);
        return response.data || response;
    }

    /**
     * Check Memory Server health
     */
    async health() {
        return this._request('GET', '/api/health');
    }

    /**
     * Internal HTTP request helper
     */
    async _request(method, path, body = null) {
        const url = `${this.serverUrl}${path}`;
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }
        const options = { method, headers };

        if (body && method !== 'GET') {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
    }
}

module.exports = MemoryClient;
