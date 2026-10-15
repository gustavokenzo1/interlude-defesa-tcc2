from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import List, Set

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from ..domain.entities import (
    DayPlan,
    RouteRequest,
    RouteSolution,
    RouteStep,
    UnassignedStop,
)
from ..domain.exceptions import InfeasibleRouteError
from .distance import build_distance_matrix, build_time_matrix


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SolverOptions:
    """Define os limites de busca e os pesos das preferências do roteiro."""

    primary_time_limit_seconds: int = 12
    fallback_time_limit_seconds: int = 25
    # Instâncias menores recebem menos tempo de busca; a complexidade considera
    # a quantidade de nós e de dias, pois cada dia é uma rota no modelo.
    small_problem_max_complexity: int = 30
    small_problem_time_limit_seconds: int = 2
    medium_problem_max_complexity: int = 70
    medium_problem_time_limit_seconds: int = 5
    # O custo por segundo de duração favorece dias mais curtos.
    span_cost_coefficient: int = 1
    # Ultrapassar a duração de conforto tem custo adicional, mas continua
    # permitido quando as outras restrições permitem um dia mais longo.
    comfort_span_seconds: int = 9 * 3600
    comfort_overflow_penalty_per_second: int = 40
    # A referência de início favorece a manhã: atrasar custa mais que antecipar.
    # Os valores representam segundos a partir da origem temporal da entrada.
    morning_anchor_seconds: int = 3 * 3600
    morning_anchor_late_penalty_per_second: int = 30
    morning_anchor_early_penalty_per_second: int = 2
    # Preferências fortes de horário recebem maior penalidade por atraso.
    # Os horários obrigatórios são tratados pelas janelas de disponibilidade.
    preferred_window_strong_penalty_per_second: int = 500
    preferred_window_soft_penalty_per_second: int = 20
    # Limite obrigatório de atrações por dia quando a entrada não define outro.
    max_stops_per_day: int = 8
    # O custo de exclusão favorece manter as atrações selecionadas no roteiro.
    base_disjunction_penalty: int = 5_000_000
    # A posição na lista do usuário tem maior peso que a importância turística.
    priority_position_weight: float = 4.0
    # A importância turística complementa o custo de exclusão de cada atração.
    importance_drop_multiplier: float = 0.5
    # Atividades de dia inteiro recebem um custo de exclusão elevado.
    full_day_drop_penalty: int = 2_000_000_000
    # O excesso de atrações acima da média por dia recebe uma penalidade.
    count_spread_penalty_per_stop: int = 10_000
    # Pausas automáticas têm custo de exclusão menor que atrações e locais
    # de refeição escolhidos pelo usuário.
    meal_filler_penalty: int = 100_000
    # Cada local de refeição escolhido pode ter várias alternativas de horário
    # e dia; o modelo seleciona no máximo uma delas por grupo.
    meal_candidate_penalty: int = 1_000_000_000
    # A penalidade por concentração favorece distribuir cafés e restaurantes
    # escolhidos entre os dias, sem tornar essa distribuição obrigatória.
    meal_spread_penalty_per_stop: int = 200_000


