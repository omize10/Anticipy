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
- **Models**: Groq (Llama 3.3 70B) primary, Gemini 2.5 Flash fallback
- **Design**: Harness-driven — the harness compresses observations and constrains the action space so cheap models perform well

## Environment Variables
```
# Supabase
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# LLM Providers
GROQ_API_KEY          # Primary model
GOOGLE_API_KEY        # Gemini fallback
DEEPSEEK_API_KEY      # Currently no credits

# CAPTCHA
TWOCAPTCHA_API_KEY
CAPSOLVER_API_KEY

# Engine
NEXT_PUBLIC_ENGINE_URL  # Backend URL for frontend
```

## Running Locally

### Website
```bash
npm run dev
```

### Engine Backend
```bash
cd engine
export $(grep -v '^#' ../.env.local | xargs)
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Access the Engine
1. Go to `/engine`
2. Enter access code: `123`
3. Create account or log in
4. Start chatting with the agent

## Engine Design Philosophy

1. **NO hardcoded website logic** — agent reads pages generically via accessibility tree
2. **Single model sufficiency** — works with just Groq OR just Gemini
3. **Zero technical leakage** — user never sees JSON, API errors, model names
4. **Harness does the heavy lifting** — compresses observations, constrains actions, manages memory
5. **Budget limits are code** — 40 steps, 180 seconds, $0.08 max per task

## Database Tables

### Existing
- `anticipy_waitlist` — email signups
- `anticipy_admin_users` — admin access

### Engine
- `engine_users` — engine user accounts (username/password)
- `browser_profiles` — saved cookies per user per site
- `engine_tasks` — task history with action logs

## Key Files
- `src/components/Footer.tsx` — has subtle "Engine" link
- `src/app/engine/page.tsx` — engine chat interface
- `engine/app/main.py` — FastAPI server
- `engine/app/agent.py` — core execution loop
- `engine/app/harness.py` — observation compression (core IP)
- `engine/app/models.py` — LLM wrapper with fallback chain
- `engine/app/safety.py` — deterministic safety rules
- `engine/app/messages.py` — all user-facing messages

## Conventions
- Import alias: `@/` → `./src/`
- Components: PascalCase, named exports
- Client components: `"use client"` directive
- CSS: Tailwind utilities + CSS variables from globals.css
- Colors: dark (#0C0C0C), cream (#F5F0EB), gold (#C8A97E)
