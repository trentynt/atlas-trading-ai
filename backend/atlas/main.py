"""ATLAS API entry point:  uvicorn atlas.main:app --port 8000   (from the backend/ directory)."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.intraday import router as intraday_router
from .api.routes import router
from .config import Settings, get_settings
from .services import Services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("atlas")


def create_app(settings: Settings | None = None, providers: dict | None = None, start_background: bool = True) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        sv = Services.build(settings, providers)
        sv.bus.bind_loop(asyncio.get_running_loop())
        app.state.services = sv
        from .futures.experiments import ensure_seed
        ensure_seed(sv.db)  # ORB-1, registered but never run automatically
        sv.bus.emit("system", "ATLAS backend started (PAPER ONLY — no live broker connectivity)", source="system", data={"node": "scheduler"})
        if start_background:
            sv.scheduler.start()
            # Always bring datasets up to date on start (incremental: only the last week is re-fetched).
            sv.submit_data_refresh({"paper_tick": True})
        yield
        sv.shutdown()

    app = FastAPI(title="ATLAS Quantitative Research API", version="0.1.0", lifespan=lifespan,
                  description="Research, backtesting and PAPER trading. No live order routing exists in this build.")
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("Unhandled error on %s", request.url.path)
        return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})

    app.include_router(router)
    app.include_router(intraday_router)
    return app


app = create_app()
