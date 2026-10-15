# Resultados do experimento de qualidade do solver

Registro de 22/09/2026, 19:22; apresentação revisada em 23/09/2026 · OR-Tools 9.10.4067 · Python 3.12.13 · Darwin arm64

O objetivo é o custo interno do modelo (segundos de deslocamento, custos suaves e penalidades de exclusão). O desvio relativo usa o menor objetivo observado no próprio cenário como referência. Essa referência não é um ótimo comprovado. Os cenários reduzidos são derivações controladas da entrada registrada.

## Nova Iorque, 5 dias (instância registrada)

12 atrações, cinco dias e 52 nós, conforme a entrada preservada da execução integrada. O rótulo de produção identifica apenas o orçamento adaptativo dessa entrada.

| Método | Limite | Objetivo | Desvio relativo | Atrações | Deslocamento | Busca |
|---|---:|---:|---:|---:|---:|---:|
| Arco mais barato, primeira solução | até parar | 96.495.574 | 62.481,4% | 10/12 | 210 min | 0,00 s |
| Inserção paralela, primeira solução | até parar | 41.494.118 | 26.810,7% | 12/12 | 371 min | 0,00 s |
| Inserção + descida gulosa | até parar | 155.336 | 0,7% | 12/12 | 355 min | 0,11 s |
| Inserção + GLS | 2 s | 154.192 | 0,0% | 12/12 | 345 min | 2,00 s / 2,00 s / 2,00 s |
| Inserção + GLS (produção) | 5 s | 154.192 | 0,0% | 12/12 | 345 min | 5,00 s / 5,00 s / 5,00 s |
| Inserção + GLS | 15 s | 154.192 | 0,0% | 12/12 | 345 min | 15,00 s / 15,00 s / 15,00 s |
| Inserção + GLS | 60 s | 154.192 | 0,0% | 12/12 | 345 min | 60,00 s |
| Inserção + simulated annealing | 60 s | 155.336 | 0,7% | 12/12 | 355 min | 60,00 s |
| Inserção + busca tabu | 60 s | 155.336 | 0,7% | 12/12 | 355 min | 60,00 s |
| Inserção + GLS | 300 s | 154.192 | 0,0% | 12/12 | 345 min | 299,99 s |
| Inserção + GLS (referência longa) | 600 s | 154.192 | 0,0% | 12/12 | 345 min | 599,98 s |

Agenda de uma execução com o menor objetivo observado:

- Dia 1: Ponte do Brooklyn, Memorial & Museu Nacional do 11 de Setembro · sem refeição · 15,7 km · 8,9 h
- Dia 2: Catedral de São Patrício, Metropolitan Museum of Art, Central Park · 1 refeição · 10,9 km · 8,0 h
- Dia 3: Estatua da Liberdade, Empire State Building · 1 refeição · 23,3 km · 8,9 h
- Dia 4: Lincoln Center, Radio City Music Hall, Times Square · 1 refeição · 6,8 km · 8,4 h
- Dia 5: Rockefeller Center, Parque Bryant · sem refeição · 5,6 km · 2,8 h

## Nova Iorque cortada para 3 dias

Derivação que preserva as doze atrações e os primeiros três dias, sem recalcular os horários logísticos. As matrizes mantêm os valores entre os pontos restantes.

| Método | Limite | Objetivo | Desvio relativo | Atrações | Deslocamento | Busca |
|---|---:|---:|---:|---:|---:|---:|
| Inserção + GLS (limite experimental) | 5 s | 964.855 | 0,0% | 12/12 | 283 min | 5,00 s |
| Inserção + GLS | 60 s | 964.855 | 0,0% | 12/12 | 283 min | 60,00 s |

Agenda de uma execução com o menor objetivo observado:

- Dia 1: Lincoln Center, Rockefeller Center, Radio City Music Hall, Times Square · sem refeição · 7,1 km · 9,0 h
- Dia 2: Central Park, Metropolitan Museum of Art, Parque Bryant, Empire State Building · sem refeição · 11,1 km · 9,1 h
- Dia 3: Catedral de São Patrício, Ponte do Brooklyn, Estatua da Liberdade, Memorial & Museu Nacional do 11 de Setembro · sem refeição · 27,3 km · 10,1 h

## Nova Iorque cortada para 2 dias

Derivação que preserva as doze atrações e os primeiros dois dias. O limite experimental de cinco segundos difere dos dois segundos que a política adaptativa atual atribuiria a esta entrada.

| Método | Limite | Objetivo | Desvio relativo | Atrações | Deslocamento | Busca |
|---|---:|---:|---:|---:|---:|---:|
| Inserção + GLS (limite experimental) | 5 s | 54.351.440 | 0,0% | 8/12 | 173 min | 5,00 s |
| Inserção + GLS | 60 s | 54.351.440 | 0,0% | 8/12 | 173 min | 60,00 s |

Agenda de uma execução com o menor objetivo observado:

- Dia 1: Ponte do Brooklyn, Memorial & Museu Nacional do 11 de Setembro, Rockefeller Center, Catedral de São Patrício · sem refeição · 20,4 km · 9,0 h
- Dia 2: Times Square, Central Park, Metropolitan Museum of Art, Empire State Building · sem refeição · 11,8 km · 9,2 h
- Fora do roteiro: Estatua da Liberdade (prioridade 9), Radio City Music Hall (prioridade 10), Lincoln Center (prioridade 11), Parque Bryant (prioridade 12)

As durações incluem serviços, deslocamentos e esperas. A saída da base no primeiro dia antecede a disponibilidade das atrações às 14h. Consulte as limitações no [README](README.md) e na Seção 5.8.2 da monografia. Os números acima vêm do JSON histórico, mantido sem alterações; a repetição de 23/09 está em [verificacao-20260923](verificacao-20260923/).