class ORToolsRouteSolver:
    """Gera roteiros diários com janelas de tempo usando o OR-Tools.

    Cada veículo representa um dia, com seus locais de início e fim. O modelo
    respeita a disponibilidade das paradas e combina custos de deslocamento,
    duração, distribuição de visitas e exclusão de atrações e refeições.
    """

    def __init__(self, options: SolverOptions | None = None) -> None:
        self._options = options or SolverOptions()

    def solve(self, request: RouteRequest) -> RouteSolution:
        """Monta as restrições e os custos, busca uma solução e organiza os dias.

        Usa as matrizes recebidas ou estimativas locais de distância e tempo.
        Se a busca inicial não encontrar uma solução e ainda houver tempo,
        tenta uma estratégia alternativa antes de informar a falha.
        """
        request_started = time.perf_counter()
        size = len(request.stops)
        distance_matrix = request.distance_matrix or build_distance_matrix(request.stops)
        time_matrix = request.time_matrix or build_time_matrix(distance_matrix)
        service_times = [stop.service_time_seconds for stop in request.stops]
        depot_index = next(i for i, stop in enumerate(request.stops) if stop.id == request.depot_id)
        stop_index_by_id = {stop.id: index for index, stop in enumerate(request.stops)}
        start_indices = self._vehicle_indices(
            request.vehicle_start_ids,
            stop_index_by_id,
            depot_index,
            request.max_days,
        )
        end_indices = self._vehicle_indices(
            request.vehicle_end_ids,
            stop_index_by_id,
            depot_index,
            request.max_days,
        )
        logger.info(
            "solve start: stops=%d max_days=%d horizon=%ds min/max_stops=%d/%d",
            size,
            request.max_days,
            request.horizon_seconds,
            request.min_stops_per_day,
            request.max_stops_per_day,
        )

        manager = pywrapcp.RoutingIndexManager(
            size,
            request.max_days,
            start_indices,
            end_indices,
        )
        routing = pywrapcp.RoutingModel(manager)

        # A agenda soma visita e deslocamento; o custo dos arcos considera
        # apenas o deslocamento, inclusive nos trechos com refeições.
        def transit_with_service(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return service_times[from_node] + time_matrix[from_node][to_node]

        def travel_only(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return time_matrix[from_node][to_node]

        time_callback_index = routing.RegisterTransitCallback(transit_with_service)
        cost_callback_index = routing.RegisterTransitCallback(travel_only)
        routing.SetArcCostEvaluatorOfAllVehicles(cost_callback_index)

        routing.AddDimension(
            time_callback_index,
            request.horizon_seconds,
            request.horizon_seconds,
            False,
            "Time",
        )
        time_dimension = routing.GetDimensionOrDie("Time")

        route_endpoint_indices = set(start_indices + end_indices)
        cp_solver = routing.solver()
        # A disponibilidade limita os horários e os dias em que cada parada
        # pode ser visitada; preferências de horário acrescentam custos.
        for node, stop in enumerate(request.stops):
            if node in route_endpoint_indices:
                continue
            index = manager.NodeToIndex(node)
            time_var = time_dimension.CumulVar(index)
            if stop.day_time_windows:
                broad_start = min(window.start_seconds for window in stop.day_time_windows)
                broad_end = max(window.end_seconds for window in stop.day_time_windows)
                time_var.SetRange(broad_start, broad_end)
                vehicle_var = routing.VehicleVar(index)
                for window in stop.day_time_windows:
                    assigned_to_day = cp_solver.IsEqualCstVar(vehicle_var, window.day_index)
                    starts_after_open = cp_solver.IsGreaterOrEqualCstVar(
                        time_var,
                        window.start_seconds,
                    )
                    starts_before_close = cp_solver.IsLessOrEqualCstVar(
                        time_var,
                        window.end_seconds,
                    )
                    cp_solver.Add(assigned_to_day <= starts_after_open)
                    cp_solver.Add(assigned_to_day <= starts_before_close)
            else:
                time_var.SetRange(
                    stop.time_window.start_seconds,
                    stop.time_window.end_seconds,
                )

            allowed_days = stop.allowed_days
            if stop.fixed_day is not None:
                # Fixar o dia não permite visitar uma atração indisponível.
                allowed_days = (
                    [stop.fixed_day]
                    if allowed_days is None or stop.fixed_day in allowed_days
                    else []
                )
            if allowed_days is not None:
                valid_days = sorted({
                    day for day in allowed_days if 0 <= day < request.max_days
                })
                if valid_days:
                    routing.SetAllowedVehiclesForIndex(valid_days, index)
                else:
                    # Uma lista vazia não restringe veículos no OR-Tools;
                    # sem dias disponíveis, a parada precisa ser desativada.
                    cp_solver.Add(routing.ActiveVar(index) == 0)

            preferred = stop.preferred_time_window
            if preferred is not None:
                coefficient = (
                    self._options.preferred_window_strong_penalty_per_second
                    if stop.preferred_time_window_strength == "strong"
                    else self._options.preferred_window_soft_penalty_per_second
                )
                # Penaliza apenas o atraso em relação à preferência, evitando
                # cobrar uma antecipação de atrações que ficaram fora da rota.
                time_dimension.SetCumulVarSoftUpperBound(
                    index,
                    preferred.end_seconds,
                    coefficient,
                )

        # Os extremos definem a disponibilidade de cada dia. As preferências
        # de início e duração acrescentam custos, sem proibir desvios.
        for vehicle_id in range(request.max_days):
            start = routing.Start(vehicle_id)
            end = routing.End(vehicle_id)
            start_stop = request.stops[start_indices[vehicle_id]]
            end_stop = request.stops[end_indices[vehicle_id]]
            time_dimension.CumulVar(start).SetRange(
                start_stop.time_window.start_seconds,
                start_stop.time_window.end_seconds,
            )
            time_dimension.CumulVar(end).SetRange(
                end_stop.time_window.start_seconds,
                end_stop.time_window.end_seconds,
            )
            anchor = min(self._options.morning_anchor_seconds, start_stop.time_window.end_seconds)
            time_dimension.SetCumulVarSoftLowerBound(
                start,
                anchor,
                self._options.morning_anchor_early_penalty_per_second,
            )
            time_dimension.SetCumulVarSoftUpperBound(
                start,
                anchor,
                self._options.morning_anchor_late_penalty_per_second,
            )
            time_dimension.SetSpanCostCoefficientForVehicle(
                self._options.span_cost_coefficient,
                vehicle_id,
            )
            time_dimension.SetSoftSpanUpperBoundForVehicle(
                pywrapcp.BoundCost(
                    self._options.comfort_span_seconds,
                    self._options.comfort_overflow_penalty_per_second,
                ),
                vehicle_id,
            )

        meal_indices = [
            i for i, stop in enumerate(request.stops)
            if stop.is_meal and i not in route_endpoint_indices
        ]
        self._add_meal_dimensions(
            routing=routing,
            manager=manager,
            request=request,
            route_endpoint_indices=route_endpoint_indices,
        )

        non_depot_indices = [
            i
            for i, stop in enumerate(request.stops)
            if i not in route_endpoint_indices and not stop.is_depot and not stop.is_meal
        ]

        self._add_count_dimension(
            routing=routing,
            manager=manager,
            request=request,
            route_endpoint_indices=route_endpoint_indices,
            meal_indices=meal_indices,
        )

        stop_id_to_node = {stop.id: i for i, stop in enumerate(request.stops)}
        grouped_meal_nodes: Set[int] = set()
        # Cada grupo representa alternativas de uma mesma refeição. Excluir
        # o grupo custa menos para pausas automáticas que para locais escolhidos.
        for group, penalty in [
            *[(g, self._options.meal_candidate_penalty) for g in request.meal_candidate_groups],
            *[(g, self._options.meal_filler_penalty) for g in request.meal_filler_groups],
        ]:
            alt_nodes = [stop_id_to_node[sid] for sid in group if sid in stop_id_to_node]
            if not alt_nodes:
                continue
            grouped_meal_nodes.update(alt_nodes)
            routing.AddDisjunction(
                [manager.NodeToIndex(node) for node in alt_nodes],
                penalty,
                1,
            )

        for node in meal_indices:
            if node in grouped_meal_nodes:
                continue
            routing.AddDisjunction(
                [manager.NodeToIndex(node)],
                self._options.meal_filler_penalty,
            )

        priority_count = len(non_depot_indices)
        sorted_by_priority = sorted(non_depot_indices, key=lambda n: request.stops[n].priority)
        # As atrações são opcionais, mas sua exclusão tem custo conforme a
        # prioridade, a importância turística e a adequação sazonal.
        for order, node in enumerate(sorted_by_priority):
            stop = request.stops[node]
            if stop.full_day:
                penalty = self._options.full_day_drop_penalty
            else:
                rank_fraction = (priority_count - order) / priority_count
                importance = max(0.0, min(1.0, stop.importance))
                suitability = max(0.0, min(1.0, stop.seasonal_suitability))
                seasonal_factor = 0.5 + 0.5 * suitability
                penalty = int(
                    self._options.base_disjunction_penalty
                    * (1 + self._options.priority_position_weight * rank_fraction)
                    * (1 + importance * self._options.importance_drop_multiplier)
                    * seasonal_factor
                )
            routing.AddDisjunction([manager.NodeToIndex(node)], penalty)

        primary_time_limit = self._effective_primary_time_limit_seconds(
            stop_count=size,
            vehicle_count=request.max_days,
        )
        def remaining_budget() -> float:
            if request.max_compute_seconds is None:
                return self._options.primary_time_limit_seconds + self._options.fallback_time_limit_seconds
            return max(0.0, request.max_compute_seconds - (time.perf_counter() - request_started))

        budget = remaining_budget()
        if budget < 0.01:
            raise InfeasibleRouteError("solver computation deadline exceeded")
        primary_time_limit = min(primary_time_limit, budget)
        logger.info(
            "solve search: complexity=%d primary_limit=%ds configured_limit=%ds",
            size + 2 * request.max_days,
            primary_time_limit,
            self._options.primary_time_limit_seconds,
        )
        started_at = time.perf_counter()
        solution = self._solve_with_strategy(
            routing,
            routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION,
            primary_time_limit,
        )
        if solution is None and remaining_budget() >= 0.01:
            fallback_limit = min(self._options.fallback_time_limit_seconds, remaining_budget())
            logger.warning(
                "primary search found no solution; retrying for %ds with AUTOMATIC",
                fallback_limit,
            )
            solution = self._solve_with_strategy(
                routing,
                routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC,
                fallback_limit,
            )
        if solution is None:
            raise InfeasibleRouteError("solver was unable to find a feasible route")
        logger.info(
            "solve complete: elapsed=%.3fs objective=%d",
            time.perf_counter() - started_at,
            solution.ObjectiveValue(),
        )

        return self._build_solution(
            request=request,
            manager=manager,
            routing=routing,
            solution=solution,
            time_dimension=time_dimension,
            distance_matrix=distance_matrix,
            depot_index=depot_index,
            non_depot_indices=non_depot_indices,
            grouped_meal_nodes=grouped_meal_nodes,
        )

    def _add_count_dimension(
        self,
        *,
        routing: pywrapcp.RoutingModel,
        manager: pywrapcp.RoutingIndexManager,
        request: RouteRequest,
        route_endpoint_indices: Set[int],
        meal_indices: List[int],
    ) -> None:
        """Limita as atrações por dia e favorece sua distribuição entre as rotas.

        Não conta refeições nem extremos da rota. Cada atração conta uma vez,
        inclusive atividades de dia inteiro. O teto diário é obrigatório;
        a média e o mínimo desejado são preferências com penalidades.
        """
        countable = {
            i for i, stop in enumerate(request.stops)
            if i not in route_endpoint_indices and not stop.is_depot and not stop.is_meal
        }
        max_stops = (
            request.max_stops_per_day
            if request.max_stops_per_day > 0
            else self._options.max_stops_per_day
        )

        def stop_count(from_index: int, _to_index: int) -> int:
            return 1 if manager.IndexToNode(from_index) in countable else 0

        callback_index = routing.RegisterTransitCallback(stop_count)
        cap = max(max_stops, len(countable)) if countable else max_stops
        routing.AddDimension(callback_index, 0, cap, True, "Count")
        count_dimension = routing.GetDimensionOrDie("Count")

        balanced_max = -(-len(countable) // request.max_days) if countable else max_stops
        for vehicle_id in range(request.max_days):
            end = routing.End(vehicle_id)
            count_dimension.CumulVar(end).SetMax(max_stops)
            count_dimension.SetCumulVarSoftUpperBound(
                end,
                balanced_max,
                self._options.count_spread_penalty_per_stop,
            )

        if request.min_stops_per_day > 0:
            achievable_min = min(
                request.min_stops_per_day,
                max(0, len(countable) // request.max_days),
            )
            if achievable_min > 0:
                for vehicle_id in range(request.max_days):
                    end = routing.End(vehicle_id)
                    # O mínimo favorece preencher dias com visitas, mas o
                    # OR-Tools não cobra essa penalidade em rotas vazias.
                    count_dimension.SetCumulVarSoftLowerBound(end, achievable_min, 20_000_000)

    def _add_meal_dimensions(
        self,
        *,
        routing: pywrapcp.RoutingModel,
        manager: pywrapcp.RoutingIndexManager,
        request: RouteRequest,
        route_endpoint_indices: Set[int],
    ) -> None:
        """Limita cada tipo de refeição a uma ocorrência por dia e favorece
        distribuir cafés e restaurantes escolhidos entre dias diferentes.
        """

        for slot in ("breakfast", "lunch", "snack", "dinner"):
            slot_nodes = {
                index
                for index, stop in enumerate(request.stops)
                if index not in route_endpoint_indices
                and stop.is_meal
                and stop.meal_slot == slot
            }
            if not slot_nodes:
                continue

            def slot_count(from_index: int, _to_index: int, nodes=slot_nodes) -> int:
                return 1 if manager.IndexToNode(from_index) in nodes else 0

            callback_index = routing.RegisterTransitCallback(slot_count)
            routing.AddDimension(callback_index, 0, 1, True, f"MealSlot{slot.title()}")

        # A distribuição por categoria é uma preferência; reservas e outras
        # restrições podem concentrar os locais mediante uma penalidade.
        for category in ("coffee", "restaurant"):
            category_nodes = {
                index
                for index, stop in enumerate(request.stops)
                if index not in route_endpoint_indices
                and stop.is_meal
                and stop.meal_category == category
                and stop.meal_candidate_id is not None
            }
            candidate_ids = {
                request.stops[index].meal_candidate_id
                for index in category_nodes
                if request.stops[index].meal_candidate_id is not None
            }
            if len(candidate_ids) <= 1 or request.max_days <= 1:
                continue

            def category_count(from_index: int, _to_index: int, nodes=category_nodes) -> int:
                return 1 if manager.IndexToNode(from_index) in nodes else 0

            callback_index = routing.RegisterTransitCallback(category_count)
            capacity = len(candidate_ids)
            routing.AddDimension(
                callback_index,
                0,
                capacity,
                True,
                f"MealCategory{category.title()}",
            )
            dimension = routing.GetDimensionOrDie(f"MealCategory{category.title()}")
            balanced_max = -(-len(candidate_ids) // request.max_days)
            for vehicle_id in range(request.max_days):
                dimension.SetCumulVarSoftUpperBound(
                    routing.End(vehicle_id),
                    balanced_max,
                    self._options.meal_spread_penalty_per_stop,
                )

    def _vehicle_indices(
        self,
        ids: List[str] | None,
        stop_index_by_id: dict[str, int],
        fallback_index: int,
        vehicle_count: int,
    ) -> List[int]:
        """Resolve os locais de início ou fim de cada dia, usando a base
        como alternativa quando não há um identificador correspondente.
        """
        indices: List[int] = []
        for vehicle_id in range(vehicle_count):
            stop_id = ids[vehicle_id] if ids and vehicle_id < len(ids) else None
            indices.append(stop_index_by_id.get(stop_id, fallback_index) if stop_id else fallback_index)
        return indices

    def _effective_primary_time_limit_seconds(
        self,
        *,
        stop_count: int,
        vehicle_count: int,
    ) -> int:
        """Ajusta o tempo da busca principal à quantidade de nós e dias."""
        configured = max(1, self._options.primary_time_limit_seconds)
        complexity = stop_count + 2 * vehicle_count
        if complexity <= self._options.small_problem_max_complexity:
            return min(configured, max(1, self._options.small_problem_time_limit_seconds))
        if complexity <= self._options.medium_problem_max_complexity:
            return min(configured, max(1, self._options.medium_problem_time_limit_seconds))
        return configured

    def _solve_with_strategy(
        self,
        routing: pywrapcp.RoutingModel,
        strategy: int,
        time_limit_seconds: float,
    ):
        """Cria uma solução inicial com a estratégia indicada e tenta melhorá-la
        por busca local guiada, respeitando o limite de tempo disponível.
        """
        params = pywrapcp.DefaultRoutingSearchParameters()
        params.first_solution_strategy = strategy
        params.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        )
        params.time_limit.FromMilliseconds(max(1, int(time_limit_seconds * 1000)))
        return routing.SolveWithParameters(params)

    def _build_solution(
        self,
        *,
        request: RouteRequest,
        manager: pywrapcp.RoutingIndexManager,
        routing: pywrapcp.RoutingModel,
        solution,
        time_dimension,
        distance_matrix: List[List[int]],
        depot_index: int,
        non_depot_indices: List[int],
        grouped_meal_nodes: Set[int],
    ) -> RouteSolution:
        """Converte a solução do OR-Tools em agendas diárias, com horários,
        distâncias, durações e a relação de paradas não alocadas.
        """
        visited: Set[int] = set()
        visited_meals: Set[int] = set()
        days: List[DayPlan] = []
        total_distance = 0
        total_time = 0

        for vehicle_id in range(request.max_days):
            index = routing.Start(vehicle_id)
            visited_nodes: List[int] = []
            day_distance = 0
            arrivals: List[int] = []

            while True:
                node = manager.IndexToNode(index)
                visited_nodes.append(node)
                arrivals.append(solution.Value(time_dimension.CumulVar(index)))
                if routing.IsEnd(index):
                    break
                next_index = solution.Value(routing.NextVar(index))
                next_node = manager.IndexToNode(next_index)
                day_distance += distance_matrix[node][next_node]
                index = next_index

            real_visits = [
                n for n in visited_nodes[1:-1]
                if n != depot_index and not request.stops[n].is_meal
            ]
            endpoint_only_route = len(visited_nodes) >= 2 and visited_nodes[0] != visited_nodes[-1]
            if not real_visits and not endpoint_only_route:
                days.append(
                    DayPlan(
                        day_index=vehicle_id,
                        distance_meters=0,
                        total_time_seconds=0,
                        steps=[],
                    )
                )
                continue

            steps: List[RouteStep] = []
            for order, node in enumerate(visited_nodes):
                stop = request.stops[node]
                arrival = arrivals[order]
                departure = arrival + stop.service_time_seconds
                if node != depot_index and not stop.is_meal:
                    visited.add(node)
                elif stop.is_meal:
                    visited_meals.add(node)
                steps.append(
                    RouteStep(
                        stop_id=stop.id,
                        name=stop.name,
                        coordinate=stop.coordinate,
                        order=order,
                        arrival_seconds=arrival,
                        departure_seconds=departure,
                        is_depot=stop.is_depot or node == depot_index,
                        is_meal=stop.is_meal,
                    )
                )

            day_start = steps[0].arrival_seconds if steps else 0
            day_end = steps[-1].arrival_seconds if steps else 0
            day_time = max(0, day_end - day_start)
            total_distance += day_distance
            total_time += day_time
            days.append(
                DayPlan(
                    day_index=vehicle_id,
                    distance_meters=day_distance,
                    total_time_seconds=day_time,
                    steps=steps,
                )
            )

        unassigned: List[UnassignedStop] = []
        for node in non_depot_indices:
            if node in visited:
                continue
            stop = request.stops[node]
            unassigned.append(
                UnassignedStop(
                    stop_id=stop.id,
                    name=stop.name,
                    coordinate=stop.coordinate,
                    priority=stop.priority,
                )
            )

        # Cada grupo de refeição sem alternativa visitada aparece uma vez
        # entre as paradas não alocadas.
        for group in [*request.meal_candidate_groups, *request.meal_filler_groups]:
            alt_nodes = [
                idx for idx, stop in enumerate(request.stops) if stop.id in set(group)
            ]
            if not alt_nodes:
                continue
            if any(node in visited_meals for node in alt_nodes):
                continue
            first_node = alt_nodes[0]
            stop = request.stops[first_node]
            unassigned.append(
                UnassignedStop(
                    stop_id=stop.id,
                    name=stop.name,
                    coordinate=stop.coordinate,
                    priority=stop.priority,
                )
            )

        return RouteSolution(
            total_distance_meters=total_distance,
            total_time_seconds=total_time,
            days=days,
            unassigned=unassigned,
        )
