from fastapi import APIRouter, HTTPException, Query, status

from ..models.schemas import Building, BuildingsResponse, DashboardSummary, ForecastResponse
from ..services.forecast import UnknownBuilding, build_forecast, build_summary, require_fixture

router = APIRouter(prefix="/api", tags=["gridshift"])


@router.get("/buildings", response_model=BuildingsResponse)
def get_buildings() -> BuildingsResponse:
    buildings = [
        Building(**fixture)
        for fixture in [
            {"id": "sea-office-001", "name": "Sea Office", "city": "Seattle", "country": "US"},
            {"id": "harbor-warehouse-002", "name": "Harbor Warehouse", "city": "Seattle", "country": "US"},
        ]
    ]
    return BuildingsResponse(buildings=buildings)


@router.get("/dashboard/summary", response_model=DashboardSummary)
def get_summary(building_id: str = Query(...)) -> DashboardSummary:
    try:
        data = build_summary(building_id)
        return DashboardSummary(**data)
    except UnknownBuilding as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/forecast", response_model=ForecastResponse)
def get_forecast(building_id: str = Query(...)) -> ForecastResponse:
    try:
        data = build_forecast(building_id)
        return ForecastResponse(**data)
    except UnknownBuilding as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/demo/building/{building_id}")
def get_demo_building(building_id: str):
    try:
        return require_fixture(building_id)
    except UnknownBuilding as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
