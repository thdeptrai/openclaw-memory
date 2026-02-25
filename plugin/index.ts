/**
 * 🧠 Memolo — OpenClaw Memory Plugin
 *
 * Long-term shared memory for OpenClaw agents, backed by a self-hosted
 * memory server with PostgreSQL, Qdrant vector search, and Ollama embeddings.
 *
 * Features:
 * - 5 tools: memolo_search, memolo_store, memolo_list, memolo_get, memolo_forget
 * - Auto-recall: injects relevant memories before each agent turn
 * - Auto-capture: stores conversation exchanges after each agent turn
 * - Cross-agent memory: agents can access each other's memories
 * - CLI: openclaw memolo search, openclaw memolo stats
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type MemoloConfig = {
    serverUrl: string;
    agentId: string;
    agentName: string;
    apiKey: string;
    autoCapture: boolean;
    autoRecall: boolean;
    topK: number;
    includeOtherAgents: boolean;
    tags: string[];
};

interface MemoryItem {
    id: string;
    content: string;
    type: string;
    source_agent_id?: string;
    importance_score?: number;
    tags?: string[];
    created_at?: string;
}

interface ExchangeItem {
    id: string;
    conversation_id: string;
    user_message: string;
    agent_response: string;
    sequence_num: number;
    agent_id?: string;
    created_at?: string;
}

interface RecallResult {
    context: string;
    raw: {
        semanticMemories?: Array<{ content: string; agentId: string; score: number }>;
        crossAgentMemories?: Array<{ content: string; agentId: string; agentName: string }>;
        recentExchanges?: Array<{ userMessage: string; agentResponse: string }>;
    };
}

interface StoreResult {
    conversationId: string;
    exchange: ExchangeItem;
}

interface StatsResult {
    activeMemories: number;
    totalExchanges: number;
    totalConversations: number;
    registeredAgents: number;
    knowledgeEntries: number;
}

// ============================================================================
// HTTP Client for Memolo Server
// ============================================================================

class MemoloClient {
    private serverUrl: string;
    private agentId: string;
    private apiKey: string;
    private registered = false;

    constructor(serverUrl: string, agentId: string, apiKey: string = "") {
        this.serverUrl = serverUrl.replace(/\/$/, "");
        this.agentId = agentId;
        this.apiKey = apiKey;
    }

    async register(agentName: string): Promise<void> {
        if (this.registered) return;
        try {
            await this.request("POST", "/api/memory/agents/register", {
                id: this.agentId,
                name: agentName,
            });
            this.registered = true;
        } catch {
            // Agent may already exist — that's fine
            this.registered = true;
        }
    }

    async recall(query: string, opts: {
        conversationId?: string;
        limit?: number;
        includeOtherAgents?: boolean;
    }): Promise<RecallResult> {
        const res = await this.request("POST", "/api/memory/recall", {
            query,
            agentId: this.agentId,
            conversationId: opts.conversationId,
            limit: opts.limit || 10,
            includeOtherAgents: opts.includeOtherAgents ?? true,
            format: "context",
        });
        // format=context returns { success, context, raw } at top level
        return res.data || res;
    }

    async store(exchange: {
        conversationId?: string;
        userMessage: string;
        agentResponse: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<StoreResult> {
        const res = await this.request("POST", "/api/memory/store", {
            agentId: this.agentId,
            ...exchange,
        });
        return res.data || res;
    }

    async search(query: string, limit = 20): Promise<MemoryItem[]> {
        const res = await this.request("POST", "/api/memory/search", {
            query,
            limit,
        });
        return res.data || [];
    }

    async listExchanges(limit = 50): Promise<ExchangeItem[]> {
        const res = await this.request(
            "GET",
            `/api/memory/exchanges?limit=${limit}&agentId=${this.agentId}`,
        );
        return res.data || [];
    }

    async getConversation(conversationId: string): Promise<any> {
        const res = await this.request(
            "GET",
            `/api/memory/conversations/${conversationId}`,
        );
        return res.data || res;
    }

    async deleteMemory(memoryId: string): Promise<void> {
        await this.request("DELETE", `/api/memory/${memoryId}`);
    }

    async stats(): Promise<StatsResult> {
        const res = await this.request("GET", "/api/intelligence/stats");
        return res.data;
    }

    async health(): Promise<{ status: string }> {
        return this.request("GET", "/api/health");
    }

    async listAgents(): Promise<any[]> {
        const res = await this.request("GET", "/api/memory/agents");
        return res.data || [];
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<any> {
        const url = `${this.serverUrl}${path}`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.apiKey) {
            headers["X-API-Key"] = this.apiKey;
        }
        const opts: RequestInit = {
            method,
            headers,
        };
        if (body && method !== "GET") {
            opts.body = JSON.stringify(body);
        }

        const response = await fetch(url, {
            ...opts,
            signal: AbortSignal.timeout(30000),
        });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        return data;
    }
}

// ============================================================================
// Config Parser
// ============================================================================

function resolveEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
        const envValue = process.env[envVar];
        if (!envValue) {
            throw new Error(`Environment variable ${envVar} is not set`);
        }
        return envValue;
    });
}

const ALLOWED_KEYS = [
    "serverUrl",
    "agentId",
    "agentName",
    "apiKey",
    "autoCapture",
    "autoRecall",
    "topK",
    "includeOtherAgents",
    "tags",
];

const memoloConfigSchema = {
    parse(value: unknown): MemoloConfig {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("memolo config required");
        }
        const cfg = value as Record<string, unknown>;

        // Validate keys
        const unknown = Object.keys(cfg).filter((k) => !ALLOWED_KEYS.includes(k));
        if (unknown.length > 0) {
            throw new Error(`memolo config has unknown keys: ${unknown.join(", ")}`);
        }

        // agentId is required
        if (typeof cfg.agentId !== "string" || !cfg.agentId) {
            throw new Error("agentId is required for memolo plugin");
        }

        const serverUrl =
            typeof cfg.serverUrl === "string" && cfg.serverUrl
                ? resolveEnvVars(cfg.serverUrl)
                : process.env.MEMOLO_SERVER_URL || "http://localhost:7437";

        const apiKey =
            typeof cfg.apiKey === "string" && cfg.apiKey
                ? resolveEnvVars(cfg.apiKey)
                : process.env.MEMOLO_API_KEY || "";

        return {
            serverUrl,
            agentId: cfg.agentId as string,
            agentName:
                typeof cfg.agentName === "string" && cfg.agentName
                    ? cfg.agentName
                    : (cfg.agentId as string),
            apiKey,
            autoCapture: cfg.autoCapture !== false,
            autoRecall: cfg.autoRecall !== false,
            topK: typeof cfg.topK === "number" ? cfg.topK : 10,
            includeOtherAgents: cfg.includeOtherAgents !== false,
            tags:
                typeof cfg.tags === "string"
                    ? cfg.tags
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean)
                    : [],
        };
    },
};

// ============================================================================
// Context Builder
// ============================================================================

function buildContextString(recall: RecallResult): string {
    if (recall.context) return recall.context;

    const parts: string[] = [];
    const raw = recall.raw;

    if (raw?.semanticMemories?.length) {
        parts.push("\n[Relevant Memories]");
        for (const m of raw.semanticMemories)
            parts.push(`- [${m.agentId}] ${m.content}`);
    }
    if (raw?.crossAgentMemories?.length) {
        parts.push("\n[From Other Agents]");
        for (const m of raw.crossAgentMemories)
            parts.push(`- [${m.agentName || m.agentId}] ${m.content}`);
    }
    if (raw?.recentExchanges?.length) {
        parts.push("\n[Recent Messages]");
        for (const ex of raw.recentExchanges) {
            parts.push(`User: ${ex.userMessage}`);
            parts.push(`Agent: ${ex.agentResponse}`);
        }
    }

    return parts.join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoloPlugin = {
    id: "memolo",
    name: "Memolo",
    description:
        "🧠 Memolo — Long-term shared memory for OpenClaw agents. Self-hosted with PostgreSQL, Qdrant, and Ollama.",
    kind: "memory" as const,
    configSchema: memoloConfigSchema,

    register(api: OpenClawPluginApi) {
        const cfg = memoloConfigSchema.parse(api.pluginConfig);
        const client = new MemoloClient(cfg.serverUrl, cfg.agentId, cfg.apiKey);

        // Track current conversation/session
        let currentConversationId: string | undefined;

        api.logger.info(
            `🧠 memolo: registered (agent: ${cfg.agentId}, server: ${cfg.serverUrl}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
        );

        // ========================================================================
        // Tools
        // ========================================================================

        // --- memolo_search ---
        api.registerTool(
            {
                name: "memolo_search",
                label: "Memolo Search",
                description:
                    "Search through long-term memories stored in Memolo. Use when you need context about user preferences, past decisions, or previously discussed topics across all agents.",
                parameters: Type.Object({
                    query: Type.String({ description: "Search query (natural language)" }),
                    limit: Type.Optional(
                        Type.Number({
                            description: `Max results (default: ${cfg.topK})`,
                        }),
                    ),
                }),
                async execute(_toolCallId, params) {
                    const { query, limit } = params as {
                        query: string;
                        limit?: number;
                    };

                    try {
                        const results = await client.search(query, limit ?? cfg.topK);

                        if (!results || results.length === 0) {
                            return {
                                content: [
                                    { type: "text", text: "No relevant memories found." },
                                ],
                                details: { count: 0 },
                            };
                        }

                        const text = results
                            .map(
                                (r, i) =>
                                    `${i + 1}. [${r.type}] ${r.content} (agent: ${r.source_agent_id || "—"}, score: ${((r.importance_score ?? 0) * 100).toFixed(0)}%)`,
                            )
                            .join("\n");

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Found ${results.length} memories:\n\n${text}`,
                                },
                            ],
                            details: { count: results.length, memories: results },
                        };
                    } catch (err) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memolo search failed: ${String(err)}`,
                                },
                            ],
                            details: { error: String(err) },
                        };
                    }
                },
            },
            { name: "memolo_search" },
        );

        // --- memolo_store ---
        api.registerTool(
            {
                name: "memolo_store",
                label: "Memolo Store",
                description:
                    "Save an important fact, decision, or conversation exchange to long-term memory via Memolo.",
                parameters: Type.Object({
                    userMessage: Type.String({
                        description: "The user's message to store",
                    }),
                    agentResponse: Type.String({
                        description: "The agent's response to store",
                    }),
                    conversationId: Type.Optional(
                        Type.String({
                            description: "Conversation ID (auto-created if not provided)",
                        }),
                    ),
                    tags: Type.Optional(
                        Type.Array(Type.String(), {
                            description: "Tags to attach to this exchange",
                        }),
                    ),
                }),
                async execute(_toolCallId, params) {
                    const {
                        userMessage,
                        agentResponse,
                        conversationId,
                        tags,
                    } = params as {
                        userMessage: string;
                        agentResponse: string;
                        conversationId?: string;
                        tags?: string[];
                    };

                    try {
                        await client.register(cfg.agentName);
                        const result = await client.store({
                            conversationId:
                                conversationId || currentConversationId || undefined,
                            userMessage,
                            agentResponse,
                            tags: [...(tags || []), ...cfg.tags],
                        });

                        // Track conversation
                        if (result.conversationId)
                            currentConversationId = result.conversationId;

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `✅ Stored exchange in conversation ${result.conversationId}.`,
                                },
                            ],
                            details: { action: "stored", result },
                        };
                    } catch (err) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memolo store failed: ${String(err)}`,
                                },
                            ],
                            details: { error: String(err) },
                        };
                    }
                },
            },
            { name: "memolo_store" },
        );

        // --- memolo_list ---
        api.registerTool(
            {
                name: "memolo_list",
                label: "Memolo List",
                description:
                    "List recent conversation exchanges stored in Memolo for this agent.",
                parameters: Type.Object({
                    limit: Type.Optional(
                        Type.Number({
                            description: "Max exchanges to return (default: 20)",
                        }),
                    ),
                }),
                async execute(_toolCallId, params) {
                    const { limit } = params as { limit?: number };

                    try {
                        const exchanges = await client.listExchanges(limit ?? 20);

                        if (!exchanges || exchanges.length === 0) {
                            return {
                                content: [
                                    { type: "text", text: "No exchanges stored yet." },
                                ],
                                details: { count: 0 },
                            };
                        }

                        const text = exchanges
                            .map(
                                (ex, i) =>
                                    `${i + 1}. [#${ex.sequence_num}] User: ${ex.user_message.slice(0, 80)}... → Agent: ${ex.agent_response.slice(0, 80)}...`,
                            )
                            .join("\n");

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `${exchanges.length} exchanges:\n\n${text}`,
                                },
                            ],
                            details: { count: exchanges.length, exchanges },
                        };
                    } catch (err) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memolo list failed: ${String(err)}`,
                                },
                            ],
                            details: { error: String(err) },
                        };
                    }
                },
            },
            { name: "memolo_list" },
        );

        // --- memolo_get ---
        api.registerTool(
            {
                name: "memolo_get",
                label: "Memolo Get",
                description:
                    "Retrieve a specific conversation by its ID from Memolo.",
                parameters: Type.Object({
                    conversationId: Type.String({
                        description: "The conversation ID to retrieve",
                    }),
                }),
                async execute(_toolCallId, params) {
                    const { conversationId } = params as { conversationId: string };

                    try {
                        const conversation = await client.getConversation(conversationId);

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Conversation ${conversationId}:\n${JSON.stringify(conversation, null, 2)}`,
                                },
                            ],
                            details: { conversation },
                        };
                    } catch (err) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memolo get failed: ${String(err)}`,
                                },
                            ],
                            details: { error: String(err) },
                        };
                    }
                },
            },
            { name: "memolo_get" },
        );

        // --- memolo_forget ---
        api.registerTool(
            {
                name: "memolo_forget",
                label: "Memolo Forget",
                description:
                    "Delete a memory from Memolo. Provide either a memoryId to delete directly, or a query to search for candidates.",
                parameters: Type.Object({
                    query: Type.Optional(
                        Type.String({
                            description: "Search query to find memory to delete",
                        }),
                    ),
                    memoryId: Type.Optional(
                        Type.String({
                            description: "Specific memory ID to delete",
                        }),
                    ),
                }),
                async execute(_toolCallId, params) {
                    const { query, memoryId } = params as {
                        query?: string;
                        memoryId?: string;
                    };

                    try {
                        if (memoryId) {
                            await client.deleteMemory(memoryId);
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `🗑️ Memory ${memoryId} forgotten.`,
                                    },
                                ],
                                details: { action: "deleted", id: memoryId },
                            };
                        }

                        if (query) {
                            const results = await client.search(query, 5);

                            if (!results || results.length === 0) {
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: "No matching memories found.",
                                        },
                                    ],
                                    details: { found: 0 },
                                };
                            }

                            // Single match → high confidence, delete directly
                            if (results.length === 1) {
                                await client.deleteMemory(results[0].id);
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: `🗑️ Forgotten: "${results[0].content.slice(0, 100)}"`,
                                        },
                                    ],
                                    details: { action: "deleted", id: results[0].id },
                                };
                            }

                            const list = results
                                .map(
                                    (r) =>
                                        `- [${r.id}] ${r.content.slice(0, 80)}${r.content.length > 80 ? "..." : ""}`,
                                )
                                .join("\n");

                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                                    },
                                ],
                                details: {
                                    action: "candidates",
                                    candidates: results.map((r) => ({
                                        id: r.id,
                                        content: r.content,
                                    })),
                                },
                            };
                        }

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Provide a query or memoryId to forget.",
                                },
                            ],
                            details: { error: "missing_param" },
                        };
                    } catch (err) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memolo forget failed: ${String(err)}`,
                                },
                            ],
                            details: { error: String(err) },
                        };
                    }
                },
            },
            { name: "memolo_forget" },
        );

        // ========================================================================
        // CLI Commands
        // ========================================================================

        api.registerCli(
            ({ program }) => {
                const memolo = program
                    .command("memolo")
                    .description("🧠 Memolo memory plugin commands");

                memolo
                    .command("search")
                    .description("Search memories in Memolo")
                    .argument("<query>", "Search query")
                    .option("--limit <n>", "Max results", String(cfg.topK))
                    .action(async (query: string, opts: { limit: string }) => {
                        try {
                            const limit = parseInt(opts.limit, 10);
                            const results = await client.search(query, limit);

                            if (!results?.length) {
                                console.log("No memories found.");
                                return;
                            }

                            console.log(JSON.stringify(results, null, 2));
                        } catch (err) {
                            console.error(`Search failed: ${String(err)}`);
                        }
                    });

                memolo
                    .command("stats")
                    .description("Show Memolo statistics")
                    .action(async () => {
                        try {
                            const [stats, agents, health] = await Promise.all([
                                client.stats(),
                                client.listAgents(),
                                client.health(),
                            ]);

                            console.log("🧠 Memolo Stats");
                            console.log("═".repeat(40));
                            console.log(`Server:        ${cfg.serverUrl} (${health.status})`);
                            console.log(`Agent:         ${cfg.agentId}`);
                            console.log(`Exchanges:     ${stats.totalExchanges}`);
                            console.log(`Conversations: ${stats.totalConversations}`);
                            console.log(`Memories:      ${stats.activeMemories}`);
                            console.log(`Knowledge:     ${stats.knowledgeEntries}`);
                            console.log(`Agents:        ${stats.registeredAgents}`);
                            if (agents.length) {
                                console.log(
                                    `  → ${agents.map((a: any) => a.name || a.id).join(", ")}`,
                                );
                            }
                            console.log(
                                `Auto-recall:   ${cfg.autoRecall ? "ON" : "OFF"}`,
                            );
                            console.log(
                                `Auto-capture:  ${cfg.autoCapture ? "ON" : "OFF"}`,
                            );
                        } catch (err) {
                            console.error(`Stats failed: ${String(err)}`);
                        }
                    });

                memolo
                    .command("agents")
                    .description("List registered agents")
                    .action(async () => {
                        try {
                            const agents = await client.listAgents();
                            if (!agents.length) {
                                console.log("No agents registered.");
                                return;
                            }
                            console.log(JSON.stringify(agents, null, 2));
                        } catch (err) {
                            console.error(`Agents list failed: ${String(err)}`);
                        }
                    });
            },
            { commands: ["memolo"] },
        );

        // ========================================================================
        // Lifecycle Hooks
        // ========================================================================

        // Auto-recall: inject relevant memories before agent starts
        if (cfg.autoRecall) {
            api.on("before_agent_start", async (event, ctx) => {
                if (!event.prompt || event.prompt.length < 5) return;

                // Track session
                const sessionId = (ctx as any)?.sessionKey;
                if (sessionId) currentConversationId = sessionId;

                try {
                    await client.register(cfg.agentName);

                    const recall = await client.recall(event.prompt, {
                        conversationId: currentConversationId,
                        limit: cfg.topK,
                        includeOtherAgents: cfg.includeOtherAgents,
                    });

                    const contextStr = buildContextString(recall);
                    if (!contextStr) return;

                    api.logger.info(
                        `🧠 memolo: injecting memories into context (${contextStr.split("\n").length} lines)`,
                    );

                    return {
                        prependContext: `<memolo-memories>\n${contextStr}\n</memolo-memories>`,
                    };
                } catch (err) {
                    api.logger.warn(`🧠 memolo: recall failed: ${String(err)}`);
                }
            });
        }

        // Auto-capture: store exchange after agent ends
        if (cfg.autoCapture) {
            api.on("agent_end", async (event, ctx) => {
                if (!event.success || !event.messages || event.messages.length === 0) {
                    return;
                }

                // Track session
                const sessionId = (ctx as any)?.sessionKey;
                if (sessionId) currentConversationId = sessionId;

                try {
                    await client.register(cfg.agentName);

                    // Extract last user message and last assistant message
                    const messages = event.messages.slice(-10);
                    let lastUserMsg = "";
                    let lastAssistantMsg = "";

                    for (const msg of messages) {
                        if (!msg || typeof msg !== "object") continue;
                        const msgObj = msg as Record<string, unknown>;
                        const role = msgObj.role;

                        let textContent = "";
                        const content = msgObj.content;

                        if (typeof content === "string") {
                            textContent = content;
                        } else if (Array.isArray(content)) {
                            for (const block of content) {
                                if (
                                    block &&
                                    typeof block === "object" &&
                                    "text" in block &&
                                    typeof (block as Record<string, unknown>).text === "string"
                                ) {
                                    textContent +=
                                        (textContent ? "\n" : "") +
                                        ((block as Record<string, unknown>).text as string);
                                }
                            }
                        }

                        if (!textContent) continue;

                        // Strip injected memory context
                        if (textContent.includes("<memolo-memories>")) {
                            textContent = textContent
                                .replace(
                                    /<memolo-memories>[\s\S]*?<\/memolo-memories>\s*/g,
                                    "",
                                )
                                .trim();
                            if (!textContent) continue;
                        }

                        if (role === "user") lastUserMsg = textContent;
                        if (role === "assistant") lastAssistantMsg = textContent;
                    }

                    if (!lastUserMsg || !lastAssistantMsg) return;

                    const result = await client.store({
                        conversationId: currentConversationId,
                        userMessage: lastUserMsg,
                        agentResponse: lastAssistantMsg,
                        tags: cfg.tags,
                    });

                    if (result.conversationId) {
                        currentConversationId = result.conversationId;
                    }

                    api.logger.info(
                        `🧠 memolo: auto-captured exchange in ${result.conversationId}`,
                    );
                } catch (err) {
                    api.logger.warn(`🧠 memolo: capture failed: ${String(err)}`);
                }
            });
        }

        // ========================================================================
        // Service
        // ========================================================================

        api.registerService({
            id: "memolo",
            async start() {
                try {
                    await client.register(cfg.agentName);
                    const health = await client.health();
                    api.logger.info(
                        `🧠 memolo: connected to ${cfg.serverUrl} (${health.status})`,
                    );
                } catch (err) {
                    api.logger.warn(
                        `🧠 memolo: server at ${cfg.serverUrl} not reachable: ${String(err)}`,
                    );
                }
            },
            stop() {
                api.logger.info("🧠 memolo: stopped");
            },
        });
    },
};

export default memoloPlugin;
