# 🧠 Memolo — Intelligent Memory System for Multi-Agent AI

> Persistent, self-organizing memory for AI agents — atomic fact extraction, knowledge graph, LLM deduplication, and semantic recall across your LAN

## Quick Start (Docker)

```bash
# 1. Clone & configure
cd memolo
cp .env.example .env
# Edit .env → set MEMOLO_MASTER_KEY to a random string
#           → set MINIMAX_API_KEY to your MiniMax API key

# 2. Ensure Ollama is running with embedding model
ollama pull qwen3-embedding:8b

# 3. Start everything
docker compose up -d

# Server + Dashboard: http://localhost:7437
```

**That's it.** PostgreSQL, Qdrant, and the Memolo server all start automatically.

---

## How Memolo Works

Memolo is a **local-first AI memory system** that turns raw agent conversations into structured, searchable, and self-maintaining knowledge. Here's what happens when an agent sends a message:

### 📥 Store Flow — What happens when `POST /api/memory/store` is called

```
USER MESSAGE + AGENT RESPONSE
            │
            ▼
    ┌───────────────────┐
    │ 1. Save Raw Data  │  Exchange saved to PostgreSQL with sequence number
    └───────┬───────────┘
            │
            ▼
    ┌───────────────────┐
    │ 2. Batch Queue    │  Exchange enqueued into in-memory buffer
    │ (if batch enabled)│  (reduces LLM API calls for cloud providers)
    └───────┬───────────┘
            │
            ├──── (flush every 10s or when batch full) ────┐
            │                                               │
            ▼                                               ▼
    ┌───────────────────┐                           ┌──────────────────┐
    │ 3. Extract Facts  │                           │ 5. Update Graph  │
    │ + Dedup (combined)│  1 LLM call per batch:    │                  │
    │                   │   • Extract atomic facts   │ Entities → DB    │
    │                   │   • ADD/UPDATE/DELETE/NONE  │ Co-occurring →   │
    │                   │   • User + Agent facts      │ relationships    │
    └───────┬───────────┘                           └──────────────────┘
            │
            ▼
    ┌───────────────────┐
    │ 4. Embed & Store  │  Generate 4096-dim embedding via Ollama,
    │                   │  store in Qdrant for semantic search
    └───────────────────┘
```

### 📤 Recall Flow — What happens when `POST /api/memory/recall` is called

```
QUERY: "What tools does the user prefer?"
            │
            ▼
    ┌───────────────────┐
    │ 1. Query Enrich   │  Enrich query using conversation profile
    └───────┬───────────┘  (active topic, preferences, context)
            │
            ├────────────────────┬──────────────────┐
            ▼                    ▼                   ▼
    ┌──────────────┐   ┌──────────────┐    ┌──────────────┐
    │ 2. Semantic   │   │ 3. Cross-    │    │ 4. Knowledge │
    │    Search     │   │    Agent     │    │    Graph     │
    │ (Qdrant,      │   │    Search   │    │    Query     │
    │  topic-aware)│   │ (shared KB) │    │ (neighbors)  │
    └──────┬───────┘   └──────┬──────┘    └──────┬───────┘
            │                  │                   │
            ├──────────────────┼───────────────────┘
            ▼
    ┌───────────────────┐
    │ 5. LLM Rerank     │  Score each result 0.0-1.0 by
    │ (configurable)    │  semantic relevance to query
    └───────┬───────────┘
            │
            ▼
        RANKED RESULTS
```

---

## Core Mechanisms

### 🔍 Atomic Fact Extraction
Unlike batch summarization that processes groups of messages, Memolo extracts atomic facts from **every individual exchange** in real-time. Each fact is a standalone, searchable unit of knowledge. Facts from both user messages and agent responses (configurable) are extracted.

**Example:**
```
User:  "Tao dang lam project ecommerce bang Next.js va Prisma ORM, database la PostgreSQL"
Agent: "Hay lam! Stack rat manh."

Extracted Facts:
 1. "User đang làm project ecommerce"
 2. "Project sử dụng Next.js framework"
 3. "Database là PostgreSQL"
```

### 🧠 Combined Extract + Dedup (1 LLM call)
When a new exchange arrives, Memolo performs extraction AND deduplication in a **single LLM call** (optimized for cloud providers like MiniMax to minimize API costs):

1. **Extract** atomic facts from user + agent messages
2. **Compare** against existing memories (fetched via vector search)
3. **Decide** action for each fact: ADD / UPDATE / DELETE / NONE

This prevents memory bloat and handles contradictions automatically:

```
Existing:  "Database là PostgreSQL"
New fact:  "Đã chuyển sang MySQL thay vì PostgreSQL"

LLM Decision: UPDATE
Result:    "Đã chuyển sang sử dụng MySQL thay vì PostgreSQL" (old superseded)
```

