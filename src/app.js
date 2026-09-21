import {validPoint, normalizeProperties} from './geometry.js';
import {kmlToGeoJson} from './kml.js';

const $ = selector => document.querySelector(selector);
const resultEl = $('#result');
let map, parkLayer, marker, accuracyCircle;
let mapVersion = 0, mapTimer;
let selectedPoint = null, evaluationVersion = 0, searchVersion = 0;
let requestId = 0, datasetInfo = [], shellSaved = false;
const pending = new Map();
const worker = new Worker(new URL('./area-worker.js', import.meta.url), {type: 'module'});
worker.onmessage = ({data}) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  data.error ? request.reject(new Error(data.error)) : request.resolve(data.result);
};
let workerFailed = false;
worker.onerror = () => {
  workerFailed = true;
  for (const request of pending.values()) request.reject(new Error('区域判定の起動に失敗しました。ページを再読み込みしてください。'));
  pending.clear();
  message('区域判定の起動に失敗しました。HTTPサーバーで開いているか確認してください。');
};
function ask(type, payload = {}) {
  if (workerFailed) return Promise.reject(new Error('区域判定を再起動するため、ページを再読み込みしてください。'));
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, type, ...payload});
  });
}

$('#coordForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('#latInput').value.trim() || !$('#lngInput').value.trim()) return message('緯度と経度を両方入力してください。');
  evaluatePoint(Number($('#latInput').value), Number($('#lngInput').value), '指定座標');
});
$('#locateButton').addEventListener('click', () => {
  if (!navigator.geolocation) return message('このブラウザでは現在地を取得できません。座標を入力してください。');
  const version = ++evaluationVersion;
  $('#locateButton').disabled = true;
  message('現在地を取得しています。');
  navigator.geolocation.getCurrentPosition(position => {
    $('#locateButton').disabled = false;
    if (version !== evaluationVersion) return;
    evaluatePoint(position.coords.latitude, position.coords.longitude, '現在地', position.coords.accuracy, position.timestamp);
  }, error => {
    $('#locateButton').disabled = false;
    if (version !== evaluationVersion) return;
    message(({1: '位置情報の利用が許可されていません。ブラウザの設定を確認するか座標を入力してください。',
      2: '現在地を測位できません。座標を入力して判定できます。',
      3: '現在地の取得が時間切れになりました。屋外で再試行するか座標を入力してください。'})[error.code] || '現在地を取得できません。');
  }, {enableHighAccuracy: true, timeout: 20000, maximumAge: 0});
});

