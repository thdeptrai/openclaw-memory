-- Migration 010: Change conversations.id from UUID to TEXT
-- Some agents (e.g. OpenClaw) send string IDs like "agent:main:main" which are not valid UUIDs

-- Drop foreign key constraints first
ALTER TABLE exchanges DROP CONSTRAINT IF EXISTS exchanges_conversation_id_fkey;
ALTER TABLE summaries DROP CONSTRAINT IF EXISTS summaries_conversation_id_fkey;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_source_conversation_id_fkey;
ALTER TABLE memory_conversations DROP CONSTRAINT IF EXISTS memory_conversations_conversation_id_fkey;

-- Change column types
ALTER TABLE conversations ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE exchanges ALTER COLUMN conversation_id TYPE TEXT USING conversation_id::text;
ALTER TABLE summaries ALTER COLUMN conversation_id TYPE TEXT USING conversation_id::text;
ALTER TABLE memories ALTER COLUMN source_conversation_id TYPE TEXT USING source_conversation_id::text;
ALTER TABLE memory_conversations ALTER COLUMN conversation_id TYPE TEXT USING conversation_id::text;

-- Re-add foreign key constraints
ALTER TABLE exchanges ADD CONSTRAINT exchanges_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE summaries ADD CONSTRAINT summaries_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE memories ADD CONSTRAINT memories_source_conversation_id_fkey FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE memory_conversations ADD CONSTRAINT memory_conversations_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

-- Update default to use random hex instead of gen_random_uuid()
ALTER TABLE conversations ALTER COLUMN id SET DEFAULT encode(gen_random_bytes(16), 'hex');
