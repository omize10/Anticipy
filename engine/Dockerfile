FROM mcr.microsoft.com/playwright/python:v1.49.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Install patchright browsers
RUN python -m patchright install chromium

COPY . .

EXPOSE 8000
CMD ["sh", "start.sh"]
