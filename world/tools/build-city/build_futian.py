import argparse
import hashlib
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import transform, unary_union

HERE = Path(__file__).resolve().parent
WORLD = HERE.parent.parent
ORIGIN = (114.054, 22.540)
BBOX = (114.044, 22.531, 114.064, 22.549)
LATITUDE = math.radians(ORIGIN[1])
ELLIPSOID = 1 - 0.0066943799901413165 * math.sin(LATITUDE) ** 2
SCALE_X = 6378137 / math.sqrt(ELLIPSOID) * math.cos(LATITUDE) * math.pi / 180
SCALE_Z = 6378137 * (1 - 0.0066943799901413165) / ELLIPSOID ** 1.5 * math.pi / 180
LANDMARK_ID = 'way/535860513'
HEIGHT_SOURCE = 'https://www.skyscrapercenter.com/shenzhen/ping-an-finance-center/54'


def local(lon, lat, z=None):
    return (lon - ORIGIN[0]) * SCALE_X, -(lat - ORIGIN[1]) * SCALE_Z


def polygons(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry]
    return [p for p in getattr(geometry, 'geoms', []) if p.geom_type == 'Polygon']


def ring(coordinates):
    return [[round(x, 2), round(z, 2)] for x, z in list(coordinates)[:-1]]


