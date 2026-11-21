"""把 8×8 公里的原始裁片按场景 bbox 裁成仓库里的小裁片（source/<prefix>-*）。

为什么单独一步：下载暂存区会被清掉；`source/` 才是可复现的输入（生成器只读 source/）。
`build_city.py` 自己也会把几何裁到 bbox，所以这里只做"丢弃与 bbox 不相交的要素"，
不改坐标——裁出来的文件和直接喂 8×8 文件得到的 CityData 逐字节一致，
但仓库里存的是 1/3 大小的文件。原始裁片从下载目录传路径进来，本工具不写死任何暂存路径。

用法（仓库根目录，路径换成实际下载目录）：
    python world/tools/build-city/crop_inputs.py \
        --globfp <下载目录>/bay-8x8-globfp.geojson \
        --osm <下载目录>/bay-8x8-osm.json \
        --landmarks <下载目录>/nanshan-landmarks.json --prefix nanshan-5x5 \
        --bbox 113.915 22.505 113.965 22.555

输出（写到 world/tools/build-city/source/）：
    <prefix>-globfp.geojson   GloBFP 建筑轮廓（只留与 bbox 相交的要素）
    <prefix>-osm.json         Overpass 元素（道路 + 海岸线 + 水面，只留与 bbox 相交的）
    <prefix>-landmarks.json   地标轮廓（只留与 bbox 相交的）
"""

import argparse
import json
from pathlib import Path

from shapely.geometry import LineString, Polygon, box, shape

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / 'source'


def intersects(geometry_bbox, crop):
    return geometry_bbox.intersects(crop)


def crop_geojson(payload, crop):
    keep = []
    for feature in payload['features']:
        if shape(feature['geometry']).intersects(crop):
            keep.append(feature)
    return {'type': 'FeatureCollection', 'features': keep}


def crop_overpass(payload, crop):
    keep = []
    for element in payload.get('elements', []):
        points = element.get('geometry') or []
        if not points:
            continue
        line = LineString([(point['lon'], point['lat']) for point in points])
        if line.intersects(crop):
            keep.append(element)
    result = {key: value for key, value in payload.items() if key != 'elements'}
    result['elements'] = keep
    return result


def crop_landmark_ways(payload, crop):
    """地标是 Polygon 的 Overpass 元素：按轮廓与 bbox 相交筛选。"""
    keep = []
    for element in payload.get('elements', []):
        points = element.get('geometry') or []
        if len(points) < 3:
            continue
        polygon = Polygon([(point['lon'], point['lat']) for point in points])
        if polygon.intersects(crop):
            keep.append(element)
    return {'version': payload.get('version', 0.6), 'generator': payload.get('generator'),
            'elements': keep}


def write(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return path.stat().st_size


def main(argv=None):
    parser = argparse.ArgumentParser(description='把原始城市裁片按 bbox 裁成仓库输入')
    parser.add_argument('--globfp', type=Path, required=True)
    parser.add_argument('--osm', type=Path, required=True)
    parser.add_argument('--landmarks', type=Path)
    parser.add_argument('--prefix', required=True, help='输出文件名前缀，例如 nanshan-5x5')
    parser.add_argument('--bbox', type=float, nargs=4, required=True,
                        metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'))
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    crop = box(*args.bbox)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    globfp = json.loads(args.globfp.read_text(encoding='utf-8'))
    osm = json.loads(args.osm.read_text(encoding='utf-8'))
    clipped_globfp = crop_geojson(globfp, crop)
    clipped_osm = crop_overpass(osm, crop)

    report = {
        'globfp': {'features': len(globfp['features']),
                   'kept': len(clipped_globfp['features']),
                   'bytes': write(output / f'{args.prefix}-globfp.geojson', clipped_globfp)},
        'osm': {'elements': len(osm['elements']),
                'kept': len(clipped_osm['elements']),
                'roads': sum(1 for e in clipped_osm['elements']
                             if 'highway' in (e.get('tags') or {})),
                'water': sum(1 for e in clipped_osm['elements']
                             if (e.get('tags') or {}).get('natural') in ('water', 'coastline')),
                'bytes': write(output / f'{args.prefix}-osm.json', clipped_osm)},
    }
    if args.landmarks:
        landmarks = json.loads(args.landmarks.read_text(encoding='utf-8'))
        clipped_landmarks = crop_landmark_ways(landmarks, crop)
        missing = [element['id'] for element in landmarks['elements']
                   if element not in clipped_landmarks['elements']]
        if missing:
            raise SystemExit(f'地标被 bbox 裁掉了：{missing}')
        report['landmarks'] = {'elements': len(landmarks['elements']),
                               'kept': len(clipped_landmarks['elements']),
                               'bytes': write(output / f'{args.prefix}-landmarks.json',
                                              clipped_landmarks)}
    print(json.dumps({'prefix': args.prefix, 'bbox': args.bbox, 'output': str(output),
                      **report}, ensure_ascii=False))


if __name__ == '__main__':
    main()
