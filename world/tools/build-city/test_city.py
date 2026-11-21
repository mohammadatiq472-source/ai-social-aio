"""城市数据管线测试：福田样例 + 南山样区共用一份生成器时的合同。

覆盖：
- 两个 scene 可复现（重跑 build_scene 等于仓库里的 assets/city/*.json）
- 建筑几何合法（有效多边形、面积/高度下限）、道路点在 bounds 内
- spawn 净空 >2m、y 跟随真实地面（有铺装=铺装顶 0.12，无铺装=0）、
  8 个方向 3–60m 内有楼墙（与浏览器 raycast 口径一致）
- 南山 v3：5×5km（前海东/南山中心/后海/深圳湾）、12,194 建筑 + 4,558 段路、春笋唯一
  ctbuh 392.5m、水面在南边界以南、沿 spawn 附近主路的 40–60 个树/灯；福田仍是 1,230/809
  且字节不变。春茧两馆（OSM way/665408865、665408866）与腾讯滨海双塔（way/694152192、
  694152193）按 `extraBuildings` 当**普通建筑**加入（高度取 OSM 标签 40 / 245.8 / 194.8m，
  `heightSource='estimate'`），不进 `landmarks`；腾讯滨海处与 GloBFP 重叠的 4 栋整栋替换、
  2 栋裁剪，所以建筑总数仍是 12,194。
- `assets/city/nanshan/` 32 片 compact JSON 瓦片与单 JSON 口径一致（counts 相加 = 单 JSON
  的 buildings/roads，每片 payload counts 与 index 条目对齐，4 个补充建筑各落在唯一一片）
- 福田有唯一地标且收分曲线与 kit 一致
- 署名保留 CC BY 4.0 + ODbL + CTBUH；输入裁片留在仓库、不依赖 tmp/

跑法（仓库根目录）：
    python world/tools/build-city/test_city.py
"""

import json
import hashlib
import math
import unittest
from pathlib import Path

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep

import build_city
from build_city import BBOX, HERE, ORIGIN, SCENES, WORLD, frame, local

ASSETS = WORLD / 'assets' / 'city'
SCENE_NAMES = build_city.SCENE_NAMES
DIRECTIONS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


def polygons(buildings):
    return [Polygon(building['rings'][0], building['rings'][1:]) for building in buildings]


def stored(scene):
    return json.loads((ASSETS / SCENES[scene]['output']).read_text(encoding='utf-8'))


def wall_hit(prepared, x, z, ux, uz, minimum=3.0, maximum=60.0, step=0.5):
    """与 build_city.find_spawn、verify-nanshan-city.py 相同的"近墙"口径。"""
    distance = minimum
    while distance <= maximum:
        if prepared.contains(Point(x + ux * distance, z + uz * distance)):
            return distance
        distance += step
    return None


class CityPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = {name: build_city.build_scene(name) for name in SCENE_NAMES}
        cls.polygons = {name: polygons(data['buildings']) for name, data in cls.data.items()}

    # --- 可复现与输入 ---

    def test_artifacts_are_reproducible(self):
        for name in SCENE_NAMES:
            self.assertEqual(self.data[name], stored(name), name)

    def test_inputs_live_in_the_repository(self):
        for name in SCENE_NAMES:
            files = sorted(SCENES[name]['inputs'].values())
            digests = {}
            for filename in files:
                path = HERE / 'source' / filename
                self.assertTrue(path.is_file(), f'{name} 输入缺失: {path}')
                digests[filename] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(self.data[name]['provenance']['inputsSha256'], digests, name)

    def test_no_tmp_dependency(self):
        for name in SCENE_NAMES:
            payload = json.dumps(self.data[name], ensure_ascii=False)
            self.assertNotIn('city-recon', payload, name)
        source = Path(build_city.__file__).read_text(encoding='utf-8')
        self.assertNotIn('city-recon', source)
        self.assertNotIn("'tmp/", source)

    def test_provenance_tracks_road_snapshot(self):
        for name in SCENE_NAMES:
            roads = json.loads((HERE / 'source' / SCENES[name]['inputs']['roads']).read_text(encoding='utf-8'))
            self.assertEqual(self.data[name]['provenance']['osmSnapshot'],
                             roads['osm3s']['timestamp_osm_base'], name)
            self.assertEqual(self.data[name]['provenance']['globfpNominalYear'], 2020, name)

    # --- 几何 ---

    def test_building_geometry_is_valid(self):
        for name, data in self.data.items():
            self.assertTrue(all(p.is_valid for p in self.polygons[name]), name)
            self.assertTrue(all(p.area >= 4 for p in self.polygons[name]), name)
            self.assertTrue(all(0 < building['height'] <= 1000 for building in data['buildings']), name)
            self.assertEqual(len({building['id'] for building in data['buildings']}), len(data['buildings']), name)
            for building in data['buildings']:
                self.assertIn(building['heightSource'], ('estimate', 'ctbuh'), name)
                self.assertTrue(1 <= len(building['rings']) <= 100, name)
                for ring in building['rings']:
                    self.assertGreaterEqual(len(ring), 3, name)
                    self.assertLessEqual(len(ring), 5000, name)

    def test_road_points_are_inside_bounds(self):
        for name, data in self.data.items():
            xmin, zmin, xmax, zmax = data['bounds']
            for road in data['roads']:
                self.assertGreaterEqual(len(road['points']), 2, (name, road['id']))
                self.assertTrue(0 < road['width'] <= 50, (name, road['id']))
                for x, z in road['points']:
                    self.assertTrue(xmin <= x <= xmax and zmin <= z <= zmax, (name, road['id'], x, z))

    def test_walkway_widths_follow_the_shared_table(self):
        for name, data in self.data.items():
            for road in data['roads']:
                if road['walkway']:
                    self.assertIn(road['width'], (2, 5), (name, road['id']))
                else:
                    self.assertGreaterEqual(road['width'], 4, (name, road['id']))

    # --- 两个 scene 的明确差异 ---

    def test_futian_counts_and_height_do_not_regress(self):
        data = self.data['futian']
        self.assertEqual(len(data['buildings']), 1230)
        self.assertEqual(len(data['roads']), 809)
        towers = [building for building in data['buildings'] if building['heightSource'] == 'ctbuh']
        self.assertEqual(len(towers), 1)
        self.assertEqual(towers[0]['id'], 'way/535860513')
        self.assertEqual(towers[0]['height'], 599.1)

    def test_futian_landmark_matches_kit_profile(self):
        data = self.data['futian']
        landmark = data['landmark']
        self.assertEqual(landmark['id'], 'way/535860513')
        self.assertEqual(landmark['name'], '平安金融中心')
        self.assertEqual(landmark['height'], 599.1)
        # 必须与 world/src/city/landmark.ts 的 PING_AN_PROFILE 逐点一致（kit 收分曲线靠它）。
        self.assertEqual(landmark['profile'], [[0, 1], [12, 1], [60, 0.985], [400, 0.86],
                                               [540, 0.76], [565, 0.66], [599.1, 0.025]])
        heights = [point[0] for point in landmark['profile']]
        self.assertEqual(heights, sorted(set(heights)))
        tower = next(p for b, p in zip(data['buildings'], self.polygons['futian'])
                     if b['heightSource'] == 'ctbuh')
        for building, polygon in zip(data['buildings'], self.polygons['futian']):
            if building['id'] == landmark['id']:
                continue
            self.assertLess(polygon.intersection(tower).area, 0.5, building['id'])

    def test_futian_street_fields_feed_kit(self):
        street = self.data['futian']['street']
        self.assertEqual(street['pavingHeight'], 0.12)
        # 福田出生点在铺装上：spawn.y 必须等于铺装顶（硬规则，不许改成 0）。
        self.assertEqual(self.data['futian']['spawn'][1], 0.12)
        self.assertEqual(street['canopy'], {'x': -333.1, 'z': 372.08, 'width': 7, 'depth': 16,
                                            'height': 4.2, 'label': '平安金融中心'})
        signs = [placement for placement in street['placements'] if placement['kind'] == 'sign']
        self.assertEqual([placement['label'] for placement in signs], ['福田 / 益田路'])
        # kit.ts 不读 street.signs；福田没有独立路牌，所以不写空数组冒充字段。
        self.assertNotIn('signs', street)
        self.assertEqual(len(street['paving']), 1)
        paving = Polygon(street['paving'][0][0], street['paving'][0][1:])
        self.assertTrue(paving.is_valid)
        self.assertGreater(paving.area, 2)
        for placement in street['placements']:
            point = Point(placement['x'], placement['z'])
            self.assertTrue(paving.covers(point), placement)
            required = 3 if placement['kind'] == 'tree' else 1.8 if placement['kind'] == 'bench' else 0.7
            self.assertGreater(min(point.distance(p) for p in self.polygons['futian']), required, placement)

    def test_futian_artifact_bytes_do_not_change(self):
        # 福田是已完成验收的样板街：南山 v2 改生成器时，福田数据字节必须原样不动。
        raw = (ASSETS / SCENES['futian']['output']).read_bytes()
        self.assertEqual(len(raw), 358167)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         '5a736272588ddb5b09c891e32cd0547d494e00dac1efa7c85a9d9b189fd06ef7')

    def test_nanshan_is_the_5x5_sample(self):
        data = self.data['nanshan']
        self.assertEqual(SCENES['nanshan']['bbox'], (113.915, 22.505, 113.965, 22.555))
        self.assertEqual(data['origin'], [113.940, 22.530])
        width = data['bounds'][2] - data['bounds'][0]
        height = data['bounds'][3] - data['bounds'][1]
        # bbox 是 0.05°×0.05°：在这个纬度是 5,143.7m × 5,536.9m，不是几何的 5.0×5.0km。
        self.assertAlmostEqual(width, 5143.7, delta=0.5)
        self.assertAlmostEqual(height, 5536.88, delta=0.5)
        self.assertEqual(len(data['buildings']), 12194)
        self.assertEqual(len(data['roads']), 4558)
        # 扩张而不是换位置：上一版 3.1×4.4km 样区（含更早的 2×2km）必须完整包含。
        to_local = frame(data['origin'])
        for west, south, east, north in ((113.930, 22.512, 113.960, 22.552),
                                         (113.937, 22.533, 113.957, 22.551)):
            for lon in (west, east):
                for lat in (south, north):
                    x, z = to_local(lon, lat)
                    self.assertTrue(data['bounds'][0] < x < data['bounds'][2], (lon, lat))
                    self.assertTrue(data['bounds'][1] < z < data['bounds'][3], (lon, lat))

    def test_nanshan_landmark_is_chun_sun(self):
        data = self.data['nanshan']
        # 福田的单数 landmark 字段不属于南山；南山只用 landmarks 列表。
        self.assertNotIn('landmark', data)
        self.assertEqual(len(data['landmarks']), 1)
        landmark = data['landmarks'][0]
        self.assertEqual(landmark['id'], 'way/529272473')
        self.assertEqual(landmark['name'], '春笋（中国华润大厦）')
        self.assertEqual(landmark['height'], 392.5)
        self.assertEqual(landmark['profile'], [[0, 1], [20, 0.99], [100, 0.95], [200, 0.86],
                                               [300, 0.70], [360, 0.45], [392.5, 0.08]])
        heights = [point[0] for point in landmark['profile']]
        self.assertEqual(heights, sorted(set(heights)))
        towers = [(building, polygon) for building, polygon in zip(data['buildings'], self.polygons['nanshan'])
                  if building['heightSource'] == 'ctbuh']
        self.assertEqual([building['id'] for building, _ in towers], ['way/529272473'])
        self.assertEqual(towers[0][0]['height'], 392.5)
        tower = towers[0][1]
        for building, polygon in zip(data['buildings'], self.polygons['nanshan']):
            if building['id'] == landmark['id']:
                continue
            self.assertLess(polygon.intersection(tower).area, 0.5, building['id'])

    def test_nanshan_spring_cocoon_is_ordinary_massing(self):
        data = self.data['nanshan']
        landmark_ids = {landmark['id'] for landmark in data['landmarks']}
        buildings = {building['id']: building for building in data['buildings']}
        # OSM building=stadium 轮廓 + OSM height=40：当普通体块，绝不进 landmarks
        # （landmark 会按 profile 收分并加竖向构件，体育馆是壳体）。
        for building_id, name, area in (('way/665408865', '深圳湾体育馆', 19275.7),
                                        ('way/665408866', '深圳湾游泳馆', 13176.4)):
            self.assertIn(building_id, buildings)
            building = buildings[building_id]
            self.assertNotIn(building_id, landmark_ids)
            self.assertIn(name, building['name'])
            self.assertEqual(building['height'], 40)
            self.assertEqual(building['heightSource'], 'estimate')
            polygon = Polygon(building['rings'][0], building['rings'][1:])
            self.assertTrue(polygon.is_valid)
            self.assertAlmostEqual(polygon.area, area, delta=1.0)
        footprints = [Polygon(buildings[i]['rings'][0], buildings[i]['rings'][1:])
                      for i in ('way/665408865', 'way/665408866')]
        for building, polygon in zip(data['buildings'], self.polygons['nanshan']):
            if building['id'] in ('way/665408865', 'way/665408866'):
                continue
            for footprint in footprints:
                # 与 GloBFP 无重复：春茧轮廓上不许压着别的体块（GloBFP 本来就没有）。
                self.assertLess(polygon.intersection(footprint).area, 0.5, building['id'])

    def test_nanshan_tencent_towers_are_ordinary_massing(self):
        data = self.data['nanshan']
        landmark_ids = {landmark['id'] for landmark in data['landmarks']}
        buildings = {building['id']: building for building in data['buildings']}
        # 任务书按 name~"腾讯|Tencent|滨海" 查不到：OSM 把双塔命名成"南塔/北塔"
        # （way/694152192 / 694152193，场地 way/737149477 name=腾讯滨海大厦）。
        for building_id, tower, height, area in (('way/694152192', '南塔', 245.8, 3043.2),
                                                 ('way/694152193', '北塔', 194.8, 2395.9)):
            self.assertIn(building_id, buildings)
            building = buildings[building_id]
            self.assertNotIn(building_id, landmark_ids)
            self.assertIn('腾讯滨海大厦', building['name'])
            self.assertIn(tower, building['name'])
            self.assertEqual(building['height'], height)
            self.assertEqual(building['heightSource'], 'estimate')
            polygon = Polygon(building['rings'][0], building['rings'][1:])
            self.assertTrue(polygon.is_valid)
            self.assertAlmostEqual(polygon.area, area, delta=1.0)
        footprints = [Polygon(buildings[i]['rings'][0], buildings[i]['rings'][1:])
                      for i in ('way/694152192', 'way/694152193')]
        for building, polygon in zip(data['buildings'], self.polygons['nanshan']):
            if building['id'] in ('way/694152192', 'way/694152193'):
                continue
            for footprint in footprints:
                # GloBFP 在双塔处只给 71–104m 且轮廓错位：重叠部分已替换/裁剪，不许再叠。
                self.assertLess(polygon.intersection(footprint).area, 0.5, building['id'])
        replaced = {'globfp:2265:33960:0', 'globfp:2265:33961:0',
                    'globfp:2265:33962:0', 'globfp:2265:33995:0'}
        self.assertFalse(replaced & set(buildings), '被替换的 GloBFP 体量不该留在数据里')
        cleaning = data['cleaning']
        self.assertEqual(cleaning['globfpFeaturesReplacedByExtraBuildings'], 4)
        self.assertEqual(cleaning['globfpFeaturesClippedByExtraBuildings'], 2)
        # 春笋地标本身没有裁到任何 GloBFP 体量（两条补充建筑线各记各的）。
        self.assertEqual(cleaning['globfpFeaturesClippedByLandmark'], 0)

    def test_nanshan_tiles_match_the_single_json(self):
        data = self.data['nanshan']
        tile_dir = ASSETS / 'nanshan'
        index = json.loads((tile_dir / 'index.json').read_text(encoding='utf-8'))
        self.assertEqual(index['version'], 3)
        self.assertEqual(index['tileSize'], 1000.0)
        self.assertEqual(index['counts'],
                         {'buildings': len(data['buildings']), 'roads': len(data['roads'])})
        self.assertEqual(index['bounds'], data['bounds'])
        self.assertEqual(index['spawn'], data['spawn'])
        self.assertEqual(len(index['tiles']), 32)
        buildings = 0
        roads = 0
        seen_ids = set()
        payloads = {}
        for entry in index['tiles']:
            payload = json.loads((tile_dir / entry['file']).read_text(encoding='utf-8'))
            payloads[entry['id']] = payload
            self.assertEqual(entry['counts'],
                             {'buildings': len(payload['buildings']), 'roads': len(payload['roads'])},
                             entry['id'])
            self.assertTrue(payload['buildings'] or payload['roads'], entry['id'])
            buildings += len(payload['buildings'])
            roads += len(payload['roads'])
            for building in payload['buildings']:
                self.assertNotIn(building['id'], seen_ids, building['id'])
                seen_ids.add(building['id'])
        # 瓦片 counts 相加 = index counts = 单 JSON 的 buildings/roads。
        self.assertEqual(buildings, index['counts']['buildings'])
        self.assertEqual(roads, index['counts']['roads'])
        # 切分只换文件，不丢不复制：瓦片里的建筑 id 集合与单 JSON 完全相同。
        self.assertEqual(seen_ids, {building['id'] for building in data['buildings']})
        single = {building['id']: building for building in data['buildings']}
        for building_id in ('way/665408865', 'way/665408866', 'way/694152192', 'way/694152193'):
            hits = [key for key, payload in payloads.items()
                    if any(building['id'] == building_id for building in payload['buildings'])]
            self.assertEqual(len(hits), 1, building_id)
            tile_building = next(building for building in payloads[hits[0]]['buildings']
                                 if building['id'] == building_id)
            self.assertEqual(tile_building, single[building_id])
        # index 的地标带 rings（瓦片路径靠它建收分塔），与单 JSON 的春笋体块一致。
        self.assertEqual([landmark['id'] for landmark in index['landmarks']], ['way/529272473'])
        self.assertEqual(index['landmarks'][0]['rings'], single['way/529272473']['rings'])

    def test_nanshan_water_stays_south_of_the_sample(self):
        data = self.data['nanshan']
        water = data['water']
        self.assertEqual(water['level'], -0.1)
        self.assertEqual(len(water['rings']), 1)
        ring = water['rings'][0]
        self.assertGreaterEqual(len(ring), 3)
        self.assertTrue(Polygon(ring).is_valid)
        xmin, _, xmax, zmax = data['bounds']
        # 北沿贴样区南边界：水面不盖住道路/建筑（data.ts 也约定它不参与碰撞）。
        self.assertTrue(all(z >= zmax - 0.01 for _, z in ring), ring)
        self.assertLessEqual(min(x for x, _ in ring), xmin - 2000)
        self.assertGreaterEqual(max(x for x, _ in ring), xmax + 2000)
        self.assertTrue(all(abs(value) <= 5000 for point in ring for value in point), ring)

    def test_nanshan_street_placements_are_trees_and_lamps(self):
        data = self.data['nanshan']
        street = data['street']
        self.assertEqual(street['pavingHeight'], 0.12)
        self.assertEqual(street['paving'], [])
        self.assertNotIn('canopy', street)
        self.assertNotIn('signs', street)
        placements = street['placements']
        # autoPlacements.target = 40：主路候选足够时正好 40，不许掉到 40 以下。
        self.assertTrue(40 <= len(placements) <= 60, len(placements))
        self.assertEqual({placement['kind'] for placement in placements}, {'tree', 'lamp'})
        self.assertEqual({placement['yaw'] for placement in placements}, {0})
        xmin, zmin, xmax, zmax = data['bounds']
        spawn = Point(data['spawn'][0], data['spawn'][2])
        for placement in placements:
            point = Point(placement['x'], placement['z'])
            self.assertTrue(xmin < point.x < xmax and zmin < point.y < zmax, placement)
            required = 3 if placement['kind'] == 'tree' else 0.7
            self.assertGreater(min(point.distance(polygon) for polygon in self.polygons['nanshan']),
                               required, placement)
            # 沿 spawn 附近主路：都落在同一片后海街区里。
            self.assertLess(point.distance(spawn), 320, placement)

    def test_nanshan_spawn_follows_the_configured_point(self):
        data = self.data['nanshan']
        to_local = frame(SCENES['nanshan']['origin'])
        # 南山 v3 仍用固定点（人才公园北缘）：能同时看到春笋与开阔公园，且离楼墙 442m。
        # 若以后改回 spawnHint 搜索，再走 300m 半径的宽松断言。
        configured = SCENES['nanshan'].get('spawn') or SCENES['nanshan'].get('spawnHint')
        self.assertIsNotNone(configured)
        target_x, target_z = to_local(*configured)
        distance = math.hypot(data['spawn'][0] - target_x, data['spawn'][2] - target_z)
        limit = 5 if SCENES['nanshan'].get('spawn') else 300
        self.assertLess(distance, limit, distance)
        self.assertEqual(data['spawn'][1], 0)

    # --- 出生点 ---

    def test_spawn_is_clear_grounded_and_near_a_wall(self):
        for name, data in self.data.items():
            x, y, z = data['spawn']
            # 出生高度 = 脚下真实碰撞面：有铺装 → 铺装顶；没有铺装（地面块顶=0）→ 0。
            expected_y = data['street']['pavingHeight'] if data['street']['paving'] else 0
            self.assertEqual(y, expected_y, name)
            xmin, zmin, xmax, zmax = data['bounds']
            self.assertTrue(xmin < x < xmax and zmin < z < zmax, name)
            clearance = min(p.distance(Point(x, z)) for p in self.polygons[name])
            self.assertGreater(clearance, 2, name)
            self.assertAlmostEqual(clearance, data['cleaning']['spawnClearanceM'], places=1, msg=name)
            prepared = prep(unary_union(self.polygons[name]))
            hits = [wall_hit(prepared, x, z, ux / math.hypot(ux, uz), uz / math.hypot(ux, uz))
                    for ux, uz in DIRECTIONS]
            # 福田样板街必须近墙（浏览器验收从 spawn 找 3–60m 楼墙）；
            # 南山出生在人才公园北缘，最近楼墙约 442m（v3 5×5 实测），不强制近墙，
            # 墙体接触由 city.test.ts 的真实胶囊用例覆盖。
            if name == 'futian':
                self.assertTrue(any(hit is not None for hit in hits), (name, hits))
            else:
                self.assertIsNotNone(data.get('landmarks'))

    def test_origin_is_the_sample_centre(self):
        # 历史入口的 ORIGIN/BBOX/local 必须仍指向福田，否则 build_futian 兼容层会悄悄漂移。
        self.assertEqual(SCENES['futian']['origin'], ORIGIN)
        self.assertEqual(SCENES['futian']['bbox'], BBOX)
        self.assertEqual(local(114.054, 22.540), (0, 0))
        for name, data in self.data.items():
            xmin, zmin, xmax, zmax = data['bounds']
            self.assertLess(abs(xmin + xmax), 1, name)
            self.assertLess(abs(zmin + zmax), 1, name)
            to_local = frame(data['origin'])
            self.assertEqual([round(v, 6) for v in to_local(*data['origin'])], [0, 0], name)

    # --- 坐标与 schema ---

    def test_local_frame_matches_ellipsoid_tangent_plane(self):
        for name, config in SCENES.items():
            origin = config['origin']
            to_local = frame(origin)

            def ecef(lon, lat):
                lon, lat = math.radians(lon), math.radians(lat)
                n = 6378137 / math.sqrt(1 - 0.0066943799901413165 * math.sin(lat) ** 2)
                return (n * math.cos(lat) * math.cos(lon), n * math.cos(lat) * math.sin(lon),
                        n * (1 - 0.0066943799901413165) * math.sin(lat))

            center = ecef(*origin)
            lon0, lat0 = map(math.radians, origin)
            for lon in [config['bbox'][0], config['bbox'][2]]:
                for lat in [config['bbox'][1], config['bbox'][3]]:
                    dx, dy, dz = [a - b for a, b in zip(ecef(lon, lat), center)]
                    east = -math.sin(lon0) * dx + math.cos(lon0) * dy
                    north = (-math.sin(lat0) * math.cos(lon0) * dx
                             - math.sin(lat0) * math.sin(lon0) * dy + math.cos(lat0) * dz)
                    x, z = to_local(lon, lat)
                    self.assertLess(math.hypot(x - east, z + north), 1, name)
            east = to_local(origin[0] + .001, origin[1])
            north = to_local(origin[0], origin[1] + .001)
            self.assertTrue(102 < east[0] < 104, name)
            self.assertTrue(-112 < north[1] < -110, name)
            self.assertEqual(east[1], 0, name)
            self.assertEqual(north[0], 0, name)

    def test_payload_respects_frozen_schema_limits(self):
        for name, data in self.data.items():
            self.assertEqual(data['version'], 1, name)
            self.assertIsInstance(data['name'], str, name)
            self.assertEqual(len(data['origin']), 2, name)
            # data.ts 的坐标上限是 5000m（南山 v3 的 z 半宽 2768.44m，旧 2000m 已不适用）。
            self.assertTrue(all(abs(v) <= 5000 for v in data['bounds']), name)
            # 镜像 data.ts 的 buildings 上限：2026-11-21 从 10,000 提到 20,000
            # （5×5 单 JSON 的 fallback 上限；再大必须瓦片化，不是继续提数字）。
            self.assertLessEqual(len(data['buildings']), 20000, name)
            self.assertLessEqual(len(data['roads']), 10000, name)
            self.assertLessEqual(len(data['street']['paving']), 100, name)
            self.assertLessEqual(len(data['street']['placements']), 500, name)
            for polygon_rings in data['street']['paving']:
                for ring in polygon_rings:
                    self.assertGreaterEqual(len(ring), 3, name)
            for placement in data['street']['placements']:
                self.assertIn(placement['kind'], ('tree', 'lamp', 'bench', 'sign'), name)
                self.assertEqual(placement['yaw'], 0, name)
                self.assertLessEqual(len(placement.get('label', '')), 40, name)
            for building in data['buildings']:
                for ring in building['rings']:
                    self.assertTrue(all(abs(value) <= 5000 for point in ring for value in point), name)
            for road in data['roads']:
                self.assertTrue(all(abs(value) <= 5000 for point in road['points'] for value in point), name)
            if 'landmarks' in data:
                self.assertLessEqual(len(data['landmarks']), 20, name)
                for landmark in data['landmarks']:
                    self.assertIsInstance(landmark['id'], str, name)
                    self.assertLessEqual(len(landmark['name']), 80, name)
                    self.assertTrue(0 < landmark['height'] <= 1000, name)
                    profile_heights = [point[0] for point in landmark['profile']]
                    self.assertEqual(profile_heights, sorted(set(profile_heights)), name)
                    self.assertTrue(all(0 < scale <= 2 for _, scale in landmark['profile']), name)
            if 'water' in data:
                self.assertLessEqual(len(data['water']['rings']), 20, name)
                for ring in data['water']['rings']:
                    self.assertGreaterEqual(len(ring), 3, name)
                    self.assertTrue(all(abs(value) <= 5000 for point in ring for value in point), name)
                self.assertTrue(-5 <= data['water'].get('level', -0.1) <= 5, name)
            self.assertEqual(data['cleaning']['minimumAreaM2'], 4, name)
            self.assertEqual(data['cleaning']['simplifyToleranceM'], 0.25, name)
            self.assertGreater(data['cleaning']['spawnClearanceM'], 2, name)

    def test_attribution_and_note(self):
        nanshan = ' '.join(entry['label'] for entry in self.data['nanshan']['attribution'])
        self.assertIn('CC BY 4.0', nanshan)
        self.assertIn('ODbL', nanshan)
        # 春笋 392.5m 的 heightSource='ctbuh' 必须与署名对得上。
        self.assertIn('CTBUH', nanshan)
        self.assertIn('392.5', nanshan)
        # 两处补充体量的来源也要写在署名里（OSM 轮廓 + OSM height 标签）。
        self.assertIn('春茧', nanshan)
        self.assertIn('245.8', nanshan)
        futian = ' '.join(entry['label'] for entry in self.data['futian']['attribution'])
        self.assertIn('CTBUH', futian)
        self.assertIn('599.1', futian)
        for name, data in self.data.items():
            for entry in data['attribution']:
                self.assertTrue(entry['url'].startswith('https://'), (name, entry))
            self.assertTrue(0 < len(data['note']) <= 200, name)
        self.assertIn('平地近似', self.data['nanshan']['note'])
        self.assertIn('模型估算', self.data['nanshan']['note'])
        self.assertIn('599.1', self.data['futian']['note'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
