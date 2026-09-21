import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import shapefile from "shapefile";
import {computeBbox, prepareCollection} from '../src/geometry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "vendor", "nps");
const outputPath = path.join(root, "data", "national-parks.geojson");

const shpPath = path.join(sourceDir, "nps.shp");
const dbfPath = path.join(sourceDir, "nps.dbf");

if (!fs.existsSync(shpPath) || !fs.existsSync(dbfPath)) {
  console.error("vendor/nps/nps.shp と vendor/nps/nps.dbf が必要です。");
  process.exit(1);
}

const prj = fs.readFileSync(path.join(sourceDir, 'nps.prj'), 'utf8');
if (!prj.startsWith('GEOGCS[') || !/GCS_JGD_2000/.test(prj)) {
  throw new Error('想定外の座標系です。JGD2000の緯度経度データを確認してください。');
}
const source = await shapefile.open(shpPath, dbfPath, { encoding: "utf-8" });
const features = [];

for (;;) {
  const result = await source.read();
  if (result.done) break;
  features.push(normalizeFeature(result.value));
}

const geojson = {
  type: "FeatureCollection",
  name: "national-parks",
  generatedAt: new Date().toISOString(),
  sourceDate: null,
  sourceCRS: 'JGD2000 (EPSG:4612)',
  coordinateNote: '原座標を丸めず保持。WGS84との厳密な測地系・元期変換は未実施。',
  source: "https://www.biodic.go.jp/nps_nwp_nca_cz.html",
  features,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
prepareCollection(geojson);
fs.writeFileSync(outputPath, `${JSON.stringify(geojson)}\n`);
console.log(`Wrote ${features.length} features to ${path.relative(root, outputPath)}`);

function normalizeFeature(feature) {
  const geometry = feature.geometry;
  return {
    type: "Feature",
    properties: {
      ...feature.properties,
      parkType: '国立公園',
      parkName: feature.properties.NAME,
      zoneName: feature.properties.ZONE,
      source: "環境省・生物多様性センター 国立公園区域等 Shapeデータ",
    },
    bbox: geometry ? computeBbox(geometry.coordinates) : undefined,
    geometry,
  };
}