def build(source):
    globfp = json.loads((source / 'futian-globfp.geojson').read_text(encoding='utf-8'))
    osm = json.loads((source / 'futian-osm.geojson').read_text(encoding='utf-8'))
    roads_source = json.loads((source / 'futian-roads.json').read_text(encoding='utf-8'))
    if roads_source.get('remark'):
        raise ValueError(roads_source['remark'])
    boundary = transform(local, box(*BBOX))
    landmark = next(f for f in osm['features'] if f['id'] == LANDMARK_ID)
    assert landmark['properties']['wikidata'] == 'Q1077308'
    tower = transform(local, shape(landmark['geometry']))
    buildings = []
    rejected = 0
    cut = 0
    seen = set()
    for feature in globfp['features']:
        height = feature['properties']['height_m']
        if not math.isfinite(height) or height <= 0:
            raise ValueError(f"Invalid height: {feature['id']}")
        geometry = transform(local, shape(feature['geometry'])).intersection(boundary)
        if geometry.intersects(tower):
            cut += 1
            geometry = geometry.difference(tower)
        for index, polygon in enumerate(polygons(geometry)):
            polygon = polygon.simplify(0.25, preserve_topology=True)
            if polygon.area < 4:
                rejected += 1
                continue
            rings = [ring(polygon.exterior.coords), *[ring(h.coords) for h in polygon.interiors]]
            rounded = Polygon(rings[0], rings[1:])
            if not rounded.is_valid or rounded.area < 4:
                raise ValueError(f"Rounding invalidates {feature['id']}")
            key = rounded.normalize().wkb
            if key in seen:
                rejected += 1
                continue
            seen.add(key)
            buildings.append({'id': f"{feature['id']}:{index}", 'height': round(height, 2),
                              'heightSource': 'estimate', 'rings': rings})
    buildings.append({'id': LANDMARK_ID, 'name': '平安金融中心', 'height': 599.1,
                      'heightSource': 'ctbuh', 'rings': [ring(tower.exterior.coords)]})
    widths = {'primary': 14, 'secondary': 12, 'tertiary': 10, 'residential': 7,
              'unclassified': 7, 'service': 4, 'living_street': 5, 'pedestrian': 5,
              'footway': 2, 'cycleway': 2, 'path': 2}
    roads = []
    for item in roads_source['elements']:
        tags = item.get('tags', {})
        kind = tags.get('highway')
        if kind not in widths or tags.get('layer', '0') != '0' or tags.get('tunnel', 'no') != 'no' or tags.get('bridge', 'no') != 'no':
            continue
        points = [local(p['lon'], p['lat']) for p in item.get('geometry', [])]
        if len(points) < 2:
            continue
        geometry = LineString(points).intersection(boundary)
        lines = [geometry] if geometry.geom_type == 'LineString' else list(getattr(geometry, 'geoms', []))
        for index, line in enumerate(lines):
            if line.geom_type != 'LineString' or line.length < 1:
                continue
            roads.append({'id': f"way/{item['id']}:{index}", 'width': widths[kind],
                          'walkway': kind in ['footway', 'cycleway', 'path', 'pedestrian'],
                          'points': [[round(x, 2), round(z, 2)] for x, z in line.coords]})
    occupied = unary_union([Polygon(b['rings'][0], b['rings'][1:]) for b in buildings])
    paving = unary_union([box(-334, 343, -291, 430), box(-299, 300, -291, 500)]).difference(occupied.buffer(0.4))
    paving_rings = [[ring(p.exterior.coords), *[ring(h.coords) for h in p.interiors]] for p in polygons(paving) if p.area > 2]
    placements = []
    for kind, x, zs in [('tree', -324, [351, 398, 423]), ('tree', -296, [313, 357, 409, 455, 487]),
                        ('lamp', -294, [329, 379, 439, 479]), ('bench', -319, [352, 410]), ('sign', -302, [353])]:
        for z in zs:
            clearance_needed = 3 if kind == 'tree' else 1.8 if kind == 'bench' else 0.7
            if Point(x, z).distance(occupied) > clearance_needed and paving.covers(Point(x, z)):
                placements.append({'kind': kind, 'x': x, 'z': z, 'yaw': 0})
    sx, sz = local(114.05094, 22.53664)
    spawn = [round(sx, 2), 0.12, round(sz, 2)]
    clearance = min(Point(spawn[0], spawn[2]).distance(Polygon(b['rings'][0], b['rings'][1:])) for b in buildings)
    assert clearance > 2, f'Spawn clearance is only {clearance} m'
    return {
        'version': 1, 'name': '福田 CBD · 街区原型', 'origin': list(ORIGIN),
        'bounds': [round(v, 2) for v in boundary.bounds], 'spawn': spawn,
        'buildings': buildings, 'roads': roads,
        'street': {'pavingHeight': 0.12, 'paving': paving_rings, 'placements': placements},
        'attribution': [
            {'label': '建筑轮廓及估高：3D-GloBFP / Che et al. 2024 · CC BY 4.0', 'url': 'https://zenodo.org/records/15487037'},
            {'label': '路网及地标轮廓：OpenStreetMap 贡献者 · ODbL 1.0', 'url': 'https://www.openstreetmap.org/copyright'},
            {'label': '平安金融中心建筑高度：CTBUH 599.1m', 'url': HEIGHT_SOURCE},
        ],
        'provenance': {
            'globfpNominalYear': 2020, 'osmSnapshot': roads_source['osm3s']['timestamp_osm_base'],
            'landmarkEvidence': 'CTBUH indexed building record + OSM wikidata Q1077308; page fetch returned 403. Architectural height, not an exact roof model.',
            'inputsSha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(source.iterdir()) if p.is_file()},
            'note': 'Extruded massing only. Estimates outside the named landmark are not surveyed heights. Surface roads use inferred widths; no terrain or grade separation. Combined derived data retains ODbL obligations.',
        },
        'cleaning': {'minimumAreaM2': 4, 'simplifyToleranceM': 0.25, 'discardedSmallOrDuplicateParts': rejected,
                     'globfpFeaturesClippedByLandmark': cut, 'spawnClearanceM': round(clearance, 2)},
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=HERE / 'source')
    parser.add_argument('--output', type=Path, default=WORLD / 'assets/city/futian.json')
    args = parser.parse_args()
    data = build(args.source)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    print(json.dumps({'buildings': len(data['buildings']), 'roads': len(data['roads']),
                      'bytes': args.output.stat().st_size, 'cleaning': data['cleaning']}, ensure_ascii=False))
