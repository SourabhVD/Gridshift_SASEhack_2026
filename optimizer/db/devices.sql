-- GridShift Component 3 — device and plan tables.
--
-- These tables do NOT exist in data/scripts/db/schema.sql. The optimizer needs
-- battery SOC, EV charging requirements and HVAC flexibility, and there is no
-- other source for them, so they are proposed here for the data owner to fold
-- into the canonical schema.
--
-- Apply:  psql "$DATABASE_URL" -f optimizer/db/devices.sql
-- Seed:   python -m optimizer.seed_devices --building-id <uuid>
--
-- Device values are SYNTHETIC scenario assumptions (the original project brief
-- calls for synthetic battery/EV/HVAC/occupancy constraints). `source` records
-- that. They are not measurements from a real building.

CREATE TABLE IF NOT EXISTS public.battery_assets (
    asset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    capacity_kwh DOUBLE PRECISION NOT NULL CHECK (capacity_kwh > 0),
    max_charge_kw DOUBLE PRECISION NOT NULL CHECK (max_charge_kw > 0),
    max_discharge_kw DOUBLE PRECISION NOT NULL CHECK (max_discharge_kw > 0),
    charge_efficiency DOUBLE PRECISION NOT NULL DEFAULT 0.95
        CHECK (charge_efficiency > 0 AND charge_efficiency <= 1),
    discharge_efficiency DOUBLE PRECISION NOT NULL DEFAULT 0.95
        CHECK (discharge_efficiency > 0 AND discharge_efficiency <= 1),
    min_soc_pct DOUBLE PRECISION NOT NULL DEFAULT 10 CHECK (min_soc_pct BETWEEN 0 AND 100),
    max_soc_pct DOUBLE PRECISION NOT NULL DEFAULT 100 CHECK (max_soc_pct BETWEEN 0 AND 100),
    current_soc_pct DOUBLE PRECISION NOT NULL CHECK (current_soc_pct BETWEEN 0 AND 100),
    target_final_soc_pct DOUBLE PRECISION NOT NULL DEFAULT 50
        CHECK (target_final_soc_pct BETWEEN 0 AND 100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (min_soc_pct <= max_soc_pct)
);

CREATE TABLE IF NOT EXISTS public.ev_charging_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    vehicle_name TEXT NOT NULL CHECK (btrim(vehicle_name) <> ''),
    max_charge_kw DOUBLE PRECISION NOT NULL CHECK (max_charge_kw > 0),
    energy_required_kwh DOUBLE PRECISION NOT NULL CHECK (energy_required_kwh >= 0),
    available_from TIMESTAMPTZ NOT NULL,
    available_until TIMESTAMPTZ NOT NULL,
    charge_efficiency DOUBLE PRECISION NOT NULL DEFAULT 0.92
        CHECK (charge_efficiency > 0 AND charge_efficiency <= 1),
    -- Higher priority raises the penalty for leaving this session unmet.
    priority DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (priority >= 0),
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (available_until > available_from)
);

CREATE TABLE IF NOT EXISTS public.hvac_flexibility (
    asset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    -- Share of predicted whole-building load HVAC may shed in one hour.
    max_curtail_fraction DOUBLE PRECISION NOT NULL DEFAULT 0.15
        CHECK (max_curtail_fraction BETWEEN 0 AND 1),
    max_curtail_kw DOUBLE PRECISION CHECK (max_curtail_kw > 0),
    max_consecutive_hours INTEGER NOT NULL DEFAULT 3 CHECK (max_consecutive_hours >= 0),
    -- Fraction of shed energy that must be recovered later (thermal rebound).
    recovery_fraction DOUBLE PRECISION NOT NULL DEFAULT 0.5
        CHECK (recovery_fraction BETWEEN 0 AND 1),
    daily_curtail_limit_kwh DOUBLE PRECISION CHECK (daily_curtail_limit_kwh >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.optimization_plans (
    building_id UUID NOT NULL REFERENCES public.buildings(building_id),
    generated_at TIMESTAMPTZ NOT NULL,
    plan_timestamp TIMESTAMPTZ NOT NULL,
    forecast_load_kw DOUBLE PRECISION NOT NULL,
    baseline_load_kw DOUBLE PRECISION NOT NULL,
    optimized_load_kw DOUBLE PRECISION NOT NULL,
    battery_charge_kw DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_discharge_kw DOUBLE PRECISION NOT NULL DEFAULT 0,
    battery_soc_pct DOUBLE PRECISION,
    ev_charge_kw DOUBLE PRECISION NOT NULL DEFAULT 0,
    hvac_curtail_kw DOUBLE PRECISION NOT NULL DEFAULT 0,
    hvac_rebound_kw DOUBLE PRECISION NOT NULL DEFAULT 0,
    energy_rate_per_kwh DOUBLE PRECISION,
    tariff_period TEXT,
    approved_at TIMESTAMPTZ,
    PRIMARY KEY (building_id, generated_at, plan_timestamp)
);

CREATE INDEX IF NOT EXISTS ix_ev_sessions_window
    ON public.ev_charging_sessions (building_id, available_from, available_until);
CREATE INDEX IF NOT EXISTS ix_optimization_plans_latest
    ON public.optimization_plans (building_id, generated_at DESC, plan_timestamp);

-- schema.sql carries no GRANT statements, so whatever role/mechanism gave
-- gridshift_backend access to buildings/tariff_rates/etc. happened outside
-- version control (Supabase dashboard). Mirror it explicitly here so the app
-- role can use these new tables immediately after a more privileged role
-- (e.g. postgres, via the Supabase SQL Editor) creates them.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.battery_assets,
    public.ev_charging_sessions,
    public.hvac_flexibility,
    public.optimization_plans
TO gridshift_backend;
