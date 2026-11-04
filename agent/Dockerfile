FROM python:3.14-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc && rm -rf /var/lib/apt/lists/*

COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt

COPY streamable_http_sigv4.py .
COPY account_utils.py .
COPY agent.py .
COPY readiness.py .
# Dark-path agent loop (flag-gated, default OFF) — see ADR-008 (amended) / BASELINE §2.
COPY anthropic_loop.py .
# ADR-006 RCA (EoG) — read-only orchestrator reached via payload mode=="rca".
# Inert unless RCA_ORCHESTRATOR_ENABLED=true is set on the runtime (default off).
COPY rca_orchestrator.py .
COPY rca/ ./rca/

EXPOSE 8080

CMD ["python", "agent.py"]
