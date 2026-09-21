// Display geometry only. Decisions always use the original, full-resolution rings.
export function featuresForMap(collections, bounds, zoom) {
  const [west, south, east, north] = bounds;
  const tolerance = 360 / (256 * 2 ** zoom) * 0.25;
  function ringForMap(ring) {
    if (zoom >= 12) return ring;
    const result = [ring[0]];
    for (let i = 1; i < ring.length - 1; i++) {
      const previous = result[result.length - 1];
      if (Math.hypot(ring[i][0] - previous[0], ring[i][1] - previous[1]) >= tolerance) result.push(ring[i]);
    }
    result.push(ring[ring.length - 1]);
    return result.length >= 4 ? result : ring;
  }
  const features = [];
  for (const collection of collections) for (const feature of collection.features) {
    const [w, s, e, n] = feature.bbox;
    if (e < west || w > east || n < south || s > north) continue;
    const geometry = feature.geometry;
    features.push({type: 'Feature', properties: {zoneName: feature.properties.zoneName}, geometry: {
      type: geometry.type,
      coordinates: geometry.type === 'Polygon'
        ? geometry.coordinates.map(ringForMap)
        : geometry.coordinates.map(polygon => polygon.map(ringForMap)),
    }});
  }
  return features;
}
