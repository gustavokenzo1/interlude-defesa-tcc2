"""Compara a entrada atual e registra o recorte didático, sem consultar APIs.

Executar com aplicativo/solver/.venv/bin/python. Prazo de cinco segundos por
metaheurística, uma execução por configuração; não substitui o estudo do TCC.
"""
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / 'slides/html/data'
sys.path.insert(0, str(ROOT / 'aplicativo/solver'))
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
import ortools

spec = importlib.util.spec_from_file_location('experiment', ROOT / 'tcc/fontes/qualidade-solver/rodar_experimento.py')
experiment = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = experiment
spec.loader.exec_module(experiment)
payload = json.loads((DATA / 'solver-request.json').read_text())
FS, LS = routing_enums_pb2.FirstSolutionStrategy, routing_enums_pb2.LocalSearchMetaheuristic
configs = [
    experiment.Config('PATH_CHEAPEST_ARC', FS.PATH_CHEAPEST_ARC, None, 5),
    experiment.Config('PARALLEL_CHEAPEST_INSERTION', FS.PARALLEL_CHEAPEST_INSERTION, None, 5),
    *[experiment.Config(name, FS.PARALLEL_CHEAPEST_INSERTION, getattr(LS, name), 5)
      for name in ['GREEDY_DESCENT', 'GUIDED_LOCAL_SEARCH', 'SIMULATED_ANNEALING', 'TABU_SEARCH']],
]
comparison = {
    'recorded_on': '2026-10-20', 'ortools': ortools.__version__,
    'request_sha256': hashlib.sha256((DATA / 'solver-request.json').read_bytes()).hexdigest(),
    'description': 'Nova execução para os slides; uma repetição por estratégia, mesma entrada atual de três dias, até cinco segundos.',
    'results': [experiment.run(payload, c) for c in configs],
}
(DATA / 'comparacao-atual.json').write_text(json.dumps(comparison, ensure_ascii=False, indent=2))

names = ['Hotel', 'Empire State', 'Bryant Park', 'The MET', 'Central Park']
indices = [0, 37, 39, 31, 29]
matrix = [[payload['time_matrix'][a][b] for b in indices] for a in indices]
cost = lambda route: sum(matrix[a][b] for a, b in zip(route, route[1:]))
route, construction = [0, 0], []
for _ in range(4):
    delta, node, pos = min((matrix[a][n] + matrix[n][b] - matrix[a][b], n, k + 1)
        for n in range(1, 5) if n not in route
        for k, (a, b) in enumerate(zip(route, route[1:])))
    slots = [{'delta': matrix[a][node] + matrix[node][b] - matrix[a][b],
              'position': k + 1, 'route': route[:k+1] + [node] + route[k+1:]}
             for k, (a, b) in enumerate(zip(route, route[1:]))]
    route.insert(pos, node)
    construction.append({'insert': node, 'route': route.copy(), 'cost': cost(route), 'delta': delta, 'choices': sorted(slots, key=lambda s: s['delta'])})
manager = pywrapcp.RoutingIndexManager(5, 1, 0)
routing = pywrapcp.RoutingModel(manager)
cb = routing.RegisterTransitCallback(lambda a,b: matrix[manager.IndexToNode(a)][manager.IndexToNode(b)])
routing.SetArcCostEvaluatorOfAllVehicles(cb)
search = []
def record():
    idx, route = routing.Start(0), []
    while not routing.IsEnd(idx):
        route.append(manager.IndexToNode(idx)); idx = routing.NextVar(idx).Value()
    route.append(0)
    if len(search) < 12:
        c = cost(route)
        search.append({'route': route, 'cost': c, 'best': min([c] + [s['cost'] for s in search])})
routing.AddAtSolutionCallback(record)
params = pywrapcp.DefaultRoutingSearchParameters()
params.first_solution_strategy = FS.PARALLEL_CHEAPEST_INSERTION
params.local_search_metaheuristic = LS.GUIDED_LOCAL_SEARCH
params.time_limit.FromMilliseconds(200)
routing.SolveWithParameters(params)
assert search[0]['route'] == construction[-1]['route'], (search[0], construction[-1])
assert search[1]['cost'] < search[0]['cost'] and search[2]['cost'] > search[1]['cost'], search[:3]
demo = {'names': names, 'matrix': matrix, 'construction': construction, 'search': search,
        'provenance': {'date': '2026-10-20', 'ortools': ortools.__version__,
        'source': 'Recorte da matriz atual de três dias; índices ' + str(indices),
        'model': 'Uma rota, quatro visitas obrigatórias, somente deslocamento; sem janelas, durações, exclusões ou preferências.',
        'firstSolution': 'PARALLEL_CHEAPEST_INSERTION', 'localSearch': 'GUIDED_LOCAL_SEARCH', 'timeLimitMs': 200,
        'construction': 'Reconstrução didática dos encaixes mínimos, primeira rota conferida contra o OR-Tools.',
        'search': 'Soluções aceitas de AddAtSolutionCallback; a animação usa as três primeiras.'}}
(ROOT / 'slides/motion/search-demo.js').write_text('// Execução reduzida e reconstrução dos encaixes; proveniência no objeto.\nwindow.INTERLUDE_SEARCH_DEMO = ' + json.dumps(demo, ensure_ascii=False, indent=2) + ';\n')
print(json.dumps({'comparison': [(r['metodo'], r['execucoes'][0].get('objetivo'), r['execucoes'][0].get('atracoes_visitadas')) for r in comparison['results']], 'demo': search[:3]}))
