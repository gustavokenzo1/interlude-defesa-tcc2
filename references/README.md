# Interlude — TCC2

Aplicativo móvel de planejamento de viagens que transforma preferências, pontos de interesse, horários e tempos de deslocamento em um roteiro diário viável. O núcleo técnico é um solver VRPTW implementado com Google OR-Tools.

Este repositório reúne o aplicativo, os serviços, o painel administrativo, a monografia e a apresentação editável da defesa.

## Estado atual

Estado funcional registrado em **13/09/2026**; monografia revisada em **23/09/2026**. O recorte de apresentação usa o perfil de funcionalidades **TCC**, que é o padrão de todas as contas. A API automática de voos e outras funcionalidades `nice-to-have` permanecem fora desse perfil.

O núcleo do TCC2 está implementado e publicado:

- criação de viagens com destino, datas ou quantidade de dias, ritmo, modal, interesses, POIs, hospedagem e refeições opcionais;
- edição posterior de datas com nova geração; ajuste local de paradas e replanejamento com prévia antes de aplicar;
- lista dedicada de atrações não alocadas, aviso dispensável por viagem e calendário nativo/ICS;
- geração automática do roteiro por dia;
- grafo interativo exclusivo do perfil TCC, com todos os nós do roteiro, destaque por dia, solução escolhida, vizinhos da matriz e inspeção das restrições;
- mapa unificado 2D/3D com todos os POIs do dia, avanço e retrocesso, conclusão, pulo e reordenação;
- persistência no Firestore e reabertura da viagem;
- convites por link `interlude://invite/...`, com papel de editor ou visualizador;
- despesas colaborativas e divisão entre participantes;
- compartilhamento por imagem e vídeo MP4 animado, com duração adaptada à distância, às paradas e aos dias;
- memórias de viagens concluídas e importações da galeria, com referências às fotos mantidas no aparelho;
- painel administrativo para usuários, conteúdo e perfis de funcionalidades;
- cache de matrizes no Upstash Redis por 90 dias.

### Validações realizadas

