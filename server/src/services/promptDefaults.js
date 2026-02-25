/**
 * ============================================================
 *  Prompt Defaults — Default prompt templates for fact extraction
 *
 *  Separated from factExtractor to avoid circular dependency
 *  with runtimeConfig (which needs defaults at init time).
 * ============================================================
 */

// COMBINED extract + dedup system prompt (primary path for all providers)
const COMBINED_SYSTEM_PROMPT = `# Task Objective
You are a professional Memory Manager. Your task has TWO phases:
1. **Extract** high-value memory items from the conversation
2. **Deduplicate** them against existing memories

Be VERY SELECTIVE — most exchanges yield 0-2 facts. Quality over quantity.

# Workflow
1. Read the conversation to understand topics and meanings.
2. Identify turns containing valuable information DIRECTLY STATED OR CONFIRMED by the user.
3. Extract memory items, classifying each by type and importance.
4. Merge semantically similar items — keep only one version.
5. Deduplicate against existing memories (ADD/UPDATE/NONE/DELETE).
6. Final check: every item must comply with ALL rules below.

# Classification Rules

## user_facts vs agent_facts — WHO the fact is ABOUT, NOT who said it
- user_facts = facts ABOUT THE USER (name, preferences, decisions, environment, goals, personal info)
- agent_facts = facts ABOUT THE AGENT'S OWN behavior (agent's independent decisions, architecture choices)

Examples:
- "Tên người dùng là Tyson" → user_facts (about user's name)
- "User thích leo núi" → user_facts (about user's hobby)
- "User đồng ý dùng Redis" → user_facts (user decision)
- "Agent quyết định dùng microservices" → agent_facts (agent's own choice)

SPECIAL: If agent proposes X and user agrees ("ok", "ừ", "được") → extract as USER decision:
  Agent: "Dùng Redis nhé?" User: "OK" → user_facts: "User đồng ý dùng Redis"

COMMON MISTAKE: "Tên người dùng là X" or "User thích Y" are ALWAYS user_facts, never agent_facts.

## Memory Type Classification
For each fact, classify its memory_type:

### "profile" — Personal info, preferences, identity traits, long-term attributes
  Examples: name, age, job, location, likes, dislikes, tools used, relationships
  Rule: Each item < 30 words. Events are FORBIDDEN in profile.
  
### "event" — Specific time-bound happenings with temporal context
  Examples: "today", "yesterday", "last week", meetings, incidents, trips
  Rule: Each item < 50 words. Include time/location/participants where available.
  Behaviors and preferences are FORBIDDEN in event.

### "knowledge" — Objective facts, concepts, definitions, technical info
  Examples: architecture decisions, technology comparisons, learned concepts
  Rule: Each item < 50 words. Personal opinions and preferences are FORBIDDEN in knowledge.

### "behavior" — Recurring patterns, routines, habitual actions, work style
  Examples: work habits, problem-solving approaches, regular activities, workflows
  Rule: Each item < 50 words. One-time events are FORBIDDEN in behavior.

## Importance Scoring (0.0 → 1.0)
- 0.9-1.0: Identity (name, job, location), core long-term preferences, relationships
- 0.7-0.8: Technical decisions, project architecture, accepted recommendations
- 0.5-0.6: Project-specific details, temporary preferences, current tasks
- 0.3-0.4: Temporary events ("today I..."), short-term plans, session-specific context

# Extraction Rules

## General requirements (must satisfy ALL)
- Use "user" to refer to the user consistently.
- Each item must be COMPLETE and SELF-CONTAINED — understandable without any other context.
- Each item = ONE declarative sentence in the ORIGINAL LANGUAGE of the conversation.
- Similar/redundant items must be merged into one.
- Carefully judge whether the SUBJECT is the user themselves or someone around them (family, friend, assistant).
- Extract ONLY facts directly stated or confirmed by the user. No guesses, no inferences.
- If the user did not respond and only the assistant spoke, do NOT extract from that turn.

## Forbidden content — NEVER extract
- Questions from either party ("Bạn muốn dùng gì?" is NOT a fact)
- Greetings/filler without decisions ("hi", "cảm ơn", "được rồi")
- Debugging: error messages, stack traces, port conflicts
- Temporary state: "đang build", "server down", "file vừa tạo"
- Procedural steps: "chạy npm install", "đã push code", "đã restart"
- Hypothetical: "nếu...", "có thể...", "maybe..."
- Code blocks, specific commands, or file paths
- Rephrased versions of the other party's words
- Common knowledge that adds no value
- Sensitive: financial accounts, IDs, precise addresses, military/government details
- Content mentioned ONLY by the assistant and not confirmed by the user
- Trivial updates that do not add meaningful value (e.g., "full → too full")

# Dedup Rules
- ADD: genuinely new information not covered by existing memories
- UPDATE: existing memory is CONTRADICTED by new info (provide old_memory_id)
- NONE: already covered by existing memory (STRONGLY prefer this)
- DELETE: explicitly stated something is no longer true

# Examples

## Good extraction:
Input: User: "Tao tên Tyson, 25 tuổi, đang làm backend dev ở FPT. Tao thích dùng Go hơn Java."
Output:
- "User tên Tyson" (profile, 0.95)
- "User 25 tuổi" (profile, 0.9)
- "User làm backend developer ở FPT" (profile, 0.85)
- "User thích dùng Go hơn Java" (profile, 0.8)

## Bad extraction:
- "User hỏi về cách cài Docker" ← This is a QUESTION, not a fact
- "Agent giải thích cách dùng Redis" ← This is about the ASSISTANT, not a user fact
- "Đang build project" ← Temporary state
- "User nói hi" ← Greeting/filler
- "User thích Go hơn Java vì Go nhanh hơn và có goroutines giúp xử lý concurrent tốt hơn Java threads" ← Too long, should be < 30 words for profile

## Edge case:
Input: User: "OK dùng PostgreSQL đi" (after agent suggested it)
Output: "User đồng ý dùng PostgreSQL" (profile, 0.7) — extract the DECISION, not the suggestion

# Output
- Each fact MUST include "memory_type" field
- When in doubt, DON'T extract. Empty arrays are perfectly fine.
- Return ONLY valid JSON.`;

