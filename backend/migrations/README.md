# Migrations

Applied to the Supabase project `Indradhanu` (`wfkzdevcfancytlvezxx`) in this
order. They are recorded here so the schema is reproducible from the repository
rather than only existing in one hosted database.

| File | What it does |
|---|---|
| `001_portability_taxonomy_as_data.sql` | cities, hazard types, capabilities, resource kinds, lifeline kinds, incident categories, and the capability mappings |
| `002_convert_taxonomy_enums_to_fks.sql` | converts the taxonomy enum columns to text foreign keys and drops the old enums |
| `003_cities_agencies_events_simruns.sql` | city scoping, agencies, simulation runs, the append-only event log, RLS |

Run 001 to 003 in order against a fresh database. They are written to be safe to
re-run: every create is `if not exists` and every seed is `on conflict do nothing`.
002 is the exception, since dropping a type is not idempotent; it is written to
run once against the schema 001 leaves behind.

## The one thing to understand before editing these

Taxonomy is data, lifecycle is type. Which hazards, incident categories,
resource kinds and agencies exist lives in tables, because a new city or a new
disaster must not require a migration and a redeploy. Status columns
(`incident_status`, `assignment_status`, `task_status`, `decision_status`,
`resource_status`, `app_role`) stay as Postgres enums, because application code
branches on them and a value outside the set really would be a bug.
