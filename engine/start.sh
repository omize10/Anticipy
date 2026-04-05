#!/bin/bash
# Start Xvfb for headless display
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Start the FastAPI server
uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
