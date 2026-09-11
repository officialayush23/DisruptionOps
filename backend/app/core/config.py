"""Typed settings, loaded once and cached.

Nothing in the codebase reads os.environ directly; everything goes through
`settings`, so a missing variable fails at startup rather than at the first
request that happens to need it.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, PostgresDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "staging", "production"]
LLMProvider = Literal["gemini", "bedrock", "fallback"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- environment ----
    indradhanu_env: Environment = "development"
    log_level: str = "INFO"
    cors_origins: str = "http://localhost:5173"

    # ---- database ----
    supabase_url: str = ""
    supabase_anon_public_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_key: str = ""
    supabase_transaction_pooler: str = ""
    supabase_direct_connection_string: str = ""
    db_pool_min: int = 2
    db_pool_max: int = 10

    # ---- development convenience ----
    # When set AND the environment is development, an unauthenticated request is
    # treated as this role instead of as an anonymous citizen. It exists so the
    # API can be exercised before any Supabase user has been created, which is
    # otherwise a chicken-and-egg problem: POST /runs needs a staff token, and
    # the only way to get one is to have already set up a staff profile.
    #
    # The validator below refuses to start if this is set outside development.
    # A convenience that can be left switched on by accident in production is
    # not a convenience, it is an unauthenticated admin endpoint.
    dev_auth_role: str = ""

    # ---- llm ----
    llm_provider: LLMProvider = "gemini"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"
    aws_region: str = "ap-south-1"
    aws_api_key_bedrock_for_xai: str = ""
    bedrock_model_id: str = ""

    # ---- feeds ----
    open_meteo_forecast_url: str = "https://api.open-meteo.com/v1/forecast"
    open_meteo_flood_url: str = "https://flood-api.open-meteo.com/v1/flood"
    open_meteo_air_url: str = "https://air-quality-api.open-meteo.com/v1/air-quality"
    osrm_url: str = "https://router.project-osrm.org"
    #: Mapbox is the preferred router: the public OSRM demo server is rate
    #: limited and refuses the Matrix sizes this needs, and Mapbox returns turn
    #: instructions with street names, which is the difference between "go 2.1 km
    #: north" and "left onto Karve Road". Same token the map already uses.
    mapbox_token: str = ""
    mapbox_directions_url: str = "https://api.mapbox.com/directions/v5/mapbox"
    mapbox_matrix_url: str = "https://api.mapbox.com/directions-matrix/v1/mapbox"
    #: Hugging Face Inference API, for the multilingual zero-shot classifier that
    #: backs the report parser when its keyword pass is not confident.
    hf_api_token: str = ""
    hf_zero_shot_model: str = "joeddav/xlm-roberta-large-xnli"
    #: Google Flood Hub, if a key is present. Without one the flood forecast
    #: comes from GloFAS through Open-Meteo, which needs no key.
    google_flood_hub_key: str = ""
    google_flood_hub_url: str = "https://floodforecasting.googleapis.com/v1"
    nasa_firms_key: str = ""
    data_gov_in_key: str = ""
    feed_timeout_seconds: float = 12.0
    feed_cache_ttl_seconds: int = 900

    @field_validator("dev_auth_role")
    @classmethod
    def _dev_role_is_development_only(cls, v: str, info) -> str:
        v = (v or "").strip()
        if not v:
            return ""
        env = (info.data or {}).get("indradhanu_env", "development")
        if env != "development":
            raise ValueError(
                "DEV_AUTH_ROLE is set but INDRADHANU_ENV is "
                f"{env!r}. This bypasses authentication entirely and is refused "
                "outside development. Unset it."
            )
        allowed = {"citizen", "field_operator", "ward_officer", "commissioner", "admin"}
        if v not in allowed:
            raise ValueError(
                f"DEV_AUTH_ROLE must be one of {sorted(allowed)}; got {v!r}."
            )
        return v

    @field_validator("cors_origins")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.indradhanu_env == "production"

    @property
    def dsn(self) -> str:
        """Pooled connection for the API. Falls back to the direct string so a
        developer with only one of the two configured still boots."""
        return self.supabase_transaction_pooler or self.supabase_direct_connection_string

    @property
    def migration_dsn(self) -> str:
        """Direct connection: pgbouncer in transaction mode cannot run DDL or
        hold advisory locks."""
        return self.supabase_direct_connection_string or self.supabase_transaction_pooler


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
