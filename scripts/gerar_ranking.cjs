// Reproduz o ranking e o feed com o código do app e a descoberta capturada.
// Executar na raiz: node slides/motion/scripts/gerar_ranking.cjs
// Não consulta APIs nem altera a captura ou a seleção do viajante.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const data = path.join(root, 'slides/html/data');
const ts = require(path.join(root, 'aplicativo/mobile/node_modules/typescript'));
const read = name => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function appModule(name) {
  const source = fs.readFileSync(path.join(root, 'aplicativo/mobile/src/features/discover', name), 'utf8');
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  new Function('exports', compiled)(exports);
  return {exports, sha256: sha256(source)};
}
const rankingModule = appModule('ranking.ts');
const interleaveModule = appModule('interleave.ts');
const ranking = rankingModule.exports;
const snapshot = read('descoberta-atual.json');
const example = read('exemplo-atual.json');
const selectedTypes = new Set(snapshot.request.buckets.flatMap(b => b.types));
const candidates = snapshot.buckets.flatMap(b => b.places.filter(p => !ranking.isNonAttraction(p, selectedTypes)));
const score = ranking.createPopularityScore(candidates, {
  center: snapshot.request.location, radiusMeters: snapshot.request.radiusMeters,
});
const buckets = snapshot.buckets.map(b => ({...b, places: ranking.rankPlaces(b.places, score, selectedTypes)}));
const unique = new Map(buckets.flatMap(b => b.places).map(p => [p.placeId, p]));
const sorted = [...unique.values()].sort((a, b) => score(b) - score(a));
const head = sorted.slice(0, 8);
const seen = new Set(head.map(p => p.placeId));
const tail = interleaveModule.exports.weightedInterleave(buckets.map(b => ({
  ...b, places: b.places.filter(p => !seen.has(p.placeId)),
}))).filter(p => {
  if (seen.has(p.placeId)) return false;
  seen.add(p.placeId);
  return true;
});
const feed = [...head, ...tail];
const stops = read('solver-request.json').stops.filter(s => !s.is_depot && !s.is_meal)
  .sort((a, b) => a.priority - b.priority);
// Nesta captura as doze primeiras sugestões foram aceitas sem reordenação.
assert.deepEqual(feed.slice(0, stops.length).map(p => p.placeId), stops.map(s => s.id));
assert.equal(example.ranking.length, stops.length);
example.ranking = stops.map((stop, i) => {
  const place = unique.get(stop.id);
  const previous = example.ranking[i];
  assert.equal(previous.rating, place.rating);
  assert.equal(previous.count, place.userRatingCount);
  return {...previous, placeId: place.placeId, feedPosition: i + 1,
    product: place.rating * place.userRatingCount / 1000,
    bayes: ranking.popularityScore(place), score: score(place)};
});
example.rankingCandidateCount = unique.size;
example.rankingReviewRange = [Math.min(...candidates.map(p => p.userRatingCount ?? 0)),
  Math.max(...candidates.map(p => p.userRatingCount ?? 0))];
example.rankingScope = 'Escore real normalizado sobre os 49 candidatos válidos da descoberta. O gráfico exibe somente as 12 atrações selecionadas, todas dentro do raio de 50 km. Nesta captura, o recorte coincide com as primeiras 12 posições do feed, que intercala categorias após as primeiras oito sugestões.';
example.rankingProvenance = {discoverySha256: sha256(fs.readFileSync(path.join(data, 'descoberta-atual.json'))),
  rankingSourceSha256: rankingModule.sha256, interleaveSourceSha256: interleaveModule.sha256};
fs.writeFileSync(path.join(data, 'exemplo-atual.json'), JSON.stringify(example, null, 2) + '\n');
console.log(`Ranking reproduzido: ${unique.size} candidatos; ${stops.length} posições coincidem com a seleção real.`);
for (const p of example.ranking) console.log(`${p.feedPosition}. ${p.name}: ${p.score.toFixed(6)}`);
