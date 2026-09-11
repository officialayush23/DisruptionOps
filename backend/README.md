# Indradhanu — backend

FastAPI service behind the three interfaces. Hazard adapters, the policy gate,
the allocation solver and the agent orchestrator live here.

## Setup

**Python 3.11 or newer is required.** `datetime.UTC` and `enum.StrEnum` are
3.11 additions and are used throughout. `app/__init__.py` refuses to import on
anything older, with a message explaining what to do.

```powershell
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1     # Windows PowerShell
pip install -r requirements-dev.txt
copy .env.example .env          # then fill it in
```

See `PHASE0.md` for the full Windows walkthrough, including how to get a staff
identity before any Supabase user exists.

## Run

```powershell
uvicorn app.main:app --reload --port 8000
```

Note `app.main:app`. `app` is the FastAPI instance; `app.main:main` does not
exist.

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
| `app/world/` | the clock every timestamp comes from, and the append-only event log |
| `app/taxonomy.py` | hazards, categories, resource kinds and capabilities, read from reference tables |
| `migrations/` | schema migrations, in order |

## Adding a hazard

One row in `hazard_types`, one file in `app/hazards/`, one line in
`registry.load_adapters()`. Implement `fetch_signal`, `score` and
`action_policy`; `impact` has a sensible default. Nothing else in the codebase
changes, which is the whole point of the contract.

`action_policy` expresses what an action needs as capabilities, never as vehicle
names: `resource_need={"dewatering": 1, "water_rescue": 1}`. Which kind of unit
answers a capability is per-city fleet data in `resource_kind_capabilities`, and
the solver resolves it. That is what lets the same adapter run in a city with
entirely different equipment.

## Adding a city

Rows in `cities`, then its own wards, lifelines, resources, agencies and policy
clauses carrying that `city_id`. No code changes. `GET /api/v1/taxonomy?cityId=`
is what the frontend reads so it does not hard-code any of it.

## Where the LLM is, and is not

The model reasons and explains. It does not produce numbers. Risk scores come
from the adapters, allocation comes from CP-SAT, and authority comes from the
policy corpus. If the model is unavailable, every one of those still works and
the API reports `engine: "fallback"`.
