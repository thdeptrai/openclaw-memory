-- OpenClaw Memory System — Initial Schema
-- Run: psql -U openclaw -d openclaw_memory -f migrations/001_initial.sql

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Agents registry
CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id VARCHAR(50) REFERENCES agents(id) ON DELETE CASCADE,
  user_id VARCHAR(100) DEFAULT 'default',
  title VARCHAR(500) DEFAULT '',
  status VARCHAR(20) DEFAULT 'active',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  summary TEXT,
  message_count INT DEFAULT 0
);

-- Create index for agent lookups
CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

-- Individual exchanges (raw messages)
CREATE TABLE IF NOT EXISTS exchanges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_message TEXT NOT NULL,
  agent_response TEXT NOT NULL,
  sequence_num INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for conversation lookups
CREATE INDEX IF NOT EXISTS idx_exchanges_conversation_id ON exchanges(conversation_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_sequence ON exchanges(conversation_id, sequence_num);

-- Extracted memories (facts, decisions, insights)
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL CHECK (type IN ('fact', 'decision', 'task', 'insight', 'summary')),
  content TEXT NOT NULL,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_agent_id VARCHAR(50) REFERENCES agents(id) ON DELETE SET NULL,
  importance_score FLOAT DEFAULT 0.5,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

-- Indexes for memory queries
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(source_agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score DESC);

-- Trigram index for fuzzy text search (requires pg_trgm)
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin(content gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm index skipped: %', SQLERRM;
END $$;

-- Conversation summaries (periodic)
CREATE TABLE IF NOT EXISTS summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  from_sequence INT,
  to_sequence INT,
  summary_text TEXT NOT NULL,
  facts_extracted JSONB DEFAULT '[]',
  decisions_made JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON summaries(conversation_id);