**Key technique:** UUIDs are mapped to integers `[0], [1], [2]...` before sending to the LLM to prevent hallucination (inspired by mem0).

### 📦 Batch Processing
Exchanges are queued and processed in batches (configurable interval + max size) to **dramatically reduce LLM API calls** for cloud providers. A batch of 10 exchanges → 1 LLM call instead of 10.

### 🕸️ Knowledge Graph
Entities mentioned in conversations are automatically extracted and linked:

```
Entities:  [Next.js, TypeScript, PostgreSQL, Vercel]
Relations: Next.js --related_to--> TypeScript
           PostgreSQL --related_to--> Next.js
```

During recall, the graph provides **contextual connections** — asking about "Next.js" also surfaces related technologies, preferences, and decisions.

### 📊 Search Reranking
After initial vector similarity search, an LLM scores each result's relevance (0.0-1.0) to the actual query. This catches cases where vector similarity alone misses semantic nuance. Can be disabled via config.

### 📜 Memory History (Audit Trail)
Every ADD, UPDATE, and DELETE operation is logged with:
- Before/after content
- Who changed it (agent ID or system)
- Why (dedup_merge, contradiction, manual, etc.)

---

## Architecture

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Agent 1    │   │   Agent 2    │   │   Agent N    │
│ (Device A)   │   │ (Device B)   │   │ (Device C)   │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ X-API-Key        │ X-API-Key        │ X-API-Key
       └──────────────────┼──────────────────┘
                          │ LAN (WiFi)
                   ┌──────▼──────┐
                   │   Memolo    │ ← 0.0.0.0:7437
                   │   Server    │   API + Dashboard
                   ├─────────────┤
                   │ Batch Queue │ ← queue + flush periodically
                   │ Fact Extract│ ← per-exchange atomic facts
                   │ Deduplicator│ ← LLM ADD/UPDATE/DELETE
                   │ Graph Engine│ ← entities + relationships
                   │ Reranker    │ ← LLM relevance scoring
                   │ Contradict. │ ← detect & supersede conflicts
                   │ Intelligence│ ← decay, dedup
                   │ LLM Service │ ← MiniMax M2.5
                   │ Auth Layer  │ ← master + per-agent keys
                   │ Config API  │ ← live runtime settings
                   └──────┬──────┘
              ┌───────────┼───────────┐
         ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
         │PostgreSQL│ │ Qdrant  │ │ Ollama  │
         │ 9 tables │ │ vectors │ │ (host)  │
         │ + graph  │ │ 4096dim │ │embed only│
         └─────────┘ └─────────┘ └─────────┘
```

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Server | Node.js + Express 4.18 |
| Database | PostgreSQL 16 (9 tables, 11 migrations) |
| Vector Store | Qdrant (Cosine similarity, 4096 dim) |
| Embeddings | Ollama `qwen3-embedding:8b` (local) |
| LLM (Facts/Dedup/Rerank) | MiniMax M2.5 (cloud, Anthropic-compatible API) |
| Auth | API key (master + per-agent) via `X-API-Key` header |
| Dashboard | Next.js 16 + TailwindCSS v4 + shadcn/ui (dark theme) |
| Deployment | Docker Compose (single command) |

## Database Schema

| Table | Purpose |
|-------|---------|
| `agents` | Registered AI agents with API keys |
| `conversations` | Conversation sessions per agent |
| `exchanges` | Raw user/agent message pairs |
| `memories` | Extracted facts, decisions, insights (with content_hash, actor_id, superseded_by) |
| `knowledge_base` | Curated knowledge entries |
| `memory_history` | Audit trail for all memory mutations |
| `entities` | Named entities from the knowledge graph |
| `relationships` | Typed links between entities |
| `memory_conversations` | Many-to-many memory ↔ conversation linking |

---

## Authentication

### 2-Tier API Keys

| Key Type | Set In | Purpose |
|----------|--------|---------|
| **Master key** | `.env` (`MEMOLO_MASTER_KEY`) | Admin: register agents, full access |
| **Per-agent key** | Auto-generated on register | Agent: store, recall, search |

- `GET /api/health` — **no auth required**
- If `MEMOLO_MASTER_KEY` not set → auth disabled (dev mode)

## Agent Integration

### SDK (Node.js)
```javascript
const { MemoryClient } = require('memolo');
const memory = new MemoryClient({
  agentId: 'my-agent',
  apiKey: 'agent-api-key-from-register',
  serverUrl: 'http://192.168.1.100:7437',
});

