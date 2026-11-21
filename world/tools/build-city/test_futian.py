import json
import math
import unittest

from shapely.geometry import Point, Polygon

from build_futian import BBOX, HERE, ORIGIN, WORLD, build, local


class FutianPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = build(HERE / 'source')
        cls.polygons = [Polygon(b['rings'][0], b['rings'][1:]) for b in cls.data['buildings']]

    def test_reproducible_artifact(self):
        stored = json.loads((WORLD / 'assets/city/futian.json').read_text(encoding='utf-8'))
        self.assertEqual(stored, self.data)

    def test_geometry_and_height(self):
        self.assertEqual(len(self.polygons), 1230)
        self.assertTrue(all(p.is_valid and p.area >= 4 for p in self.polygons))
        self.assertTrue(all(0 < b['height'] <= 1000 for b in self.data['buildings']))

    def test_landmark_replacement_has_no_duplicate_tower(self):
        index = next(i for i, b in enumerate(self.data['buildings']) if b['heightSource'] == 'ctbuh')
        tower = self.polygons[index]
        for i, polygon in enumerate(self.polygons):
            if i != index:
                self.assertLess(polygon.intersection(tower).area, 0.5)

    def test_spawn_is_clear(self):
        x, _, z = self.data['spawn']
        self.assertGreater(min(Point(x, z).distance(p) for p in self.polygons), 2)

    def test_local_axes_and_scale(self):
        self.assertEqual(local(*ORIGIN), (0, 0))
        east = local(ORIGIN[0] + .001, ORIGIN[1])
        north = local(ORIGIN[0], ORIGIN[1] + .001)
        self.assertTrue(102 < east[0] < 104)
        self.assertTrue(-111 < north[1] < -110)
        self.assertEqual(east[1], 0)
        self.assertEqual(north[0], 0)

    def test_local_matches_ellipsoid_tangent_plane(self):
        def ecef(lon, lat):
            lon, lat = math.radians(lon), math.radians(lat)
            n = 6378137 / math.sqrt(1 - 0.0066943799901413165 * math.sin(lat) ** 2)
            return (n * math.cos(lat) * math.cos(lon), n * math.cos(lat) * math.sin(lon),
                    n * (1 - 0.0066943799901413165) * math.sin(lat))
        center = ecef(*ORIGIN)
        lon0, lat0 = map(math.radians, ORIGIN)
        for lon in [BBOX[0], BBOX[2]]:
            for lat in [BBOX[1], BBOX[3]]:
                dx, dy, dz = [a - b for a, b in zip(ecef(lon, lat), center)]
                east = -math.sin(lon0) * dx + math.cos(lon0) * dy
                north = -math.sin(lat0) * math.cos(lon0) * dx - math.sin(lat0) * math.sin(lon0) * dy + math.cos(lat0) * dz
                x, z = local(lon, lat)
                self.assertLess(math.hypot(x - east, z + north), 1)

    def test_paving_and_placements(self):
        paving = [Polygon(rings[0], rings[1:]) for rings in self.data['street']['paving']]
        self.assertTrue(all(p.is_valid and p.area > 2 for p in paving))
        self.assertEqual(self.data['spawn'][1], self.data['street']['pavingHeight'])
        for placement in self.data['street']['placements']:
            point = Point(placement['x'], placement['z'])
            self.assertTrue(any(p.covers(point) for p in paving))
            required = 3 if placement['kind'] == 'tree' else 1.8 if placement['kind'] == 'bench' else 0.7
            self.assertGreater(min(point.distance(p) for p in self.polygons), required)

    def test_all_road_points_inside_sample(self):
        xmin, zmin, xmax, zmax = self.data['bounds']
        for road in self.data['roads']:
            self.assertTrue(all(xmin <= x <= xmax and zmin <= z <= zmax for x, z in road['points']))


if __name__ == '__main__':
    unittest.main()
