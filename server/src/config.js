require('dotenv').config();

// --- Summarizer Prompts (override via SUMMARIZER_SYSTEM_PROMPT / SUMMARIZER_USER_PROMPT in .env) ---

const DEFAULT_SUMMARIZER_SYSTEM_PROMPT = `You are a MEMORY EXTRACTION assistant for an AI agent system.
Your job: analyze conversations and extract structured, SEARCHABLE memories.

CRITICAL RULES:
1. Each fact/decision MUST be a COMPLETE, SELF-CONTAINED sentence — someone reading it WITHOUT the conversation must fully understand it.
2. Include specific values, numbers, tool names, config details — never vague.
3. Keep the ORIGINAL LANGUAGE of the conversation (Vietnamese → Vietnamese output).
4. NEVER output markdown, code blocks, or explanations — ONLY valid JSON.
5. ONLY extract information that is EXPLICITLY stated in the conversation. Do NOT infer or hallucinate.`;

const DEFAULT_SUMMARIZER_USER_PROMPT = `Extract ALL meaningful information from this conversation.

GUIDELINES FOR EACH FIELD:
- "summary": 2-3 sentence overview in the conversation's language
- "facts": Self-contained statements with FULL context. Each fact is stored and searched INDEPENDENTLY.
  IMPORTANT: Extract AT LEAST ONE fact from EVERY exchange. Do NOT skip any exchange.
  BAD: "Thích TypeScript"
  GOOD: "User thích dùng TypeScript hơn JavaScript thuần vì type safety, autocompletion, refactoring tốt hơn. Cần cài: ts-node, typescript, @types/express."
- "decisions": Technical choices + reasoning. Include tool/lib names and WHY.
  BAD: "Chọn Prisma"
  GOOD: "Chọn Prisma ORM thay vì TypeORM vì schema declarative dễ đọc, auto-generate types, có Prisma Studio."
- "preferences": ONLY preferences the user EXPLICITLY stated. Do NOT invent or infer preferences not in the conversation.
  BAD: "Thích FP" (too short)
  GOOD: "User thích functional programming hơn OOP — dùng pure functions, immutability, map/filter/reduce."
- "action_items": Specific tasks to do next
- "entities": Technology names, tools, libraries, frameworks mentioned
- "topics": Main themes discussed
- "project": Name of the specific project being discussed (e.g. "ecommerce-app", "inventory-api"). Use "general" if no specific project is mentioned.
- "scope": One of: "universal" (user preferences, coding style — applies everywhere), "project" (specific to one project), "environment" (staging/prod settings). Default "universal" if unclear.
- "domain": Main technical domain (e.g. "database", "api-design", "deployment", "frontend", "testing")

CONVERSATION:
{{CONVERSATION}}

Return a JSON object:
{
  "summary": "...",
  "facts": ["self-contained fact 1", "self-contained fact 2"],
  "decisions": ["decision with reasoning 1"],
  "preferences": ["preference with context 1"],
  "action_items": ["specific task 1"],
  "entities": ["tech1", "tool2"],
  "topics": ["topic1"],
  "project": "project-name or general",
  "scope": "universal | project | environment",
  "domain": "main-domain"
}

Return ONLY the JSON object, no other text.`;

module.exports = {
  server: {
    port: parseInt(process.env.PORT || '7437'),
    env: process.env.NODE_ENV || 'development',
  },

  security: {
    masterKey: process.env.MEMOLO_MASTER_KEY || '',
  },

  postgres: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    user: process.env.PG_USER || 'openclaw',
    password: process.env.PG_PASSWORD || 'openclaw_secret',
    database: process.env.PG_DATABASE || 'openclaw_memory',
  },

  qdrant: {
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT || '6333'),
    collectionName: 'memory_embeddings',
  },

  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'qwen3-embedding:8b',
    chatModel: process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b',
  },

  summarizer: {
    systemPrompt: process.env.SUMMARIZER_SYSTEM_PROMPT || DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    userPromptTemplate: process.env.SUMMARIZER_USER_PROMPT || DEFAULT_SUMMARIZER_USER_PROMPT,
  },

  memory: {
    summarizeAfterExchanges: parseInt(process.env.SUMMARIZE_AFTER_EXCHANGES || '5'),
    embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '4096'),
  },

  factExtraction: {
    enabled: process.env.ENABLE_FACT_EXTRACTION !== 'false',
    timeout: parseInt(process.env.FACT_EXTRACT_TIMEOUT || '60000'),
    dedupTimeout: parseInt(process.env.DEDUP_TIMEOUT || '60000'),
  },

  reranking: {
    enabled: process.env.ENABLE_RERANKING !== 'false', // default: true
    timeout: parseInt(process.env.RERANK_TIMEOUT || '30000'),
  },

  graph: {
    enabled: process.env.ENABLE_GRAPH !== 'false', // default: true
  },
};