$('#placeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const query = $('#placeInput').value.trim();
  if (!query) return;
  const version = ++searchVersion;
  const pointVersion = evaluationVersion;
  $('#searchResults').replaceChildren();
  if (!navigator.onLine) {
    $('#searchStatus').textContent = '地名検索には通信が必要です。緯度・経度または現在地で判定してください。';
    return;
  }
  $('#searchStatus').textContent = '地名を検索しています…';
  try {
    const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`, {signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('検索失敗');
    const results = await response.json();
    if (version !== searchVersion || pointVersion !== evaluationVersion) return;
    const candidates = results.filter(r => validPoint(r.geometry?.coordinates)).slice(0, 20);
    $('#searchStatus').textContent = candidates.length ? '候補を選んでください。検索座標は地名の代表点です。' : '該当する地名が見つかりませんでした。';
    for (const item of candidates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-candidate';
      const [lng, lat] = item.geometry.coordinates;
      const title = item.properties?.title || query;
      button.textContent = `${title}（${lat.toFixed(5)}, ${lng.toFixed(5)}）`;
      button.addEventListener('click', () => evaluatePoint(lat, lng, `検索地点: ${title}`));
      $('#searchResults').append(button);
    }
  } catch {
    if (version === searchVersion) $('#searchStatus').textContent = '地名検索には通信が必要です。検索に失敗しましたが、座標・現在地での区域判定は引き続き利用できます。';
  }
});

let loading = false;
async function loadData(type, payload = {}) {
  if (loading) return;
  loading = true;
  $('#officialDataButton').disabled = true;
  $('#areaFileInput').disabled = true;
  $('#dataStatus').textContent = '読込中';
  $('#dataMessage').textContent = '区域データを読み込み、端末へ保存しています…';
  try {
    const result = await ask(type, payload);
    datasetInfo = result.datasets;
    $('#dataMessage').textContent = result.loadError || result.storageError || '読み込んだ全データを使って判定します。同じファイル名の追加データは置き換えます。';
    renderCoverage();
    refreshAreas();
    if (selectedPoint) await evaluatePoint(...selectedPoint);
  } catch (error) {
    $('#dataMessage').textContent = `${error.message} 既存の区域データは引き続き利用できます。`;
    renderCoverage();
  } finally {
    loading = false;
    $('#officialDataButton').disabled = false;
    $('#areaFileInput').disabled = false;
  }
}
$('#officialDataButton').addEventListener('click', () => loadData('official'));
$('#areaFileInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (/\.kml$/i.test(file.name)) {
      await loadData('import', {data: kmlToGeoJson(await file.text(), file.name), name: file.name});
    } else await loadData('import', {file, name: file.name});
  } catch (error) { $('#dataMessage').textContent = `区域ファイルを追加できませんでした。${error.message}`; }
  event.target.value = '';
});

function renderCoverage() {
  const count = datasetInfo.reduce((sum, d) => sum + d.count, 0);
  $('#dataStatus').textContent = count ? `${count.toLocaleString()}区域` : '未読込';
  $('#dataStatus').className = `status-pill ${count ? 'ready' : 'warn'}`;
  $('#coverage').innerHTML = datasetInfo.map(d => `<details><summary>${escapeHtml(d.label)} · ${d.parks.length}公園 / ${d.count.toLocaleString()}区域</summary><p>${escapeHtml(d.types.join('・'))} ／ 基準日: ${escapeHtml(d.sourceDate)} ／ ${d.saved ? '端末に保存済み' : '未保存'}</p><p>${escapeHtml(d.parks.join('、'))}</p>${d.id.startsWith('import:') ? `<button type="button" class="secondary-button" data-remove="${escapeHtml(d.id)}">この追加データを削除</button>` : ''}</details>`).join('') || '判定用データがありません。通信可能な状態で再読込するか、区域ファイルを追加してください。';
  for (const button of $('#coverage').querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => loadData('remove', {datasetId: button.dataset.remove}));
  }
  $('#coverageNote').textContent = datasetInfo.some(d => d.types.includes('国定公園'))
    ? '国定公園は追加ファイルの収録範囲のみ対応しています。全国網羅・最新の区域とは限りません。'
    : '同梱: 国立公園35公園。国定公園は未収録です。基準日が未確認のため、最新の区域との一致は未検証です。';
  updateOfflineStatus();
}
function updateOfflineStatus() {
  const dataSaved = datasetInfo.length && datasetInfo.every(d => d.saved);
  $('#offlineStatus').textContent = `${navigator.onLine ? 'オンライン' : 'オフライン'} · ` +
    (shellSaved && dataSaved ? 'オフライン判定の準備完了' : !dataSaved ? '区域データの端末保存が必要です' : '画面のオフライン保存を確認中');
  if (!navigator.onLine) $('#mapStatus').textContent = 'オフラインです。背景地図がなくても座標・現在地から判定できます。';
}
for (const event of ['online', 'offline']) window.addEventListener(event, updateOfflineStatus);

async function evaluatePoint(lat, lng, label = '指定地点', accuracy = 0, timestamp = null) {
  const point = [lng, lat];
  if (!validPoint(point)) return message('有効な緯度（−90〜90）・経度（−180〜180）を入力してください。');
  selectedPoint = [lat, lng, label, accuracy, timestamp];
  const version = ++evaluationVersion;
  $('#latInput').value = lat.toFixed(6); $('#lngInput').value = lng.toFixed(6);
  $('#readLat').textContent = lat.toFixed(6); $('#readLng').textContent = lng.toFixed(6);
  $('#pointInfo').textContent = `${label}${accuracy ? ` ／ 測位精度: 約${Math.ceil(accuracy)} m` : ''}${timestamp ? ` ／ ${new Date(timestamp).toLocaleTimeString('ja-JP')}取得` : ''}`;
  message('区域を判定しています…');
  try {
    const result = await ask('evaluate', {point, accuracy});
    if (version !== evaluationVersion) return;
    renderResult(result);
    // A failed map render must never overwrite the independently computed decision.
    try { showOnMap(lat, lng, label, result); }
    catch { $('#mapStatus').textContent = '地図を表示できません。区域判定結果は利用できます。'; }
  } catch (error) { if (version === evaluationVersion) message(error.message); }
}

function renderResult({hits, nearby, accuracy, loaded}) {
  if (!loaded) return message('判定できません。区域データが未読込です。区域ファイルを追加するかデータを再読み込みしてください。');
  resultEl.className = 'hit-list';
  const uncertain = hits.some(h => h.relation === 'boundary' || h.distance <= Math.max(20, accuracy)) || nearby.length > 0;
  let heading = hits.length ? '読み込み済み区域に該当' : '読み込み済み区域に該当なし';
  if (hits.some(h => h.relation === 'boundary')) heading = '区域の境界上です';
  resultEl.innerHTML = `<p class="decision-title">${heading}</p>`;
  if (!hits.length) resultEl.innerHTML += '<p class="hit-meta">未収録・区域変更の可能性があるため、国立・国定公園の区域外とは断定できません。</p>';
  if (uncertain) resultEl.innerHTML += `<p class="notice">境界付近のため要確認。${accuracy ? '測位誤差の範囲が区域境界にかかる可能性があります。' : '境界上または境界から約20 m以内です。'} 周辺の区域もあわせて表示します。</p>`;
  if (new Set(hits.map(h => JSON.stringify([h.feature.properties.parkName, h.feature.properties.zoneName]))).size > 1) {
    resultEl.innerHTML += '<p class="notice">複数の区域に該当しています。共有境界やデータの重複・版の違いを確認してください。</p>';
  }
  const groups = new Map();
  for (const match of [...hits, ...nearby]) {
    const p = normalizeProperties(match.feature.properties);
    const key = JSON.stringify([match.datasetId, p.parkName, p.zoneName, p.mapSheet, p.mapUrl, p.source, p.sourceDate, match.relation]);
    if (!groups.has(key)) groups.set(key, {...match, count: 1});
    else { const g = groups.get(key); g.count++; g.distance = Math.min(g.distance, match.distance); }
  }
  for (const match of groups.values()) {
    const p = normalizeProperties(match.feature.properties);
    const safeUrl = /^https?:\/\//i.test(p.mapUrl) ? p.mapUrl : '';
    resultEl.innerHTML += `<article class="hit-item ${match.relation === 'outside' ? 'nearby' : ''}">
      <p class="hit-title">${escapeHtml(p.parkName)} <small>${escapeHtml(p.parkType)}</small></p>
      <p class="zone-label" style="--zone-color:${zoneColor(p.zoneName)}">${escapeHtml(p.zoneName)}</p>
      <p class="hit-meta">${{inside: '指定地点を含む', boundary: '境界上（所属の確定はできません）', outside: '周辺候補（指定地点は含まない）'}[match.relation]} ／ 境界まで約${Math.round(match.distance).toLocaleString()} m</p>
      <p class="hit-meta">出典: ${escapeHtml(p.source || match.dataset)} ／ 基準日: ${escapeHtml(p.sourceDate)}</p>
      <p class="hit-meta">${p.mapSheet ? `区域図: ${escapeHtml(p.mapSheet)}` : '公式区域図の図名・図番号は未収録'}</p>
      ${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">対応する区域図を開く</a>` : ''}
    </article>`;
  }
}

function initMap() {
  try {
    if (!window.L) throw new Error('Leaflet unavailable');
    map = L.map('map', {center: [36.2, 138.25], zoom: 5, preferCanvas: true});
    const standard = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>'});
    const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>'});
    for (const layer of [standard, photo]) {
      layer.on('tileerror', () => { $('#mapStatus').textContent = '背景地図を取得できません。区域判定は引き続き利用できます。'; });
      layer.on('tileload', () => { $('#mapStatus').textContent = '区域図は右上で表示・非表示を切り替えられます。地点を選ぶと区域を判定します。'; });
    }
    standard.addTo(map);
    parkLayer = L.geoJSON(null, {
      interactive: false,
      style: f => ({color: zoneColor(f.properties.zoneName), weight: 1, fillOpacity: 0.18}),
    }).addTo(map);
    L.control.layers({地図: standard, 航空写真: photo}, {区域図: parkLayer}, {collapsed: false}).addTo(map);
    map.on('moveend', refreshAreas);
    map.on('overlayadd overlayremove', event => {
      if (event.layer !== parkLayer) return;
      const visible = map.hasLayer(parkLayer);
      $('.legend').hidden = !visible;
      refreshAreas();
    });
    refreshAreas();
    map.on('click', e => evaluatePoint(e.latlng.lat, e.latlng.lng, '地図上の指定地点'));
  } catch { $('#mapStatus').textContent = '地図を表示できません。座標・現在地で区域を判定できます。'; }
}
function showOnMap(lat, lng, label, result) {
  if (!map) return;
  if (marker) marker.remove();
  marker = L.marker([lat, lng], {icon: L.divIcon({className: 'point-marker', iconSize: [18, 18], iconAnchor: [9, 9]})}).addTo(map);
  marker.bindPopup(escapeHtml(label));
  if (accuracyCircle) accuracyCircle.remove();
  if (result.accuracy) accuracyCircle = L.circle([lat, lng], {radius: result.accuracy, color: '#145cde', weight: 1, fillOpacity: 0.08}).addTo(map);
  map.setView([lat, lng], Math.max(map.getZoom(), 12));
}
// Debounce navigation and discard outdated responses, including when hidden mid-load.
function refreshAreas() {
  const version = ++mapVersion;
  clearTimeout(mapTimer);
  if (!map || !parkLayer || !map.hasLayer(parkLayer)) return;
  mapTimer = setTimeout(async () => {
    const bounds = map.getBounds();
    try {
      const features = await ask('map', {
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        zoom: map.getZoom(),
      });
      if (version !== mapVersion || !map.hasLayer(parkLayer)) return;
      parkLayer.clearLayers();
      parkLayer.addData({type: 'FeatureCollection', features});
    } catch {
      if (version === mapVersion) $('#mapStatus').textContent = '区域図を表示できません。地図を移動するか、区域図を再表示してください。';
    }
  }, 150);
}
function zoneColor(name = '') {
  name = name.normalize('NFKC');
  if (name.includes('特別保護')) return '#b42318';
  if (/第[1一]/.test(name)) return '#b36b00';
  if (/第[2二]/.test(name)) return '#2f855a';
  if (/第[3三]/.test(name)) return '#2563eb';
  if (name.includes('海域')) return '#0891b2';
  return '#4b5563';
}
function message(text) { resultEl.className = 'result-empty'; resultEl.textContent = text; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'}[c])); }

// Start the decision engine first. Even a missing map script cannot stop it.
loadData('init');
const mapScript = document.createElement('script');
mapScript.src = './vendor/leaflet/leaflet.js';
mapScript.onload = initMap;
mapScript.onerror = () => { $('#mapStatus').textContent = '地図を読み込めません。座標・現在地で区域を判定できます。'; };
document.head.append(mapScript);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'shell-ready') { shellSaved = true; updateOfflineStatus(); }
  });
  navigator.serviceWorker.register('./sw.js', {type: 'module'}).then(async registration => {
    await navigator.serviceWorker.ready;
    (registration.active || navigator.serviceWorker.controller)?.postMessage({type: 'check-shell'});
  }).catch(() => { $('#offlineStatus').textContent = '画面をオフライン保存できません。HTTPSまたはlocalhostで開いてください。'; });
} else $('#offlineStatus').textContent = 'このブラウザでは画面をオフライン保存できません。';
