from pydantic import BaseModel, Field


class Building(BaseModel):
    id: str
    name: str
    city: str = "Seattle"
    country: str = "US"


class BuildingsResponse(BaseModel):
    buildings: list[Building]


class ForecastPoint(BaseModel):
    timestamp: str
    load_kw: float
    solar_kw: float = 0.0
    battery_kw: float = 0.0
    grid_kw: float = 0.0


class ForecastResponse(BaseModel):
    building_id: str
    forecast: list[ForecastPoint]
    peak_kw: float
    peak_time: str


class DashboardSummary(BaseModel):
    building_id: str
    total_kwh: float = Field(..., ge=0)
    peak_kw: float = Field(..., ge=0)
    emissions_kg: float = Field(..., ge=0)
