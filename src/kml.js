import {computeBbox, normalizeProperties} from './geometry.js';

export function kmlToGeoJson(text, fileName) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const parserError = firstByLocalName(document, "parsererror");
  if (parserError) {
    throw new Error(parserError.textContent || "Invalid KML");
  }

  const placemarks = allByLocalName(document, "Placemark");
  const features = placemarks.flatMap((placemark) => placemarkToFeatures(placemark, fileName));

  if (!features.length) {
    throw new Error(
      `${placemarks.length.toLocaleString()}件のPlacemarkを確認しましたが、Polygon座標が見つかりませんでした。`,
    );
  }

  return {
    type: "FeatureCollection",
    name: fileName,
    features,
  };
}

function placemarkToFeatures(placemark, fileName) {
  const properties = kmlProperties(placemark, fileName);
  return allByLocalName(placemark, "Polygon")
    .map((polygon) => {
      const coordinates = polygonToCoordinates(polygon);
      if (!coordinates) throw new Error("Polygonの外周がありません。");
      return {
        type: "Feature",
        properties,
        bbox: computeBbox(coordinates),
        geometry: {
          type: "Polygon",
          coordinates,
        },
      };
    });
}

function kmlProperties(placemark, fileName) {
  const dataProperties = Object.fromEntries(
    allByLocalName(placemark, "Data").map((data) => [
      data.getAttribute("name"),
      firstByLocalName(data, "value")?.textContent?.trim() || "",
    ]),
  );
  const simpleDataProperties = Object.fromEntries(
    allByLocalName(placemark, "SimpleData").map((data) => [
      data.getAttribute("name"),
      data.textContent.trim(),
    ]),
  );
  const name = directChildByLocalName(placemark, "name")?.textContent?.trim() || fileName;

  const all = {...dataProperties, ...simpleDataProperties};
  const normalized = normalizeProperties(all);
  return {
    ...all,
    ...normalized,
    parkName: normalized.parkName === "公園名未設定" ? name : normalized.parkName,
    zoneName: normalized.zoneName,
    source: normalized.source || fileName,
  };
}

function polygonToCoordinates(polygon) {
  const outerBoundary = firstByLocalName(polygon, "outerBoundaryIs");
  const outerRing = ringCoordinates(firstByLocalName(outerBoundary, "coordinates"));
  if (!outerRing) throw new Error("Polygonの外周がありません。");

  const innerRings = allByLocalName(polygon, "innerBoundaryIs")
    .map((innerBoundary) => ringCoordinates(firstByLocalName(innerBoundary, "coordinates")));

  return [outerRing, ...innerRings];
}

function allByLocalName(root, localName) {
  if (!root) return [];
  return [...root.getElementsByTagName("*")].filter((element) => element.localName === localName);
}

function firstByLocalName(root, localName) {
  return allByLocalName(root, localName)[0] || null;
}

function directChildByLocalName(root, localName) {
  return [...root.children].find((element) => element.localName === localName) || null;
}

function ringCoordinates(coordinatesElement) {
  if (!coordinatesElement?.textContent?.trim()) throw new Error("空の座標列です。");
  const coordinates = coordinatesElement.textContent
    .trim()
    .split(/\s+/)
    .map((position) => {
      const parts = position.split(',');
      if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) throw new Error('KML座標が不正です。');
      const [first, second] = parts.map(Number);
      if (!Number.isFinite(first) || !Number.isFinite(second)) throw new Error("KML座標が不正です。");
      return normalizeKmlPosition(first, second);
    });

  if (coordinates.length < 3) throw new Error("リングには3頂点以上必要です。");
  return closeRing(coordinates);
}

function closeRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function normalizeKmlPosition(lng, lat) {
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    throw new Error("KMLは経度,緯度の順序で指定してください。座標の自動入替は行いません。");
  }
  return [lng, lat];
}
