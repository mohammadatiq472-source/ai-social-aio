"""把单 JSON 城市切成 1km 的 compact JSON 瓦片（默认瓦片格式 v3）。

为什么不是烘焙二进制：实测 5×5（12,194 栋）baked LOD0 56.1MB，
compact JSON 只有 3.24MB（17×）。全深圳 20 万栋，baked 会到 ~900MB，
compact 只要 ~54MB；运行时按 3×3 片建几何，代价可控。
2026-11-21 补春茧两馆 + 腾讯滨海双塔后仍是 12,194 栋 / 32 片，实测 3.41MB
（多出来的是两处 OSM 轮廓的更细边界，不是新增体块数量）。

用法：
  python world/tools/build-city/split_tiles.py --scene nanshan
  python world/tools/build-city/split_tiles.py --scene nanshan --check
"""

import argparse
import json
import math
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORLD = HERE.parent.parent


def centroid(rings):
    ring = rings[0]
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def key_for(x, z, xmin, zmin, size):
    return f"{math.floor((x - xmin) / size)}_{math.floor((z - zmin) / size)}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scene', default='nanshan')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--tile', type=float, default=1000.0)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()

    input_path = args.input or (WORLD / 'assets/city' / f'{args.scene}.json')
    out_dir = args.out or (WORLD / 'assets/city' / args.scene)
    data = json.loads(input_path.read_text(encoding='utf-8'))
    xmin, zmin, xmax, zmax = data['bounds']
    size = args.tile

    def bounds_of(key):
        ix, iz = (int(part) for part in key.split('_'))
        return [xmin + ix * size, zmin + iz * size, xmin + (ix + 1) * size, zmin + (iz + 1) * size]

    if args.check:
        index = json.loads((out_dir / 'index.json').read_text(encoding='utf-8'))
        buildings = 0
        roads = 0
        for tile in index['tiles']:
            payload = json.loads((out_dir / tile['file']).read_text(encoding='utf-8'))
            buildings += len(payload['buildings'])
            roads += len(payload['roads'])
            assert payload['buildings'] or payload['roads'], tile['id']
        assert buildings == index['counts']['buildings'], (buildings, index['counts'])
        assert roads == index['counts']['roads'], (roads, index['counts'])
        print(json.dumps({'ok': True, 'tiles': len(index['tiles']), 'buildings': buildings, 'roads': roads}))
        return

    tiles = {}
    for building in data['buildings']:
        x, z = centroid(building['rings'])
        key = key_for(x, z, xmin, zmin, size)
        tiles.setdefault(key, {'buildings': [], 'roads': []})['buildings'].append(building)
    for road in data['roads']:
        mid = road['points'][len(road['points']) // 2]
        key = key_for(mid[0], mid[1], xmin, zmin, size)
        tiles.setdefault(key, {'buildings': [], 'roads': []})['roads'].append(road)

    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(out_dir / 'tiles', ignore_errors=True)
    (out_dir / 'tiles').mkdir(parents=True, exist_ok=True)

    entries = []
    total_bytes = 0
    for key in sorted(tiles):
        payload = tiles[key]
        if not payload['buildings'] and not payload['roads']:
            continue
        file = f'tiles/{key}.json'
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        (out_dir / 'tiles' / f'{key}.json').write_bytes(raw)
        total_bytes += len(raw)
        entries.append({
            'id': key,
            'bounds': [round(v, 2) for v in bounds_of(key)],
            'file': file,
            'counts': {'buildings': len(payload['buildings']), 'roads': len(payload['roads'])},
        })

    landmarks = []
    for landmark in [*(data.get('landmarks') or []), *([data['landmark']] if data.get('landmark') else [])]:
        building = next((b for b in data['buildings'] if b['id'] == landmark['id']), None)
        item = dict(landmark)
        if building:
            item['rings'] = building['rings']
        landmarks.append(item)

    index = {
        'version': 3,
        'scene': args.scene,
        'tileSize': size,
        'bounds': data['bounds'],
        'origin': data['origin'],
        'spawn': data['spawn'],
        'name': data['name'],
        **({'note': data['note']} if data.get('note') else {}),
        'attribution': data['attribution'],
        **({'landmark': data['landmark']} if data.get('landmark') else {}),
        **({'landmarks': landmarks} if landmarks else {}),
        **({'water': data['water']} if data.get('water') else {}),
        'street': data['street'],
        'counts': {'buildings': len(data['buildings']), 'roads': len(data['roads'])},
        'tiles': entries,
    }
    index_raw = json.dumps(index, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    (out_dir / 'index.json').write_bytes(index_raw)

    sizes = sorted((entry['id'], (out_dir / entry['file']).stat().st_size) for entry in entries)
    print(json.dumps({
        'scene': args.scene,
        'tiles': len(entries),
        'counts': index['counts'],
        'bytes': {'tiles': total_bytes, 'index': len(index_raw), 'total': total_bytes + len(index_raw)},
        'perTile': {'min': sizes[0], 'median': sizes[len(sizes) // 2], 'max': sizes[-1]},
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
