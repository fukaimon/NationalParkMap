import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prepareCollection, evaluateCollections, geometryRelation, normalizeProperties} from '../src/geometry.js';
const square = (x, y, size = 1) => [[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
const feature = (coordinates, properties = {}) => ({type:'Feature', properties, geometry:{type:'Polygon',coordinates}});
const collection = features => prepareCollection({type:'FeatureCollection', features});

test('外周・頂点・穴の境界を内部と区別する', () => {
  const geometry = feature([square(135,35), square(135.2,35.2,0.2)]).geometry;
  for (const p of [[135,35], [135.5,35], [136,35.5], [135.2,35.3]]) assert.equal(geometryRelation(geometry,p),'boundary');
  assert.equal(geometryRelation(geometry,[135.1,35.1]),'inside');
  assert.equal(geometryRelation(geometry,[135.3,35.3]),'outside');
  assert.equal(geometryRelation(geometry,[134,35]),'outside');
});
test('リングの向きと重複頂点に依存しない', () => {
  const ring = square(135,35).reverse(); ring.splice(1,0,ring[1]);
  assert.equal(geometryRelation(feature([ring]).geometry,[135.5,35.5]),'inside');
  assert.equal(geometryRelation(feature([ring]).geometry,[135,35]),'boundary');
});
test('飛び地と共有境界では全候補を返す', () => {
  const g={type:'MultiPolygon',coordinates:[[square(135,35)],[square(139,35)]]};
  assert.equal(geometryRelation(g,[139.5,35.5]),'inside');
  assert.equal(geometryRelation(g,[138,35.5]),'outside');
  const data=collection([feature([square(135,35)]), feature([square(136,35)])]);
  const result=evaluateCollections([data],[136,35.5]);
  assert.equal(result.hits.length,2);
  assert.ok(result.hits.every(h=>h.relation==='boundary'));
});
test('誤ったbboxと高度付きbboxを再計算する', () => {
  const f=feature([square(135,35)]); f.bbox=[0,0,0,1,1,1];
  assert.equal(evaluateCollections([collection([f])],[135.5,35.5]).hits.length,1);
});
test('GPS誤差が境界を越える場合は中心点外の候補も返す', () => {
  const data=collection([feature([square(135,35)])]);
  const result=evaluateCollections([data],[134.9995,35.5],100);
  assert.equal(result.hits.length,0); assert.equal(result.nearby.length,1);
  assert.ok(result.nearby[0].distance>40 && result.nearby[0].distance<50);
  assert.equal(evaluateCollections([data],[134.9995,35.5],0).nearby.length,0);
});
test('未読込と一致なしを区別する', () => {
  assert.equal(evaluateCollections([],[135,35]).loaded,false);
  assert.equal(evaluateCollections([collection([feature([square(139,35)])])],[135,35]).loaded,true);
});
test('不正な入力と区域を黙って読み飛ばさない', () => {
  assert.throws(()=>evaluateCollections([],[35,135]));
  assert.throws(()=>evaluateCollections([],[135,35],-1));
  assert.throws(()=>collection([]));
  assert.throws(()=>collection([feature([[[135,35],[136,35],[136,36]]])]));
  assert.throws(()=>collection([feature([[[135,35],[135,35],[135,35],[135,35]]])]));
  assert.throws(()=>collection([{type:'Feature',geometry:{type:'Point',coordinates:[135,35]}}]));
  assert.throws(()=>prepareCollection({type:'FeatureCollection',crs:{name:'EPSG:3857'},features:[feature([square(135,35)])]}));
});
test('属性の欠落と国定公園種別を正しく扱う', () => {
  assert.equal(normalizeProperties(null).zoneName,'地種区分未収録');
  assert.equal(normalizeProperties({公園種別:'国定公園',区分:'第１種特別地域'}).zoneName,'第1種特別地域');
});
test('同梱実データを全件検証し、富士山と東京の判定を確認する', () => {
  const data=prepareCollection(JSON.parse(fs.readFileSync(new URL('../data/national-parks.geojson',import.meta.url))));
  assert.equal(data.features.length,15293);
  assert.equal(new Set(data.features.map(f=>f.properties.parkName)).size,35);
  const fuji=evaluateCollections([data],[138.727363,35.360626]);
  assert.ok(fuji.hits.some(h=>h.feature.properties.parkName==='富士箱根伊豆' && h.feature.properties.zoneName==='特別保護地区'));
  assert.equal(evaluateCollections([data],[139.767125,35.681236]).hits.length,0);
  // The former six-decimal rounding collapsed this tiny official polygon.
  const ring=data.features[11652].geometry.coordinates[0];
  assert.ok(new Set(ring.map(p=>p.join(','))).size>=3);
});

test('表示範囲で区域を絞り、表示用の簡略化でも判定用座標・穴・飛び地を保持する', async () => {
  const {featuresForMap} = await import('../src/map-geometry.js');
  const ring = [[135,35],[135.000001,35],[136,35],[136,36],[135,36],[135,35]];
  const data = collection([
    feature([ring, square(135.2,35.2,0.2)], {zoneName:'特別保護地区'}),
    {type:'Feature', properties:{}, geometry:{type:'MultiPolygon',coordinates:[[square(135,35)],[square(135.5,35.5,0.1)]]}},
    feature([square(140,40)]),
  ]);
  const original = structuredClone(data);
  const visible = featuresForMap([data], [134,34,137,37], 5);
  assert.equal(visible.length, 2);
  assert.equal(visible[0].geometry.coordinates[0].length, 5);
  assert.equal(geometryRelation(visible[0].geometry, [135.3,35.3]), 'outside');
  assert.equal(visible[1].geometry.coordinates.length, 2);
  assert.deepEqual(featuresForMap([data], [134,34,137,37], 12)[0].geometry, data.features[0].geometry);
  assert.deepEqual(data, original);
  assert.deepEqual(featuresForMap([data], [0,0,1,1], 5), []);
});
