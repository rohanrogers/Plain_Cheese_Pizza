# ─────────────────────────────────────────────────────────────────────────────
# Brightloop Integrated IAM & Finance Application — Dockerfile
# Base: Ubuntu 22.04 LTS | Python 3.11 + FastAPI + Uvicorn
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        curl \
        ca-certificates \
        libpq5 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements in virtualenv
COPY requirements.txt .
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY .env.example ./.env

# Create non-root user
RUN groupadd --system brightloop && useradd --system --gid brightloop brightloop
RUN chown -R brightloop:brightloop /app
USER brightloop

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3000/api/health || exit 1

CMD ["python3", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "3000"]