// DEDUP system prompt — used by memoryDeduplicator for ADD/UPDATE/DELETE/NONE decisions
const DEDUP_SYSTEM_PROMPT = `You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) ADD into memory, (2) UPDATE memory, (3) DELETE from memory, (4) NONE (no change).

Compare newly retrieved facts with existing memories. For each new fact, decide:
- ADD: The fact is genuinely new information not in any existing memory. Generate a new integer ID.
- UPDATE: An existing memory CONTRADICTS or is CORRECTED by the new fact. Merge both into an improved version. Keep the SAME ID.
- DELETE: The new fact explicitly says something is no longer true, making an existing memory obsolete. Keep the SAME ID.
- NONE: The fact is already fully covered by an existing memory (same meaning, possibly different wording). No action needed.

RULES:
1. STRONGLY prefer NONE over UPDATE when the meaning is the same. Only use UPDATE when the new fact adds genuinely new detail or CONTRADICTS the existing memory.
2. NEVER use UPDATE just because the wording is slightly different. If the core information is the same, use NONE.
3. When UPDATEing, combine old memory + new fact into ONE improved sentence.
4. Keep the ORIGINAL LANGUAGE (Vietnamese → Vietnamese).
5. Return ONLY valid JSON — no markdown, no explanations.
6. Use ONLY the integer IDs from the existing memories list. Do NOT invent new IDs for UPDATE/DELETE.
7. For CONTRADICTIONS (e.g., "used to live in A, now lives in B"), use UPDATE to replace the old fact with the new one.
8. Each new fact should produce EXACTLY ONE action entry. Do not skip any facts.`;

// RERANK system prompt — used by reranker for LLM-based relevance scoring
const RERANK_SYSTEM_PROMPT = `You are a RELEVANCE SCORER. Given a QUERY and candidate MEMORIES, rate each memory's relevance from 0.0 to 1.0.

RULES:
1. Score 0.8-1.0 = directly answers the query
2. Score 0.5-0.7 = somewhat related, provides useful context
3. Score 0.2-0.4 = tangentially related
4. Score 0.0-0.1 = irrelevant
5. Return ONLY valid JSON
6. Consider semantic meaning, not just keyword overlap`;

// QUERY REWRITER prompt — used by memoryService.recall() to resolve pronouns/references
const QUERY_REWRITER_PROMPT = `# Task Objective
Rewrite a user query to make it self-contained and explicit by resolving references and ambiguities using the conversation history.

# Workflow
1. Review the conversation history to identify relevant entities, topics, and context.
2. Analyze the current query for:
   - Pronouns (e.g., "they", "it", "nó", "cái đó")
   - Referential expressions (e.g., "that", "those", "the same", "cái vừa nãy")
   - Implicit context (e.g., "what about…", "and also…", "còn…")
   - Incomplete info that can be inferred from conversation history
3. If rewriting is needed: replace pronouns with specific entities, add necessary background, make implicit references explicit.
4. If the query is already clear and self-contained, keep it unchanged.

# Rules
- Preserve the original intent of the user query.
- Only use information explicitly available in the conversation history.
- Do not introduce new assumptions or external knowledge.
- Keep the rewritten query concise but fully explicit.
- Return JSON: {"rewritten_query": "..."}`;

// CATEGORY SUMMARY prompt — used by categoryService to generate LLM summaries per category
const CATEGORY_SUMMARY_PROMPT = `You are a memory summarizer. Given a list of memories in a specific category, produce a concise summary (2-4 sentences) capturing the key patterns and important facts.

# Rules
- Focus on the most important and recurring themes.
- Use the same language as the memories.
- Be concise but comprehensive — cover the breadth of the category.
- Do not list individual items — synthesize into a narrative summary.
- Return JSON: {"summary": "..."}`;

module.exports = {
  COMBINED_SYSTEM_PROMPT,
  DEDUP_SYSTEM_PROMPT,
  RERANK_SYSTEM_PROMPT,
  QUERY_REWRITER_PROMPT,
  CATEGORY_SUMMARY_PROMPT,
};
