from dataclasses import dataclass, field


@dataclass
class Settings:
    app_name: str = "GridShift API"
    cors_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:3000", "http://localhost:3001"]
    )


settings = Settings()
