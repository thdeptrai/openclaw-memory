-- Migration 009: Many-to-many memory ↔ conversation linking
-- Enables accurate "Extracted Knowledge" display per conversation

CREATE TABLE IF NOT EXISTS memory_conversations (
    memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (memory_id, conversation_id)
);

-- Fast lookup: "give me all memories for this conversation"
CREATE INDEX IF NOT EXISTS idx_mc_conversation ON memory_conversations(conversation_id);

-- Backfill from existing source_conversation_id column
INSERT INTO memory_conversations (memory_id, conversation_id)
SELECT id, source_conversation_id FROM memories
WHERE source_conversation_id IS NOT NULL AND superseded_by IS NULL
ON CONFLICT DO NOTHING;
