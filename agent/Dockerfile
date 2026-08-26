FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "strands-agents==1.41.0" \
    strands-agents-tools \
    boto3 \
    psycopg2-binary \
    "bedrock-agentcore<=0.1.5" \
    "anthropic[bedrock]==0.111.0" \
    mcp \
    httpx \
    httpx-sse \
    aws-requests-auth

COPY streamable_http_sigv4.py .
COPY account_utils.py .
COPY agent.py .
# Dark-path agent loop (flag-gated, default OFF) — see ADR-008 (amended) / BASELINE §2.
COPY anthropic_loop.py .
# ADR-006 RCA (EoG) — read-only orchestrator reached via payload mode=="rca".
# Inert unless RCA_ORCHESTRATOR_ENABLED=true is set on the runtime (default off).
COPY rca_orchestrator.py .
COPY rca/ ./rca/

EXPOSE 8080

CMD ["python", "agent.py"]
