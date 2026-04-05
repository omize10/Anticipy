# Anticipy Action Engine — Build Progress Log

## Phase 0: Reconnaissance
- Explored entire codebase: Next.js 14, src/app/ structure, Tailwind CSS
- Found Supabase client at src/lib/supabase.ts (project "handlit", ref: ogbxpqkmsdrcuilafycn)
- Existing pages: /, /waitlist, /admin, /privacy, /terms, /refund
- No .env files existed — created .env.local with all credentials

## Phase 1: API Key Setup
- Parsed and saved all provided API keys to .env.local
- Retrieved Supabase URL, anon key, and service role key via management API
- **Tested all LLM keys:**
  - DeepSeek: 402 Payment Required (no credits — moved to last in fallback chain)
  - Groq (Llama 3.3 70B): Working
  - Gemini (2.5 Flash): Working (fixed model name from 2.0 to 2.5)
- Fallback order: Groq -> Gemini -> DeepSeek

## Phase 2: Database
- Created 3 tables via Supabase migration: engine_users, browser_profiles, engine_tasks
- Enabled RLS on all tables with appropriate policies
- Tested auth signup/login against Supabase — working

## Phase 3: Engine Backend (Python/FastAPI)
- Created 17 files under engine/app/
- Key design decisions:
  - Raw httpx calls to LLM APIs (no SDK dependencies)
  - Accessibility tree extraction + smart element filtering
  - Page text included in prompts (skipping nav boilerplate)
  - Word-boundary safety matching (catches "delete my Google account")
  - Keyword pre-classifier for deterministic classification
  - "done" action can carry answer text for information tasks
- **Bug fixes during development:**
  - Fixed .format() KeyError in prompts (JSON braces conflicting)
  - Fixed Supabase column name mismatches (site_domain vs domain)
  - Fixed WebSocket auth token extraction from query params
  - Fixed frontend auth response parsing (data.success not res.ok)
  - Improved page text excerpting (skip nav, show 600 chars)
  - Improved element extraction (filter nav elements, prioritize content)

## Phase 4: Frontend (/engine page)
- Created src/app/engine/page.tsx — 655 lines
- Three-phase UI: Access gate (SHA-256 of "123") -> Login/Signup -> Chat
- WebSocket real-time messaging with status indicators
- Confirmation buttons and login-needed states
- Matches site's dark/gold/cream theme

## Phase 5: Testing
- Classification: 9/9 deterministic tests pass (pre-classifier + LLM fallback)
- Safety: 15/15 blocked/confirm rules pass
- Chat responses: 3/3 no technical leakage
- Question responses: 2/2 no technical leakage
- Browser task (Wikipedia): Completes in 1 step, ~4 seconds
- Error handling: Graceful on nonexistent websites
- **Total: 31/31 tests, 3 consecutive clean runs**

## Test Results Summary
| Run | Result |
|-----|--------|
| 1   | 31/31  |
| 2   | 31/31  |
| 3   | 31/31  |

## Known Limitations
- DeepSeek API key has no credits (Groq is primary, works well)
- Browser view for user login is placeholder (shows empty panel)
- No proxy support (by design — logged-in user sessions don't need it)
- Canvas-heavy pages (WebGL) may not have accessible elements
- CAPTCHA solving requires paid API credits (capsolver/2captcha)

## Cost Analysis
- Classification call: ~$0.0001
- Planning call: ~$0.0001
- Per-step action call: ~$0.0001
- Wikipedia task total: ~$0.0005 (well under $0.08 budget)
