# syntax=docker/dockerfile:1
# Atlas chatbot — Flask + Amazon Bedrock, served by Gunicorn.
#
# No AWS credentials are baked into this image. boto3 finds them at runtime:
#   - on EC2: from the instance's IAM role (instance profile) via the metadata service
#   - locally: from a read-only mount of ~/.aws (see deploy/README.md)

FROM python:3.14-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /usr/local/bin/uv

WORKDIR /app

# Install dependencies first (cached layer), exactly as pinned in uv.lock
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Application code
COPY app.py db.py ./
COPY templates ./templates
COPY static ./static

# Run as an unprivileged user; SQLite database lives on a volume
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data \
    && chown -R app:app /app/data
USER app

ENV AWS_REGION=us-east-1 \
    BEDROCK_MODEL_ID=global.anthropic.claude-opus-4-6-v1 \
    BEDROCK_MAX_TOKENS=2048 \
    DATABASE_PATH=/app/data/chat.db \
    PORT=8000

VOLUME ["/app/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health', timeout=4)"

# gthread workers keep long streaming replies from blocking other requests
CMD ["sh", "-c", "exec gunicorn app:app --bind 0.0.0.0:${PORT} --workers 2 --worker-class gthread --threads 8 --timeout 300 --access-logfile -"]
