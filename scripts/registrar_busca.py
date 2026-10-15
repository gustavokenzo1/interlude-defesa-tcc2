"""Registra melhorias reais para a animação dos slides, sem alterar o solver.

Execução: aplicativo/solver/.venv/bin/python slides/html/scripts/registrar_busca.py
A instrumentação observa soluções completas aceitas. Não registra a árvore de
busca, candidatos rejeitados ou os passos internos da construção inicial.
"""
from pathlib import Path
import hashlib
import inspect
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'aplicativo/solver'))
from app.infrastructure.ortools_solver import ORToolsRouteSolver, SolverOptions
from app.interfaces.http.schemas import SolveRequestPayload
from app.interfaces.http.mappers import to_request

DATA = ROOT / 'slides/html/data'
raw = (DATA / 'solver-request.json').read_bytes()
request = to_request(SolveRequestPayload.model_validate_json(raw))
frames = []

class RecordedSolver(ORToolsRouteSolver):
    def _solve_with_strategy(self, routing, strategy, time_limit_seconds):
        # A observação precisa do índice da instância, local ao método solve.
        # O adaptador original permanece sem alterações ou nova instrumentação.
        caller = inspect.currentframe().f_back
        manager = caller.f_locals['manager']
        started = time.perf_counter()
        def record():
            objective = int(routing.CostVar().Value())
            if frames and objective >= frames[-1]['objective']:
                return
            routes = []
            for day in range(request.max_days):
                index = routing.Start(day)
                nodes = []
                while not routing.IsEnd(index):
                    nodes.append(manager.IndexToNode(index))
                    index = routing.NextVar(index).Value()
                nodes.append(manager.IndexToNode(index))
                routes.append(nodes)
            frames.append({'seconds': round(time.perf_counter()-started, 4),
                           'objective': objective, 'routes': routes})
        routing.AddAtSolutionCallback(record)
        return super()._solve_with_strategy(routing, strategy, time_limit_seconds)

solver = RecordedSolver(SolverOptions(primary_time_limit_seconds=15,
                                      fallback_time_limit_seconds=30))
result = solver.solve(request)
indices = sorted(set(round(i*(len(frames)-1)/min(9,len(frames)-1)) for i in range(min(10,len(frames))))) if len(frames)>1 else [0]
output = {'description':'Melhores soluções completas observadas em uma nova execução local da instância de Nova Iorque. Não é o histórico da execução de 5,032 s citada no TCC.',
          'recorded_on':'2026-09-20','ortools_version':'9.10.4067',
          'request_sha256':hashlib.sha256(raw).hexdigest(),
          'solver_sha256':hashlib.sha256((ROOT/'aplicativo/solver/app/infrastructure/ortools_solver.py').read_bytes()).hexdigest(),
          'frame_count_before_sampling':len(frames),
          'frames':[frames[i] for i in indices],
          'all_improvements':frames,
          'nodes':[{'index':i,'name':s.name,'lat':s.coordinate.latitude,'lng':s.coordinate.longitude,'is_depot':s.is_depot,'is_meal':s.is_meal} for i,s in enumerate(request.stops)]}
(DATA/'busca-animada.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'improvements':len(frames),'displayed':len(indices),'first':frames[0]['objective'],'last':frames[-1]['objective'],'days':len(result.days)},ensure_ascii=False))
