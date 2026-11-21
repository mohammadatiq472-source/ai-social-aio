"""下载一个区的原始输入（在能访问 Overpass 的机器上跑），产物交给 crop_inputs.py 裁进 source/。

管线：fetch_region.py（下载，原始文件放下载暂存区，不进 git）
      → crop_inputs.py（按场景 bbox 裁成 source/<prefix>-*）
      → build_city.py --scene <区> → split_tiles.py --scene <区>

用法（仓库根目录；输出目录用 tmp/ 或任何下载暂存区）：
    python world/tools/build-city/fetch_region.py osm --bbox 113.86 22.53 113.91 22.58 --out tmp/baoan-raw
    python world/tools/build-city/fetch_region.py globfp --bbox 113.86 22.53 113.91 22.58 \
        --input <3D-GloBFP 官方分块>.geojson --out tmp/baoan-raw

3D-GloBFP 走 Zenodo 官方源（https://zenodo.org/records/15487037）手动下载分块，本脚本只按 bbox 过滤；
不从二手站点批量扒（CONTRIBUTING §6）。Overpass 单次范围太大会超时：按 ≤5km 分块下载。
"""

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = 'https://overpass-api.de/api/interpreter'


def overpass_query(bbox):
    """bbox=(lon_min, lat_min, lon_max, lat_max) → Overpass QL。Overpass 的框顺序是 (南, 西, 北, 东)。

    取的要素与 crop_inputs.py / build_city.py 的消费口径一致：道路、海岸线、水面；
    另带 landuse，供后续建筑分类（城中村/厂房/住宅）使用。
    大水面（深圳湾、茅洲河口、水库）在 OSM 里是 multipolygon relation，`out geom` 把坐标放在
    members[].geometry；下载后由 flatten_relations() 摊平成带顶层 geometry 的 way，下游才不会丢。
    """
    s, w, n, e = bbox[1], bbox[0], bbox[3], bbox[2]
    b = f'({s},{w},{n},{e})'
    return (f'[out:json][timeout:300];('
            f'way["highway"]{b};'
            f'way["natural"="coastline"]{b};way["natural"="water"]{b};'
            f'way["waterway"="riverbank"]{b};way["landuse"]{b};'
            f'relation["natural"="water"]{b};relation["waterway"="riverbank"]{b};'
            f');out geom;')


def flatten_relations(payload):
    """把 multipolygon relation 摊平成 way 形状的元素：每个带 geometry 的 outer/inner 成员一条。

    下游（crop_inputs.crop_overpass、build_city）只读顶层 `geometry`；relation 的坐标在
    `members[].geometry`，不摊平就会被静默丢弃。摊平后的元素：
      type='way'，id=成员 way 的 ref，tags=relation 的 tags + aio:relation（relation id）+ aio:role，
    inner 环（岛）保留 role，消费方拼面时据此挖洞，不会把岛当水面。
    没有任何可用成员几何的 relation 原样保留并计入 dropped，由调用方报告，而不是悄悄消失。
    """
    elements, dropped = [], []
    for element in payload.get('elements', []):
        if element.get('type') != 'relation':
            elements.append(element)
            continue
        parts = [m for m in element.get('members', [])
                 if m.get('type') == 'way' and len(m.get('geometry') or []) >= 2]
        if not parts:
            dropped.append(element.get('id'))
            continue
        for member in parts:
            tags = dict(element.get('tags') or {})
            tags.pop('type', None)
            tags['aio:relation'] = str(element['id'])
            tags['aio:role'] = member.get('role') or 'outer'
            elements.append({'type': 'way', 'id': member['ref'], 'tags': tags,
                             'geometry': [{'lat': p['lat'], 'lon': p['lon']} for p in member['geometry']]})
    result = {key: value for key, value in payload.items() if key != 'elements'}
    result['elements'] = elements
    return result, dropped


def fetch_osm(bbox, out):
    body = urllib.parse.urlencode({'data': overpass_query(bbox)}).encode()
    request = urllib.request.Request(OVERPASS, data=body, headers={'User-Agent': 'aio-world-build-city'})
    with urllib.request.urlopen(request, timeout=600) as response:
        data = json.loads(response.read())
    if data.get('remark'):
        raise SystemExit(f"Overpass 返回 remark（多半超时，请缩小 bbox 分块）：{data['remark']}")
    data, dropped = flatten_relations(data)
    if dropped:
        raise SystemExit(f'这些水域 relation 没有成员几何，无法摊平：{dropped}')
    path = out / 'osm.json'
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return path, len(data.get('elements', []))


def clip_globfp(bbox, source, out):
    from shapely.geometry import box, shape
    region = box(*bbox)
    raw = json.loads(Path(source).read_text(encoding='utf-8'))
    kept = [f for f in raw['features'] if shape(f['geometry']).intersects(region)]
    path = out / 'globfp.geojson'
    path.write_text(json.dumps({'type': 'FeatureCollection', 'features': kept}, ensure_ascii=False), encoding='utf-8')
    return path, len(kept)


def main(argv=None):
    parser = argparse.ArgumentParser(description='下载/过滤一个区的原始输入（不进 git）')
    parser.add_argument('step', choices=['osm', 'globfp'])
    parser.add_argument('--bbox', nargs=4, type=float, required=True, metavar=('LON_MIN', 'LAT_MIN', 'LON_MAX', 'LAT_MAX'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--input', type=Path, help='globfp：官方分块 GeoJSON')
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    if args.step == 'osm':
        path, count = fetch_osm(tuple(args.bbox), args.out)
    else:
        if not args.input:
            raise SystemExit('globfp 需要 --input 官方分块')
        path, count = clip_globfp(tuple(args.bbox), args.input, args.out)
    print(json.dumps({'step': args.step, 'output': str(path), 'count': count}, ensure_ascii=False))


if __name__ == '__main__':
    main()
