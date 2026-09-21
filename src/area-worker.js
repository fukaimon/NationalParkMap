import {prepareCollection, evaluateCollections} from './geometry.js';
import {featuresForMap} from './map-geometry.js';
import {storedDatasets, saveDataset, deleteDataset} from './storage.js';

const datasets = new Map();
const persisted = new Set();
function status() {
  return [...datasets.values()].map(d => ({id: d.id, label: d.label, count: d.features.length,
    parks: [...new Set(d.features.map(f => f.properties.parkName))],
    types: [...new Set(d.features.map(f => f.properties.parkType))],
    saved: persisted.has(d.id), sourceDate: d.sourceDate || '未確認'}));
}
async function add(data, id, label) {
  const collection = {...prepareCollection(data), id, label};
  datasets.set(id, collection);
  persisted.delete(id);
  let storageError = '';
  try { await saveDataset(collection); persisted.add(id); }
  catch { storageError = '端末への保存に失敗しました。この画面では判定できますが、再起動後のオフライン判定には使えません。'; }
  return {datasets: status(), storageError};
}
async function official() {
  const response = await fetch('../data/national-parks.geojson', {cache: 'no-store'});
  if (!response.ok) throw new Error(`区域データを読み込めませんでした（HTTP ${response.status}）。`);
  const data = await response.json();
  for (const f of data.features) f.properties = {...f.properties, parkType: '国立公園'};
  return add(data, 'official-national', '同梱の国立公園データ');
}

async function handle(message) {
  if (message.type === 'init') {
    try {
      for (const saved of await storedDatasets()) {
        try { datasets.set(saved.id, prepareCollection(saved)); persisted.add(saved.id); } catch { /* Reload invalid cached official data below. */ }
      }
    } catch { /* Storage may be unavailable; in-memory decisions remain available. */ }
    if (!datasets.has('official-national')) {
      try { return await official(); }
      catch (error) { return {datasets: status(), loadError: error.message}; }
    }
    return {datasets: status()};
  }
  if (message.type === 'official') return official();
  if (message.type === 'remove') {
    if (!message.datasetId?.startsWith('import:')) throw new Error('追加ファイルのみ削除できます。');
    await deleteDataset(message.datasetId);
    datasets.delete(message.datasetId);
    persisted.delete(message.datasetId);
    return {datasets: status()};
  }
  if (message.type === 'import') {
    const data = message.data || JSON.parse(await message.file.text());
    return add(data, `import:${message.name}`, message.name);
  }
  if (message.type === 'map') return featuresForMap([...datasets.values()], message.bounds, message.zoom);
  if (message.type === 'evaluate') return evaluateCollections([...datasets.values()], message.point, message.accuracy);
  throw new Error('不明な操作です。');
}

// Serialize writes and reads so late initial loading cannot replace user data or decisions.
let queue = Promise.resolve();
self.onmessage = ({data}) => {
  queue = queue.then(async () => {
    try { self.postMessage({id: data.id, result: await handle(data)}); }
    catch (error) { self.postMessage({id: data.id, error: error.message}); }
  });
};
