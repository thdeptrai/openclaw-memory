-- Migration 008: mem0-inspired improvements
-- Adds content_hash for instant dedup pre-check and actor_id for source tracking

-- 1. Add content_hash column to memories (MD5 of content for O(1) exact-match dedup)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash VARCHAR(32);

-- 2. Add actor_id column to memories (tracks whether memory came from 'user' or 'assistant')
ALTER TABLE memories ADD COLUMN IF NOT EXISTS actor_id VARCHAR(50) DEFAULT 'user';

-- 3. Create index on content_hash for fast lookups
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories (content_hash) WHERE content_hash IS NOT NULL;

-- 4. Backfill content_hash for existing memories
UPDATE memories SET content_hash = md5(content) WHERE content_hash IS NULL AND content IS NOT NULL;
