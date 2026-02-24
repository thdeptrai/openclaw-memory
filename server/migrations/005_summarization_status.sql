-- 005: Summarization Status Tracking
-- Tracks summarization state per-conversation for reliable retry and catch-up

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summarization_status TEXT DEFAULT 'idle';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summarization_retry_count INT DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summarization_failed_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summarization_pending_from INT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summarization_pending_to INT;

-- Index for sweep queries
CREATE INDEX IF NOT EXISTS idx_conversations_summarization_status ON conversations (summarization_status);