const ctx = await memory.recall('user question', { format: 'context' });
const result = await memory.store({ userMessage: '...', agentResponse: '...' });
```

### OpenClaw Plugin (Example Integration)
```json
{
  "memolo": {
    "agentId": "my-agent",
    "apiKey": "${MEMOLO_API_KEY}",
    "serverUrl": "http://192.168.1.100:7437"
  }
}
```

---

## API Reference

### Memory
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/memory/store` | Store exchange → triggers fact extraction |
| `POST` | `/api/memory/recall` | Recall memories (semantic + graph + rerank) |
| `POST` | `/api/memory/search` | Full-text + semantic search |
| `POST` | `/api/memory/summarize` | Manual summarization trigger |
| `GET` | `/api/memory/history` | Global memory audit log |
| `GET` | `/api/memory/memories/:id/history` | Per-memory audit trail |
| `GET` | `/api/memory/memories` | List memories (filterable by topic/scope/type/agent) |
| `GET` | `/api/memory/topics` | List unique topics with counts |
| `GET` | `/api/memory/exchanges` | List all exchanges |
| `GET` | `/api/memory/conversations` | List all conversations |
| `GET` | `/api/memory/conversations/:id` | Get conversation details |
| `POST` | `/api/memory/conversations/:id/end` | End conversation |
| `PATCH` | `/api/memory/:id` | Update memory (confirm/reject/supersede/update) |
| `DELETE` | `/api/memory/:id` | Delete memory |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/memory/agents/register` | Register agent → returns API key |
| `POST` | `/api/memory/agents/:id/regenerate-key` | Rotate API key |
| `GET` | `/api/memory/agents` | List agents |
| `GET` | `/api/memory/agents/:agentId/recent` | Recent memories for agent |

### Knowledge Graph
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/graph/entities/:agentId` | List entities for agent |
| `GET` | `/api/graph/entities/search?query=X` | Search entities by name |
| `GET` | `/api/graph/neighborhood/:id?agentId=X` | Entity + connections |
| `GET` | `/api/graph/:agentId` | Full agent graph (visualization) |

### Intelligence & System
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/intelligence/run` | Run intelligence tasks (decay/dedup) |
| `POST` | `/api/intelligence/permissions/grant` | Grant read permission |
| `POST` | `/api/intelligence/permissions/revoke` | Revoke read permission |
| `POST` | `/api/intelligence/permissions/team` | Grant all-to-all team access |
| `GET` | `/api/intelligence/knowledge` | Knowledge base entries |
| `GET` | `/api/intelligence/knowledge/search?q=X` | Search knowledge base |
| `GET` | `/api/intelligence/stats` | System stats |
| `GET` | `/api/health` | Health check (no auth) |
| `GET` | `/api/logs/stream` | SSE live event stream |
| `GET` | `/api/logs` | Recent logs |
| `GET` | `/api/logs/events` | Recent typed events |

### Runtime Config
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get all runtime settings with metadata |
| `PUT` | `/api/config` | Update settings (live, no restart needed) |
| `POST` | `/api/config/reset` | Reset one or all settings to defaults |

---

## Configuration

### Environment Variables

```env
# Required
MEMOLO_MASTER_KEY=your-secret-key

# MiniMax M2.5 (Required — LLM for fact extraction, dedup, reranking)
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=MiniMax-M2.5
MINIMAX_BASE_URL=https://api.minimax.io/anthropic/v1/messages

# Server
PORT=7437                                    # Server port (default: 7437)

# Ollama (Embeddings only)
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_EMBED_MODEL=qwen3-embedding:8b

# Feature Flags (all default: true)
ENABLE_FACT_EXTRACTION=true                  # Per-exchange atomic fact extraction
ENABLE_RERANKING=true                        # LLM search result reranking
ENABLE_GRAPH=true                            # Knowledge graph processing

# Tuning
EMBEDDING_DIMENSIONS=4096                    # Embedding vector dimensions
FACT_EXTRACT_TIMEOUT=60000                   # Fact extraction timeout (ms)
DEDUP_TIMEOUT=60000                          # Dedup decision timeout (ms)
RERANK_TIMEOUT=30000                         # Reranking timeout (ms)

# Database (no need to change for Docker)
PG_HOST=postgres
PG_PORT=5432
PG_USER=memolo
PG_PASSWORD=memolo_secret
PG_DATABASE=memolo
QDRANT_HOST=qdrant
QDRANT_PORT=6333
```

---

## Documentation

- 📋 [SETUP.md](SETUP.md) — Detailed setup & troubleshooting
- 📦 [SDK README](sdk/README.md) — Node.js client SDK
- 🔌 [Plugin README](plugin/README.md) — OpenClaw plugin integration docs
