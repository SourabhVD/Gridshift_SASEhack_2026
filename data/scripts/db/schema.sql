-- PostgreSQL 16+ (gen_random_uuid is built in; no extension privileges needed).
-- Safe to rerun on the same schema. Future changes require explicit migrations:
-- IF NOT EXISTS does not upgrade a pre-existing table definition.

CREATE TABLE IF NOT EXISTS public.buildings (
    building_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    building_type TEXT,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles' CHECK (btrim(timezone) <> ''),
    utility TEXT,
    rate_class TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.energy_readings (
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    timestamp TIMESTAMPTZ NOT NULL,
    load_kw DOUBLE PRECISION NOT NULL CHECK (load_kw >= 0 AND load_kw < 'Infinity'::float8),
    energy_kwh DOUBLE PRECISION CHECK (energy_kwh >= 0 AND energy_kwh < 'Infinity'::float8),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    quality_flag TEXT NOT NULL DEFAULT 'valid'
        CHECK (quality_flag IN ('valid', 'estimated', 'suspect', 'invalid')),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (building_id, timestamp)
);

CREATE TABLE IF NOT EXISTS public.weather_observations (
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    timestamp TIMESTAMPTZ NOT NULL,
    temperature_c DOUBLE PRECISION NOT NULL
        CHECK (temperature_c >= -273.15 AND temperature_c < 'Infinity'::float8),
    humidity_pct DOUBLE PRECISION NOT NULL CHECK (humidity_pct BETWEEN 0 AND 100),
    wind_speed_mps DOUBLE PRECISION NOT NULL
        CHECK (wind_speed_mps >= 0 AND wind_speed_mps < 'Infinity'::float8),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (building_id, timestamp)
);

CREATE TABLE IF NOT EXISTS public.weather_forecasts (
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    forecast_generated_at TIMESTAMPTZ NOT NULL,
    forecast_timestamp TIMESTAMPTZ NOT NULL,
    temperature_c DOUBLE PRECISION NOT NULL
        CHECK (temperature_c >= -273.15 AND temperature_c < 'Infinity'::float8),
    humidity_pct DOUBLE PRECISION CHECK (humidity_pct BETWEEN 0 AND 100),
    wind_speed_mps DOUBLE PRECISION
        CHECK (wind_speed_mps >= 0 AND wind_speed_mps < 'Infinity'::float8),
    source TEXT NOT NULL DEFAULT 'NWS' CHECK (btrim(source) <> ''),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (building_id, forecast_generated_at, forecast_timestamp)
);

CREATE TABLE IF NOT EXISTS public.tariff_rates (
    tariff_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id UUID REFERENCES public.buildings(building_id),
    rate_name TEXT NOT NULL CHECK (btrim(rate_name) <> ''),
    period_type TEXT NOT NULL CHECK (btrim(period_type) <> ''),
    energy_rate_per_kwh NUMERIC(10,5)
        CHECK (energy_rate_per_kwh >= 0 AND energy_rate_per_kwh < 'Infinity'::numeric),
    demand_rate_per_kw NUMERIC(10,5)
        CHECK (demand_rate_per_kw >= 0 AND demand_rate_per_kw < 'Infinity'::numeric),
    start_hour INTEGER NOT NULL DEFAULT 0 CHECK (start_hour BETWEEN 0 AND 23),
    end_hour INTEGER NOT NULL DEFAULT 24 CHECK (end_hour BETWEEN 1 AND 24),
    effective_from DATE NOT NULL,
    effective_to DATE,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (energy_rate_per_kwh IS NOT NULL OR demand_rate_per_kw IS NOT NULL),
    CHECK (start_hour < end_hour),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS public.model_forecasts (
    forecast_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    forecast_timestamp TIMESTAMPTZ NOT NULL,
    predicted_load_kw DOUBLE PRECISION NOT NULL
        CHECK (predicted_load_kw >= 0 AND predicted_load_kw < 'Infinity'::float8),
    peak_threshold_kw DOUBLE PRECISION
        CHECK (peak_threshold_kw >= 0 AND peak_threshold_kw < 'Infinity'::float8),
    is_peak BOOLEAN,
    model_name TEXT NOT NULL CHECK (btrim(model_name) <> ''),
    model_version TEXT NOT NULL CHECK (btrim(model_version) <> ''),
    UNIQUE (building_id, generated_at, forecast_timestamp, model_name, model_version)
);

-- Append-only source archives. Store the original response/record as JSONB;
-- timestamps below describe source data, while ingested_at records receipt time.
CREATE TABLE IF NOT EXISTS public.raw_building_load (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    observed_at TIMESTAMPTZ,
    payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.raw_weather_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    observed_at TIMESTAMPTZ,
    payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.raw_weather_forecast (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    forecast_generated_at TIMESTAMPTZ,
    payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.raw_tariffs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id UUID REFERENCES public.buildings(building_id),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    effective_from DATE,
    payload JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_weather_forecasts_target
    ON public.weather_forecasts (building_id, forecast_timestamp, forecast_generated_at DESC);
CREATE INDEX IF NOT EXISTS ix_tariff_rates_effective
    ON public.tariff_rates (building_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS ix_model_forecasts_latest
    ON public.model_forecasts (building_id, generated_at DESC, forecast_timestamp);
CREATE INDEX IF NOT EXISTS ix_raw_building_load_building
    ON public.raw_building_load (building_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS ix_raw_weather_history_building
    ON public.raw_weather_history (building_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS ix_raw_weather_forecast_building
    ON public.raw_weather_forecast (building_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS ix_raw_tariffs_building
    ON public.raw_tariffs (building_id, ingested_at DESC);
