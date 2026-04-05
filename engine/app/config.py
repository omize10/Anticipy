"""
Configuration loaded from environment variables.
All budget limits and model fallback order defined here.
"""

import os


# --- Supabase ---
SUPABASE_URL: str = os.environ.get(
    "NEXT_PUBLIC_SUPABASE_URL",
    "https://ogbxpqkmsdrcuilafycn.supabase.co",
)
SUPABASE_ANON_KEY: str = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")

# --- LLM API keys ---
DEEPSEEK_API_KEY: str = os.environ.get("DEEPSEEK_API_KEY", "")
GROQ_API_KEY: str = os.environ.get("GROQ_API_KEY", "")
GOOGLE_API_KEY: str = os.environ.get("GOOGLE_API_KEY", "")

# --- CAPTCHA solving ---
CAPSOLVER_API_KEY: str = os.environ.get("CAPSOLVER_API_KEY", "")
TWOCAPTCHA_API_KEY: str = os.environ.get("TWOCAPTCHA_API_KEY", "")

# --- JWT ---
JWT_SECRET: str = os.environ.get("JWT_SECRET", "anticipy-engine-secret-change-me")
JWT_ALGORITHM: str = "HS256"
JWT_EXPIRY_HOURS: int = 72

# --- Budget limits (hard caps) ---
MAX_STEPS: int = 40
MAX_SECONDS: int = 180
MAX_COST_USD: float = 0.08

# --- Agent tuning ---
VERIFY_EVERY_N_STEPS: int = 7
LOOP_DETECTION_THRESHOLD: int = 3
MAX_LABELED_ELEMENTS: int = 15
MEMORY_MAX_CHARS: int = 300

# --- Model fallback chain ---
# Each entry: (name, base_url, api_key_value, model_id, cost_per_1k_input, cost_per_1k_output)
MODEL_CHAIN: list[dict] = []


def _build_model_chain() -> list[dict]:
    """Build the ordered fallback chain from available keys."""
    chain: list[dict] = []
    if GROQ_API_KEY:
        chain.append(
            {
                "name": "groq",
                "base_url": "https://api.groq.com/openai/v1",
                "api_key": GROQ_API_KEY,
                "model": "llama-3.3-70b-versatile",
                "cost_input": 0.00059,
                "cost_output": 0.00079,
            }
        )
    if GOOGLE_API_KEY:
        chain.append(
            {
                "name": "gemini",
                "base_url": "https://generativelanguage.googleapis.com/v1beta",
                "api_key": GOOGLE_API_KEY,
                "model": "gemini-2.5-flash",
                "cost_input": 0.0001,
                "cost_output": 0.0004,
            }
        )
    if DEEPSEEK_API_KEY:
        chain.append(
            {
                "name": "deepseek",
                "base_url": "https://api.deepseek.com/v1",
                "api_key": DEEPSEEK_API_KEY,
                "model": "deepseek-chat",
                "cost_input": 0.00014,
                "cost_output": 0.00028,
            }
        )
    return chain


MODEL_CHAIN = _build_model_chain()
