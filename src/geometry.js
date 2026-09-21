// The decision engine deliberately has no DOM, map, or network dependency.
export function validPoint(point) {
  return Array.isArray(point) && point.length >= 2 &&
    point.slice(0, 2).every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
}

export function computeBbox(coordinates) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  function visit(value) {
    if (typeof value[0] === 'number') {
      box[0] = Math.min(box[0], value[0]); box[1] = Math.min(box[1], value[1]);
      box[2] = Math.max(box[2], value[0]); box[3] = Math.max(box[3], value[1]);
    } else value.forEach(visit);
  }
  visit(coordinates);
  return box;
}

export function normalizeProperties(p = {}) {
  p ||= {};
  const take = (...keys) => keys.map(k => p[k]).find(v => v !== undefined && v !== null && String(v).trim() !== '');
  return {
    parkName: String(take('parkName', 'park_name', 'NAME', 'NP_NAME', 'PARK_NAME', '公園名', '名称') || '公園名未設定'),
    parkType: String(take('parkType', '公園種別') || '種別未確認'),
    zoneName: String(take('zoneName', 'zone_name', 'ZONE', 'ZONE_NAME', 'AREA_TYPE', '地種区分', '区域', '区分') || '地種区分未収録').normalize('NFKC'),
    source: String(take('source', '出典') || ''),
    sourceDate: String(take('sourceDate', '基準日') || '未確認'),
    mapSheet: String(take('mapSheet', '図名') || ''),
    mapUrl: String(take('mapUrl', '区域図URL') || ''),
  };
}

export function prepareCollection(data) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) {
    throw new Error('区域を含むFeatureCollectionが必要です。');
  }
  if (data.crs && !/CRS84|4326/.test(JSON.stringify(data.crs))) {
    throw new Error('座標系をWGS84（EPSG:4326）の経度・緯度に変換してください。');
  }
  const features = data.features.map((feature, index) => {
    const g = feature?.geometry;
    if (feature?.type !== 'Feature' || !['Polygon', 'MultiPolygon'].includes(g?.type)) {
      throw new Error(`${index + 1}件目: Polygon / MultiPolygonのみ対応しています。`);
    }
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) throw new Error(`${index + 1}件目: 空の区域です。`);
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length) throw new Error(`${index + 1}件目: 外周がありません。`);
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4 || !ring.every(validPoint) ||
          ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1] ||
          new Set(ring.map(p => `${p[0]},${p[1]}`)).size < 3) {
          throw new Error(`${index + 1}件目: 無効なリングです。閉じた経度・緯度の座標列を指定してください。`);
        }
      }
    }
    // Recompute rather than trusting stale, reversed, or 3D GeoJSON bboxes.
    return {...feature, properties: {...feature.properties, ...normalizeProperties(feature.properties)}, bbox: computeBbox(g.coordinates)};
  });
  return {...data, features};
}

function ringRelation([x, y], ring) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);
    // Only floating-point tolerance, not a buffer that enlarges the protected area.
    if (length && Math.abs((x - ax) * dy - (y - ay) * dx) <= 1e-10 * length &&
      x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10 &&
      y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10) return 'boundary';
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function polygonRelation(point, rings) {
  const outer = ringRelation(point, rings[0]);
  if (outer !== 'inside') return outer;
  for (const hole of rings.slice(1)) {
    const relation = ringRelation(point, hole);
    if (relation === 'boundary') return 'boundary';
    if (relation === 'inside') return 'outside';
  }
  return 'inside';
}

export function geometryRelation(geometry, point) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const relations = polygons.map(p => polygonRelation(point, p));
  return relations.includes('inside') ? 'inside' : relations.includes('boundary') ? 'boundary' : 'outside';
}

// Local tangent-plane estimate, intended for nearby boundary warnings in Japan.
export function boundaryDistance(geometry, point) {
  const sx = 111320 * Math.cos(point[1] * Math.PI / 180), sy = 110574;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let minimum = Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - point[0]) * sx, ay = (ring[i - 1][1] - point[1]) * sy;
    const bx = (ring[i][0] - point[0]) * sx, by = (ring[i][1] - point[1]) * sy;
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
    minimum = Math.min(minimum, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return minimum;
}

export function evaluateCollections(collections, point, accuracy = 0) {
  if (!validPoint(point) || !Number.isFinite(accuracy) || accuracy < 0) throw new Error('緯度・経度または測位精度が不正です。');
  const radius = Math.max(20, accuracy);
  const dy = radius / 110000, dx = radius / (110000 * Math.max(0.001, Math.cos(point[1] * Math.PI / 180)));
  const hits = [], nearby = [];
  for (const collection of collections) for (const feature of collection.features) {
    const [west, south, east, north] = feature.bbox;
    if (point[0] < west - dx || point[0] > east + dx || point[1] < south - dy || point[1] > north + dy) continue;
    const relation = geometryRelation(feature.geometry, point);
    const distance = boundaryDistance(feature.geometry, point);
    const match = {feature, relation, distance, dataset: collection.label || collection.name || '', datasetId: collection.id};
    if (relation !== 'outside') hits.push(match);
    else if (distance <= radius) nearby.push(match);
  }
  return {hits, nearby, accuracy, radius, loaded: collections.length > 0};
}
