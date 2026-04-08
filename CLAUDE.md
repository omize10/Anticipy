# Anticipy — Project Guide

## Overview
Anticipy is an AI wearable product website (Next.js 14) with an integrated **Action Engine** — a browser-based AI agent that receives plain English instructions and completes real tasks on real websites autonomously.

## Architecture

### Website (Next.js 14 on Vercel)
- **Framework**: Next.js 14 App Router (`src/app/`)
- **Styling**: Tailwind CSS with custom dark/cream/gold theme
- **Database**: Supabase (project "handlit", ref: `ogbxpqkmsdrcuilafycn`)
- **Auth**: Supabase Auth for admin; custom JWT for engine users
- **Key pages**: `/` (marketing), `/waitlist`, `/admin`, `/engine`

### Action Engine (Python FastAPI)
- **Location**: `/engine/` directory at project root
- **Runtime**: Python 3.12 + Playwright Chromium
- **Communication**: WebSocket for real-time task streaming
- **Browser agent**: Browser Use framework (open source, github.com/browser-use/browser-use)
- **LLM**: Gemini 2.5 Flash (primary) → Groq Llama 4 Scout (fallback)
- **CAPTCHA**: NopeCHA extension (free) + playwright-recaptcha (free)
- **Anti-bot**: Patchright stealth + headful Chrome + human-like delays
- **Design**: Browser Use handles observation, element extraction, and action execution. Safety, streaming, and cookies managed by our wrapper.

## Environment Variables
```
# Supabase
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# LLM Providers
GOOGLE_API_KEY        # Gemini (primary)
GROQ_API_KEY          # Groq (fallback)
DEEPSEEK_API_KEY      # Currently no credits

# CAPTCHA
TWOCAPTCHA_API_KEY
CAPSOLVER_API_KEY

# Engine
NEXT_PUBLIC_ENGINE_URL  # Backend URL for frontend
PROFILE_ENCRYPTION_KEY  # Fernet key for cookie encryption
```

## Running Locally

### Website
```bash
npm run dev
```

### Engine Backend
```bash
cd engine
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 &
export $(grep -v '^#' ../.env.local | xargs)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Access the Engine
1. Go to `/engine`
2. Enter access code: `123`
3. Create account or log in
4. Start chatting with the agent

### Test
```bash
cd engine
DISPLAY=:99 python test_real.py  # 10 real-world tests, target 9/10
```

## Engine Design Philosophy

1. **NO hardcoded website logic** — Browser Use reads pages generically via DOM + screenshots
2. **Single model sufficiency** — works with just Gemini OR just Groq
3. **Zero technical leakage** — user never sees JSON, API errors, model names
4. **Browser Use does the heavy lifting** — DOM extraction, element interaction, planning, loop detection
5. **Budget limits are code** — 40 steps, 300 seconds per task. Python enforced, not AI enforced.

## Database Tables

### Existing
- `anticipy_waitlist` — email signups
- `anticipy_admin_users` — admin access

### Engine
- `engine_users` — engine user accounts (username/password, bcrypt hashed)
- `browser_profiles` — saved cookies per user per site (Fernet encrypted)
- `engine_tasks` — task history with action logs

## Key Files
- `src/components/Footer.tsx` — has subtle "Engine" link
- `src/app/engine/page.tsx` — engine chat interface
- `engine/app/main.py` — FastAPI server, WebSocket handler, rate limiting
- `engine/app/agent.py` — Browser Use integration wrapper (core)
- `engine/app/models.py` — LLM wrapper with fallback chain (used for classification/planning)
- `engine/app/safety.py` — deterministic safety rules (blocked actions, confirmation)
- `engine/app/messages.py` — all user-facing message templates
- `engine/app/config.py` — env vars, budget limits
- `engine/app/auth.py` — bcrypt auth, JWT tokens, login rate limiting
- `engine/app/router.py` — task classification (chat/question/action)
- `engine/app/planner.py` — goal decomposition and URL extraction
- `engine/app/browser.py` — legacy browser manager (kept for reference)
- `engine/app/harness.py` — legacy observation compression (kept for reference)

## Known Limitations
- Canvas-heavy apps (Google Sheets, Figma) have limited interaction
- DataDome/Akamai on high-security sites may block datacenter IPs
- Some SPA form implementations may resist automated input
- Phase 2 will add user-device fallback for blocked sites

## Conventions
- Import alias: `@/` → `./src/`
- Components: PascalCase, named exports
- Client components: `"use client"` directive
- CSS: Tailwind utilities + CSS variables from globals.css
- Colors: dark (#0C0C0C), cream (#F5F0EB), gold (#C8A97E)
