from __future__ import annotations

import logging
import os

from fastapi import FastAPI

from .application.solve_itinerary import SolveItineraryUseCase
from .infrastructure.ortools_solver import ORToolsRouteSolver, SolverOptions
from .interfaces.http.routes import build_router


class _HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        return not (isinstance(args, tuple) and len(args) >= 3 and args[2] == "/health")


def _configure_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logging.getLogger("uvicorn.access").addFilter(_HealthCheckFilter())


def create_app() -> FastAPI:
    """Inicializa o serviço HTTP, configura os limites de busca pelas variáveis
    de ambiente e conecta as rotas ao solver.
    """
    _configure_logging()
    options = SolverOptions(
        primary_time_limit_seconds=int(os.environ.get("SOLVER_TIME_LIMIT_SECONDS", "15")),
        fallback_time_limit_seconds=int(os.environ.get("SOLVER_FALLBACK_TIME_LIMIT_SECONDS", "30")),
        small_problem_max_complexity=int(
            os.environ.get("SOLVER_SMALL_MAX_COMPLEXITY", "30")
        ),
        small_problem_time_limit_seconds=int(
            os.environ.get("SOLVER_SMALL_TIME_LIMIT_SECONDS", "2")
        ),
        medium_problem_max_complexity=int(
            os.environ.get("SOLVER_MEDIUM_MAX_COMPLEXITY", "70")
        ),
        medium_problem_time_limit_seconds=int(
            os.environ.get("SOLVER_MEDIUM_TIME_LIMIT_SECONDS", "5")
        ),
    )
    solver = ORToolsRouteSolver(options=options)
    use_case = SolveItineraryUseCase(solver=solver)
    app = FastAPI(
        title="Interlude Solver",
        description="VRPTW solver based on Google OR-Tools.",
        version="1.0.0",
    )
    app.include_router(build_router(use_case))
    return app


app = create_app()
