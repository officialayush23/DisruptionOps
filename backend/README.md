# Indradhanu — backend

FastAPI service behind the three interfaces. Hazard adapters, the policy gate,
the allocation solver and the agent orchestrator live here.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements-dev.txt
copy .env.example .env          # then fill it in
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

- `http://localhost:8000/docs` — OpenAPI (disabled in production)
- `http://localhost:8000/health` — readiness, including the database
- `http://localhost:8000/health/live` — liveness, no dependencies

## Seed the Pune reference data

```bash
python -m app.seed.seed_pune
```

Idempotent. Touches reference geography only; never operational records.

## Layout

| Path | What lives there |
|---|---|
| `app/core/` | config, logging, errors, auth, middleware |
| `app/db/` | asyncpg pool and the read models |
| `app/hazards/` | the adapter contract and one file per hazard |
| `app/ingest/` | upstream feeds, with cache and fallback |
| `app/solver/` | CP-SAT allocation and travel-time routing |
| `app/agents/` | LLM provider and the policy gate |
| `app/api/v1/` | HTTP surface |

## Adding a hazard

One file in `app/hazards/`, one line in `registry.load_adapters()`. Implement
`fetch_signal`, `score` and `action_policy`; `impact` has a sensible default.
Nothing else in the codebase changes — that is the whole point of the contract.

## Where the LLM is, and is not

The model reasons and explains. It does not produce numbers. Risk scores come
from the adapters, allocation comes from CP-SAT, and authority comes from the
policy corpus. If the model is unavailable, every one of those still works and
the API reports `engine: "fallback"`.
