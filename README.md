# 🧠 Memolo — Intelligent Memory System for Multi-Agent AI

> Persistent, self-organizing memory for AI agents — atomic fact extraction, knowledge graph, LLM deduplication, and semantic recall across your LAN

## Quick Start (Docker)

```bash
# 1. Clone & configure
cd openclaw-memory
cp .env.example .env
# Edit .env → set MEMOLO_MASTER_KEY to a random string

# 2. Ensure Ollama is running with required models
ollama pull qwen3-embedding:8b && ollama pull qwen2.5:7b

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
    │ 2. Embed & Index  │  Generate 4096-dim embedding via Ollama,
    │                   │  store in Qdrant for semantic search
    └───────┬───────────┘
            │
            ├──────────── (async, non-blocking) ──────────┐
            │                                              │
            ▼                                              ▼
    ┌───────────────────┐                          ┌──────────────────┐
    │ 3. Extract Facts  │                          │ 6. Summarization │
    │ (per exchange)    │  LLM extracts 2-5        │ (every N msgs)   │
    │                   │  atomic facts + entities │                  │
    └───────┬───────────┘                          └──────────────────┘
            │
            ▼
    ┌───────────────────┐
    │ 4. Deduplicate    │  For each fact:
    │                   │   • Content hash check (O(1) exact match)
    │                   │   • Embed it → search top-5 similar in Qdrant
    │                   │   • LLM decides:
    │                   │     ADD    → genuinely new info
    │                   │     UPDATE → merge with existing (supersede old)
    │                   │     DELETE → contradicts existing (remove old)
    │                   │     NONE   → already exists (skip)
    └───────┬───────────┘
            │
            ▼
    ┌───────────────────┐
    │ 5. Update Graph   │  Entities → entities table
    │                   │  Co-occurring entities → relationships table
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

### 🧠 LLM Deduplication
When a new fact is extracted, Memolo doesn't blindly store it. Instead:

1. **Hash check** — O(1) exact-match via content_hash (MD5)
2. **Embed** the fact into a 4096-dim vector
3. **Search** for the top-5 most similar existing memories in Qdrant
4. **Ask the LLM** to decide what to do

This prevents memory bloat and handles contradictions automatically:

```
Existing:  "Database là PostgreSQL"
New fact:  "Đã chuyển sang MySQL thay vì PostgreSQL"

LLM Decision: UPDATE
Result:    "Đã chuyển sang sử dụng MySQL thay vì PostgreSQL" (old superseded)
```

**Key technique:** UUIDs are mapped to integers `[0], [1], [2]...` before sending to the LLM to prevent hallucination (inspired by mem0).

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

### ⚡ Progressive Summarization
Every N exchanges (default: 5, configurable), Memolo creates a batch summary that captures the high-level narrative, extracting facts, decisions, and preferences as structured memories.

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
                   │ Fact Extract│ ← per-exchange atomic facts
                   │ Deduplicator│ ← LLM ADD/UPDATE/DELETE
                   │ Graph Engine│ ← entities + relationships
                   │ Reranker    │ ← LLM relevance scoring
                   │ Summarizer  │ ← progressive reduction
                   │ Intelligence│ ← decay, dedup, contradiction
                   │ LLM Service │ ← Ollama / MiniMax provider
                   │ Auth Layer  │ ← master + per-agent keys
                   │ Config API  │ ← live runtime settings
                   └──────┬──────┘
              ┌───────────┼───────────┐
         ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
         │PostgreSQL│ │ Qdrant  │ │ Ollama  │
         │10 tables │ │ vectors │ │ (host)  │
         │ + graph  │ │ 4096dim │ │         │
         └─────────┘ └─────────┘ └─────────┘
```

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Server | Node.js + Express 4.18 |
| Database | PostgreSQL 16 (10 tables, 9 migrations) |
| Vector Store | Qdrant (Cosine similarity, 4096 dim) |
| Embeddings | Ollama `qwen3-embedding:8b` |
| LLM (Facts/Dedup/Rerank/Summarize) | Ollama `qwen2.5:7b` (default) or MiniMax M2.5 |
| Auth | API key (master + per-agent) via `X-API-Key` header |
| Dashboard | Vanilla HTML/CSS/JS (SPA, dark theme) |
| Deployment | Docker Compose (single command) |

## Database Schema

| Table | Purpose |
|-------|---------|
| `agents` | Registered AI agents with API keys |
| `conversations` | Conversation sessions per agent |
| `exchanges` | Raw user/agent message pairs |
| `memories` | Extracted facts, decisions, insights (with content_hash, actor_id, superseded_by) |
| `summaries` | Batch conversation summaries |
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
const { MemoryClient } = require('openclaw-memory');
const memory = new MemoryClient({
  agentId: 'my-agent',
  apiKey: 'agent-api-key-from-register',
  serverUrl: 'http://192.168.1.100:7437',
});

const ctx = await memory.recall('user question', { format: 'context' });
const result = await memory.store({ userMessage: '...', agentResponse: '...' });
```

### OpenClaw Plugin
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
| `POST` | `/api/memory/conversations/:id/end` | End conversation + trigger summarization |
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
| `POST` | `/api/intelligence/run` | Run intelligence tasks (decay/dedup/consolidate) |
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

# Server
PORT=7437                                    # Server port (default: 7437)

# LLM Provider (choose one)
LLM_PROVIDER=ollama                          # 'ollama' (default) or 'minimax'

# Ollama (defaults shown)
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b
OLLAMA_EMBED_MODEL=qwen3-embedding:8b
OLLAMA_TIMEOUT=180000                        # Ollama request timeout (ms)

# MiniMax M2.5 (optional, if LLM_PROVIDER=minimax)
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=MiniMax-M2.5
MINIMAX_BASE_URL=https://api.minimax.io/anthropic/v1/messages

# Feature Flags (all default: true)
ENABLE_FACT_EXTRACTION=true                  # Per-exchange atomic fact extraction
ENABLE_RERANKING=true                        # LLM search result reranking
ENABLE_GRAPH=true                            # Knowledge graph processing

# Tuning
SUMMARIZE_AFTER_EXCHANGES=5                  # Batch summarize every N exchanges
EMBEDDING_DIMENSIONS=4096                    # Embedding vector dimensions
FACT_EXTRACT_TIMEOUT=60000                   # Fact extraction timeout (ms)
DEDUP_TIMEOUT=60000                          # Dedup decision timeout (ms)
RERANK_TIMEOUT=30000                         # Reranking timeout (ms)

# Database (no need to change for Docker)
PG_HOST=postgres
PG_PORT=5432
PG_USER=openclaw
PG_PASSWORD=openclaw_secret
PG_DATABASE=openclaw_memory
QDRANT_HOST=qdrant
QDRANT_PORT=6333
```

---

## Documentation

- 📋 [SETUP.md](SETUP.md) — Detailed setup & troubleshooting
- 📦 [SDK README](sdk/README.md) — Node.js client SDK
- 🔌 [Plugin README](plugin/README.md) — OpenClaw plugin docs
