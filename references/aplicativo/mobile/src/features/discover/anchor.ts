import type { Coordinate, TripLeg, Viewport } from '@/domain/types';

// A descoberta ancora na hospedagem (o "depósito" do roteiro no solver), e não
// no pin do destino: ao escolher uma entidade ampla (país, estado), o centroide
// do destino cai a centenas de quilômetros de onde o viajante dorme, e a busca
// retorna pontos sem relação com a base. O viewport do destino é mantido como
// semente do raio inicial nos dois casos — o centro vem da base, o tamanho vem
// da abrangência do destino. Sem hospedagem cadastrada, o destino é o melhor
// palpite disponível para o centro.
export interface DiscoveryAnchorPoint {
  coordinate: Coordinate;
  viewport?: Viewport;
}

export function discoveryAnchor(leg: TripLeg): DiscoveryAnchorPoint {
  const firstLodging = [...leg.lodgings].sort((a, b) =>
    a.checkInDate.localeCompare(b.checkInDate),
  )[0];
  return {
    coordinate: firstLodging?.coordinate ?? leg.destination.coordinate,
    viewport: leg.destination.viewport,
  };
}