- solver: oito propriedades verificadas em cinco cenários sintéticos; oito testes aprovados;
- fechamento de publicação: 15 testes do backend e 24 do mobile aprovados, TypeScript do backend, mobile e admin, ESLint do mobile e builds do backend e admin sem erros;
- smoke publicado: **2,95 s** ponta a ponta, **2,07 s** no solver e nenhum item não alocado;
- Galaxy S9 físico: criação de Pirenópolis com 3 dias e 5 atrações, resultado percebido em 13 s, mapa real e persistência após reinstalação;
- APK `preview` do EAS: instalação, login Google com chave de release, restauração pelo Firestore e mapa 2D validados;
- variante `tcc-demo`: sessão Firebase anônima como **Visitante**, perfil TCC fixo e roteiros demonstrativos de Brasília, Pirenópolis e Rio de Janeiro;
- APK `tcc-demo` final: instalado sem Metro no Galaxy S9, reaberto offline e validado em 2D/3D com o tracejado Android calibrado;
- grafo do solver no Galaxy S9: roteiro de três dias, alternância de destaque sem esconder os demais nós, zoom global/por dia, detalhes e conexões próximas da matriz validados;
- colaboração publicada: editor pode editar/criar despesas, visualizador permanece somente leitura, saída voluntária remove o acesso e exclusão da conta anonimiza o participante;
- conclusão da viagem: o último POI resolvido encerra o roteiro, e a viagem aparece em Memórias sem depender do antigo modelo de voos;
- compartilhamento: imagem e MP4 de aproximadamente 12 s e 5,5 MB salvos na galeria;
- exclusão da conta fake: documentos órfãos removidos e viagens dos proprietários preservadas;
- monografia: revisão integral de texto e figuras, modelo formal confrontado com o código, comparação de estratégias do solver e limites das evidências explicitados; veja a [análise do PR #6](tcc/REVISAO_PR6_20260923.md), a [conferência das orientações da banca e do template](tcc/REVISAO_ORIENTACOES_TEMPLATE_20260923.md), a [revisão dos diagramas no draw.io](tcc/REVISAO_DIAGRAMAS_20260923.md) e o [PDF atualizado](slides/TCC_FGA.pdf);
- avaliação com participantes: seis participantes, 30 casos de teste e respostas coletadas por formulário próprio, apresentados na monografia;
- aferição das estimativas de dois modelos: procedimento preparado, ainda sem execução; defesa sem data definida e ficha catalográfica provisória;
- apresentação: slides HTML de 24 páginas, notas e perguntas da banca mantêm a revisão anterior; os novos resultados da monografia ainda precisam ser incorporados à defesa.

O resultado é uma **validação funcional**, não uma demonstração de otimalidade nem uma avaliação estatística em larga escala.

## Solver

Cada dia é modelado como um veículo. A instância considera matriz de deslocamentos, tempos de serviço, janelas de funcionamento, âncoras logísticas, prioridades, limite de atrações e alternativas de refeição.

O orçamento de busca é adaptativo:

- complexidade até 30: 2 s;
- complexidade até 70: 5 s;
- instâncias maiores: 15 s configuráveis;
- fallback: até 30 s, se ainda houver prazo na requisição.

Esses valores são tetos padrão; o prazo restante enviado pelo backend pode reduzi-los.

Penalidades mantêm a instância viável quando nem todos os pontos cabem e limites suaves favorecem dias equilibrados. A implementação atual fica em [`aplicativo/solver/app/infrastructure/ortools_solver.py`](aplicativo/solver/app/infrastructure/ortools_solver.py).

No perfil TCC, **Ver grafo** abre a explicação interativa da solução. O backend persiste um `solverTrace` compacto com os nós e restrições efetivamente enviados, arestas escolhidas, cinco vizinhos próximos por nó, distância da ordem de entrada e duração real da chamada. A matriz completa não é salva no Firestore: a tela informa sua cardinalidade, mas evita inflar o documento da viagem. Roteiros antigos usam somente um trace derivado e são identificados como pré-calculados, sem inventar métricas ausentes.

## Arquitetura e deploy

| Componente | Tecnologia | Estado |
| --- | --- | --- |
| Mobile | React Native + Expo SDK 55 | Perfil `tcc-demo`; cliente nativo instalado no iPhone, com validações funcionais registradas em `aplicativo/OTIMIZACOES.md` |
| Backend | Fastify + TypeScript | [Cloud Run saudável](https://interlude-backend-4jgz7kbt6a-uc.a.run.app/health) |
| Solver | FastAPI + OR-Tools | Cloud Run privado, acessado pelo backend |
| Identidade/dados | Firebase Auth + Firestore | Publicado no projeto `interlude-b499c` |
| Cache | Upstash Redis | Ativo para matrizes de rota |
| Admin | React + Vite | [Firebase Hosting](https://interlude-b499c.web.app) |
| Monografia | LaTeX + abnTeX2 | Avaliação com seis participantes e seus perfis incorporada; defesa pendente |
| Voos | Fora do recorte | Não publicar nesta etapa |

Projetos de nuvem: `interlude-471919` para Cloud Run e `interlude-b499c` para Firebase.

## Estrutura do repositório

```text
aplicativo/
  mobile/       aplicativo Expo/React Native
  backend/      fachada Fastify e integrações externas
  solver/       microserviço FastAPI/OR-Tools
  admin/        painel administrativo React/Vite
  flights/      integração experimental, fora do perfil TCC
  firestore.rules
  docker-compose.yml
diagramas/      diagramas e figuras da monografia
slides/         HTML principal, PDF do TCC, roteiro e perguntas da defesa
tcc/            fontes LaTeX da monografia
CHECKLIST_TCC2_FINAL.md
```

## Execução local

Pré-requisitos: Docker, Node.js 20+, npm, Android SDK/ADB e, para builds remotos, EAS CLI autenticado.

1. Crie os arquivos locais a partir dos exemplos:

```bash
cp aplicativo/backend/.env.example aplicativo/backend/.env
cp aplicativo/mobile/.env.example aplicativo/mobile/.env
cp aplicativo/admin/.env.example aplicativo/admin/.env
```

2. Adicione as credenciais Firebase nativas sem versioná-las:

```text
aplicativo/mobile/firebase/google-services.json
aplicativo/mobile/firebase/GoogleService-Info.plist
```

No EAS, `GOOGLE_SERVICES_JSON` deve ser uma variável secreta do tipo arquivo. O hook `eas-build-post-install` a copia para o projeto Android durante o build.

3. Inicie os serviços:

```bash
cd aplicativo
docker compose up --build
```

Endpoints locais: backend em `http://localhost:4000`, solver em `http://localhost:8001` e admin em `http://localhost:5173`.

4. Execute o Android:

```bash
cd aplicativo/mobile
npm install
npm run lint
npx tsc --noEmit
npx expo run:android
```

Builds de release:

```bash
cd aplicativo/mobile/android
./gradlew app:assembleRelease

cd ..
npx eas-cli build --platform android --profile preview

# APK da banca: sem login pessoal, com sessão anônima e dados fictícios
npx eas-cli build --platform android --profile tcc-demo
```

O APK `tcc-demo` usa o mesmo backend publicado e o solver real quando há internet. No primeiro acesso, cria uma identidade Firebase anônima, ignora qualquer sessão pessoal previamente persistida e prepara três casos para apresentação: Brasília em um dia, bate-volta Brasília–Pirenópolis e Rio de Janeiro em três dias. Em **Perfil → Restaurar roteiros**, apenas os roteiros demonstrativos são reiniciados; viagens criadas durante a avaliação são preservadas.

## Verificação

```bash
# Backend
cd aplicativo/backend
npm install
npm run typecheck
npm run build

# Solver
cd ../solver
python -m compileall app
python -m unittest discover -s tests -v

# Admin
cd ../admin
npm install
npm run typecheck
npm run build

# Mobile
cd ../mobile
npm install
npm run lint
npx tsc --noEmit
npm run smoke:collaboration

# Exemplos determinísticos usados para explicar o solver na defesa
cd ../solver
python scripts/defense_demo.py

# Monografia
cd ../../tcc
docker compose run --rm latex make
```

O PDF revisado e versionado fica em [`slides/TCC_FGA.pdf`](slides/TCC_FGA.pdf); a fonte está em `tcc/latex`. O checklist detalhado está em [`CHECKLIST_TCC2_FINAL.md`](CHECKLIST_TCC2_FINAL.md).

## O que ainda falta para a banca

Itens de produto/deploy:

- repetir com uma foto real da câmera o teste de associação foto–POI; leitura da viagem concluída, permissão e estado sem fotos já foram validados no S9;
- configurar alertas de orçamento e cotas;
- preparar o Compose e as variáveis locais como contingência;
- gravar vídeos curtos do fluxo completo e do solver.

Documentação e defesa:

- usar o deck revisado em `slides/html/index.html`; o PowerPoint de 18 slides está preservado como histórico;
- ensaiar a apresentação cronometrada e as perguntas sobre solver;
- desativar notificações/atualizações no aparelho imediatamente antes da apresentação.

Não faz parte do fechamento: API de voos, suíte ampla de testes do aplicativo, testes de carga, Universal Links e funcionalidades ocultas pelo perfil TCC.

## Segurança

Arquivos `.env`, chaves Firebase nativas, conta de serviço e segredos do EAS não devem ser versionados. As chaves públicas usadas pelo cliente devem continuar restritas por pacote, certificado SHA e APIs necessárias no Google Cloud/Firebase.
