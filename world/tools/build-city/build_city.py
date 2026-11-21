"""城市街区运行数据生成器：3D-GloBFP 建筑轮廓 + OSM 路网 → world/assets/city/<scene>.json。

一个场景 = `SCENES` 里的一条配置（原点/bbox/输入文件/地标/街道/署名/说明）。
几何管线只有一份：给某个场景复制粘贴分支会让两个街区各自漂移，也违反
`world/src/city/README.md` 里"参数进数据文件"的约定。

福田样板街的铺装、树/灯/长椅/路牌与入口雨棚是**设计示意**（不是测绘复原），
其中唯一的路牌文字挂在 `placements` 的 sign 上（`label`），雨棚文字挂在
`street.canopy.label`；`street.signs` 只放"独立路牌"，福田没有。

南山第三版扩到 5×5km（113.915–113.965, 22.505–22.555，含前海东/南山中心/后海/深圳湾，
原 3.1×4.4km 样区完整包含）：建筑仍来自 GloBFP，春笋用 OSM 轮廓单独成体块并写入
`landmarks`；南边界以南用 `water` 表达海面（只渲染、不参与碰撞）；`street.paving` 仍为空，
但沿 spawn 附近主路自动生成树/灯（`autoPlacements`），所以街道零件的位置由道路几何决定，
不在配置里写死坐标。春茧（体育馆/游泳馆）与腾讯滨海双塔走 `extraBuildings`：取 OSM
building 轮廓当**普通建筑**（高度用 OSM `height` 标签：春茧 40m、南塔 245.8m、北塔 194.8m），
不写 `landmarks`——地标会按 profile 收分并加竖向构件，体育馆是壳体、双塔是方塔，都不是
平安/春笋那种收分造型。GloBFP 与这两处的关系不同：春茧 0 栋相交（直接加入）；腾讯滨海
GloBFP 只有 71–104m（低估），重叠 ≥45% 的 4 栋整栋被替换、2 栋被差集裁剪，避免两套错位
轮廓叠画。

用法（仓库根目录）：
    python world/tools/build-city/build_city.py --scene futian
    python world/tools/build-city/build_city.py --scene nanshan
    python world/tools/build-city/build_city.py --scene nanshan-wide

南山第四版（`nanshan-wide`）把外框扩到 8×8km `[113.90,22.49,113.98,22.57]`（origin 取外框
中心 (113.94,22.53)，spawn 仍是 5×5 的人才公园北缘），但建筑/道路按 **南山区行政边界** 裁：
外框西北角约 1,475 栋属于宝安（新安/宝体一带）的体量会被丢掉，`bounds` 仍是 8×8 外框
（切瓦片用外框网格）。边界用 Nominatim `relation/5664195`（ODbL）存成
`source/nanshan-wide-boundary.geojson`。8×8 外框南段本来就在深圳湾：水面改由 OSM
coastline 闭合再裁到外框（`coast_water`），不是 5×5 那种南沿之外的矩形背景板。
这一版 27k+ 栋，超过 `data.ts` 的 20,000 上限，所以 `tileOnly=True`：产物只喂
`split_tiles.py`，运行时不读单 JSON（`assets/city/nanshan-wide/index.json` 才是入口）。

兼容：`build_futian.py` 是薄包装，旧测试 `test_futian.py` 的 import 名字仍然有效。
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import linemerge, transform, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
WORLD = HERE.parent.parent
DEFAULT_SOURCE = HERE / 'source'

# 福田原点的米制局部坐标。test_futian.py 仍从这里 import，所以这两个常量固定为福田，
# 不要改成"当前场景"——多场景的比例尺由 `frame(origin)` 每次现算。
ORIGIN = (114.054, 22.540)
BBOX = (114.044, 22.531, 114.064, 22.549)

# WGS84 椭球：局部米制换算用原点处的子午圈/卯酉圈曲率半径。
E2 = 0.0066943799901413165
SEMI_MAJOR = 6378137

# OSM highway 类型 → 推定路宽（米）。两个场景共用同一张表；不认识的类型直接丢弃
# （primary_link/secondary_link/steps/construction/corridor 等），这是有意的保守取舍。
WIDTHS = {
    'primary': 14, 'secondary': 12, 'tertiary': 10, 'residential': 7,
    'unclassified': 7, 'service': 4, 'living_street': 5, 'pedestrian': 5,
    'footway': 2, 'cycleway': 2, 'path': 2,
}
WALKWAY_KINDS = {'footway', 'cycleway', 'path', 'pedestrian'}

# 快速路与匝道（宝安大道/广深公路=trunk，沿江高速/机荷高速=motorway）。默认表不含它们，
# 是为了让福田/南山的产物逐字节不变；新场景在配置里写 `'roadWidths': ARTERIAL_WIDTHS`
# 打开，否则这些主干会被整条静默丢弃（南山源数据里就丢了 34 段 trunk、181 段 primary_link）。
ARTERIAL_WIDTHS = {
    **WIDTHS,
    'motorway': 24, 'trunk': 20,
    'motorway_link': 7, 'trunk_link': 7, 'primary_link': 7, 'secondary_link': 6, 'tertiary_link': 6,
}

GLO_BFP_URL = 'https://zenodo.org/records/15487037'
OSM_URL = 'https://www.openstreetmap.org/copyright'
CTBUH_URL = 'https://www.skyscrapercenter.com/shenzhen/ping-an-finance-center/54'
# 春笋（中国华润大厦）：CTBUH 建筑记录 392.5m（2026-11-21 抓取城市页交叉核对）。
CTBUH_CR_URL = 'https://www.skyscrapercenter.com/building/china-resources-tower/14589'
# 南山区行政边界（Nominatim relation/5664195，ODbL）：8×8 外框里宝安一侧靠它排除。
OSM_NANSHAN_URL = 'https://www.openstreetmap.org/relation/5664195'
NOMINATIM_URL = ('https://nominatim.openstreetmap.org/search?q=%E5%8D%97%E5%B1%B1%E5%8C%BA,'
                 '%E6%B7%B1%E5%9C%B3%E5%B8%82&format=json&polygon_geojson=1')

# 南山两代场景（5×5 样区 / 8×8 全区）共用同一批地标与补充体量：抽成常量而不是复制
# 两份配置，否则两个场景的轮廓 id、OSM 高度口径各自漂移，测试也只能各测一套。
NANSHAN_LANDMARKS = [{
    'id': 'way/529272473',
    'input': 'landmarks',
    'name': '春笋（中国华润大厦）',
    'height': 392.5,
    # 只用 OSM 标签做一致性校验，不让 OSM 高度覆盖 CTBUH 的核验值。
    'osmName': '中国华润大厦',
    'osmHeight': '392.5',
    # 收分曲线：深圳湾天际线的识别型简化，不是施工图（CTBUH 只给总高）。
    'profile': [[0, 1], [20, 0.99], [100, 0.95], [200, 0.86],
                [300, 0.70], [360, 0.45], [392.5, 0.08]],
}]

# 春茧壳体：**没有 OSM 轮廓可收**（壳是视觉层，两个 `building=stadium` 多边形是它下面的
# 两馆）。所以中心/半轴不手填，由 `shell_payload()` 从 `shellFrom` 两栋体量的轮廓算：
# 中心 = 并集包围盒中心，半轴 = 半边长 × √2 × 1.01（遮住整块矩形，留 1% 余量）。
# 高度取 OSM 的 40m（与两馆同高）；ribs 是两族交叉肋条的每条族条数。
NANSHAN_SHELL = {
    'id': 'shell/spring-cocoon',
    'name': '春茧壳体（深圳湾体育中心）',
    'height': 40.0,
    'kind': 'shell',
    'shellFrom': ['way/665408865', 'way/665408866'],
    'ribs': 28,
}
NANSHAN_LANDMARKS.append(NANSHAN_SHELL)

# 补充建筑：普通 CityBuilding，**不进 `landmarks`**——地标按 `profile` 收分并加竖向构件，
# 体育馆/双塔不该被画成收分塔；高度用 OSM `height` 标签（估高，非测绘）。
NANSHAN_EXTRA_BUILDINGS = [
    {'id': 'way/665408865', 'input': 'landmarks',
     'name': '春茧·深圳湾体育馆', 'height': 40.0, 'heightSource': 'estimate',
     'osmName': '深圳湾体育馆', 'osmHeight': 40},
    {'id': 'way/665408866', 'input': 'landmarks',
     'name': '春茧·深圳湾游泳馆', 'height': 40.0, 'heightSource': 'estimate',
     'osmName': '深圳湾游泳馆', 'osmHeight': 40},
    {'id': 'way/694152192', 'input': 'extra',
     'name': '腾讯滨海大厦·南塔', 'height': 245.8, 'heightSource': 'estimate',
     'osmName': '南塔', 'osmHeight': 245.8},
    {'id': 'way/694152193', 'input': 'extra',
     'name': '腾讯滨海大厦·北塔', 'height': 194.8, 'heightSource': 'estimate',
     'osmName': '北塔', 'osmHeight': 194.8},
]

# 南山不铺装：树/灯沿 spawn 附近主路自动排（位置由道路几何决定，不写死坐标）。
NANSHAN_STREET = {
    'pavingHeight': 0.12,
    'pavingBoxes': [],
    'placements': [],
    'autoPlacements': {'radius': 300.0, 'spacing': 14.0, 'target': 40,
                       'lampCycle': 4, 'margin': 5.0},
    'canopy': None,
    'signs': None,
}


def frame(origin):
    """返回 (lon, lat) → (x 东, z 南) 的函数；比例尺取该原点处 WGS84 曲率半径。"""
    latitude = math.radians(origin[1])
    ellipsoid = 1 - E2 * math.sin(latitude) ** 2
    scale_x = SEMI_MAJOR / math.sqrt(ellipsoid) * math.cos(latitude) * math.pi / 180
    scale_z = SEMI_MAJOR * (1 - E2) / ellipsoid ** 1.5 * math.pi / 180

    def to_local(lon, lat):
        return (lon - origin[0]) * scale_x, -(lat - origin[1]) * scale_z

    return to_local


# 福田局部坐标（历史入口）。注意这是模块级唯一实例，只服务于福田。
local = frame(ORIGIN)


SCENES = {
    # 宝安试点（3×3km）：以宝安中心区·湾区之光为中心，含欢乐港湾、宝安中心区西侧滨海。
    # 海在西侧（珠江口/前海湾北段），不能用南沿闭合，水面走 coastline side='osm'。
    'baoan-pilot': {
        'name': '宝安 · 中心区试点 3×3km（欢乐港湾）',
        # bbox 中心 = 湾区之光（OSM node/7851738804，22.5440539, 113.8830265）附近。
        'origin': (113.8830, 22.5441),
        'bbox': (113.8684, 22.5306, 113.8976, 22.5576),
        'output': 'baoan-pilot.json',
        'inputs': {
            'globfp': 'baoan-pilot-globfp.geojson',
            'roads': 'baoan-pilot-osm.json',
        },
        'landmark': None,
        'landmarks': [],
        # 宝安是新区：快速路/匝道（宝安大道、沿江高速支线）默认表会整段丢掉，这里打开。
        'roadWidths': ARTERIAL_WIDTHS,
        'spawn': None,
        # 出生点找在欢乐港湾东岸陆上，首帧朝西能看到海与湾区之光。
        'spawnHint': (113.8862, 22.5460),
        'street': NANSHAN_STREET,
        'water': {'coastline': {'side': 'osm', 'simplifyM': 1.0, 'minAreaM2': 20000.0,
                                'maxRings': 4, 'level': -0.1},
                  'inland': {'minAreaM2': 300.0, 'maxRings': 20}},
        'attribution': [
            {'label': '建筑轮廓及估高：3D-GloBFP / Che et al. 2024 · CC BY 4.0（grid 2265 官方分块）', 'url': GLO_BFP_URL},
            {'label': '路网、海岸线与水面：OpenStreetMap 贡献者 · ODbL 1.0', 'url': OSM_URL},
        ],
        'note': '平地近似；建筑高度为 3D-GloBFP 模型估算（该区最高仅 117m，超高层被低估，地标待补）；海面由 OSM 海岸线按方向闭合、内陆水面取 OSM natural=water，只渲染不碰撞；道路宽度为推定值。',
        'provenance': {
            'note': ('Extruded massing only. Building heights are 3D-GloBFP model estimates (grid 2265, '
                     'figshare article 28904453 linked from Zenodo 15487037, MD5 90588c1dab8e88cccedd98464155d41c); '
                     'the pilot maximum is about 117m, so high-rises are underestimated and landmarks are not yet added. '
                     'Surface roads use inferred widths including trunk/motorway links; bridges and tunnels are dropped; '
                     'no terrain. Sea is closed from OSM coastline orientation and inland water from OSM natural=water; '
                     'water is render-only. Street furniture is procedural. '
                     'Combined derived data retains ODbL obligations.'),
        },
    },
    'futian': {
        'name': '福田 CBD · 街区原型',
        'origin': ORIGIN,
        'bbox': BBOX,
        'output': 'futian.json',
        'inputs': {
            'globfp': 'futian-globfp.geojson',
            'osm': 'futian-osm.geojson',
            'roads': 'futian-roads.json',
        },
        # 地标：先从 GloBFP 裁掉与 OSM 轮廓重叠的部分，再把 OSM 塔楼轮廓加回来。
        'landmark': {
            'id': 'way/535860513',
            'wikidata': 'Q1077308',
            'name': '平安金融中心',
            'height': 599.1,
            # 收分曲线与 world/src/city/landmark.ts 的 PING_AN_PROFILE 逐点一致。
            'profile': [[0, 1], [12, 1], [60, 0.985], [400, 0.86],
                        [540, 0.76], [565, 0.66], [599.1, 0.025]],
        },
        'spawn': (114.05094, 22.53664),
        'street': {
            'pavingHeight': 0.12,
            # 样板街两块矩形铺装，减去建筑外扩 0.4m，避免铺装穿进楼体。
            'pavingBoxes': [(-334, 343, -291, 430), (-299, 300, -291, 500)],
            'placements': [
                ('tree', -324, [351, 398, 423]),
                ('tree', -296, [313, 357, 409, 455, 487]),
                ('lamp', -294, [329, 379, 439, 479]),
                ('bench', -319, [352, 410]),
                ('sign', -302, [353]),
            ],
            'signLabel': '福田 / 益田路',
            'canopy': {'x': -333.1, 'z': 372.08, 'width': 7, 'depth': 16,
                       'height': 4.2, 'label': '平安金融中心'},
            # 福田没有"独立路牌"：唯一一块 3.1m 路牌挂在 sign 立柱上（见 signLabel），
            # 所以不写 street.signs（kit.ts 也不读它），diff 只多真正被消费的字段。
            'signs': None,
        },
        'attribution': [
            {'label': '建筑轮廓及估高：3D-GloBFP / Che et al. 2024 · CC BY 4.0', 'url': GLO_BFP_URL},
            {'label': '路网及地标轮廓：OpenStreetMap 贡献者 · ODbL 1.0', 'url': OSM_URL},
            {'label': '平安金融中心建筑高度：CTBUH 599.1m', 'url': CTBUH_URL},
        ],
        # 与 runtime.ts#cityInfoText 的拼接口径一致：地标句由 landmark 生成，note 只写街道与地形局限。
        'note': '地标与街道设施为简化示意，非实景复刻；平安金融中心 599.1m，其余高度为模型估算。',
        'provenance': {
            'landmarkEvidence': ('CTBUH indexed building record + OSM wikidata Q1077308; '
                                 'page fetch returned 403. Architectural height, not an exact roof model.'),
            'note': ('Extruded massing only. Estimates outside the named landmark are not surveyed heights. '
                     'Surface roads use inferred widths; no terrain or grade separation. '
                     'Combined derived data retains ODbL obligations.'),
        },
    },
    'nanshan': {
        'name': '南山 · 街区原型',
        # bbox 中心：bounds 关于原点对称（test_origin_is_the_sample_centre）。
        'origin': (113.940, 22.530),
        # 5.14km 东西 × 5.54km 南北（bbox 0.05°×0.05°）：前海东/南山中心/后海/深圳湾，
        # 上一版 3.1×4.4km 样区完整包含；仍避开宝安。
        # 南边界 22.505 落在深圳湾水面：海面由 water 背景多边形表达，不切开阔海面做建筑。
        'bbox': (113.915, 22.505, 113.965, 22.555),
        'output': 'nanshan.json',
        # 输入是 8×8km 原始裁片按上面 bbox 裁过的仓库小裁片（crop_inputs.py 生成），
        # 不依赖 tmp/；8×8 原文件只在下载暂存区，不入库。
        'inputs': {
            'globfp': 'nanshan-5x5-globfp.geojson',
            'roads': 'nanshan-5x5-osm.json',
            'landmarks': 'nanshan-5x5-landmarks.json',
            # 腾讯滨海双塔（OSM way/694152192 南塔、way/694152193 北塔）单独一个裁片：
            # tasks 要求先按 name~"腾讯|Tencent|滨海" 查，OSM 把塔命名成"南塔/北塔"，
            # 按名字查不到；这两条是**具名** building 轮廓，场地由 way/737149477
            # （landuse=commercial，name=腾讯滨海大厦，alt_name=Tencent Seafront Towers）圈定。
            'extra': 'nanshan-5x5-extra-buildings.json',
        },
        # 不写单数 landmark（福田在用）：南山用 landmarks 列表，春笋一条。
        'landmark': None,
        'landmarks': NANSHAN_LANDMARKS,
        # 补充建筑：普通 CityBuilding，**不进 `landmarks`**——地标按 `profile` 收分并加
        # 竖向构件，体育馆/双塔不该被画成收分塔；高度用 OSM `height` 标签（估高，非测绘）。
        # 春茧两馆 GloBFP 完全没体量（2026-11-21 实测 0 栋相交）；腾讯滨海的 GloBFP 体量
        # 只有 71–104m（实测低估），双塔 OSM 标签 245.8/194.8m 更接近公开记录。
        'extraBuildings': NANSHAN_EXTRA_BUILDINGS,
        # GloBFP 与补充轮廓大幅重叠时，说明同一块地两套体量错位：重叠 ≥45% 的 GloBFP
        # 整栋丢弃（用 OSM 轮廓替换），小于阈值才做差集（保留与之相邻的另一段）。
        # 实测腾讯滨海 4 栋被替换、2 栋被裁剪；春茧 0 栋（本来就没有 GloBFP 体量）。
        'extraBuildingOverlapRatio': 0.45,
        # 出生点定在人才公园北缘：离春笋约 400m，首帧能看到春笋+后海天际线；
        # 相机在角色背后 6m，背后是开阔公园，不会被 boom 顶成俯视。
        'spawn': (113.941, 22.5135),
        'spawnHint': None,
        'street': NANSHAN_STREET,
        # 南边界以南的海面：远景背景板，只渲染，不参与碰撞。
        'water': {'extendX': 2000.0, 'depth': 2000.0, 'level': -0.1},
        'attribution': [
            {'label': '建筑轮廓及估高：3D-GloBFP / Che et al. 2024 · CC BY 4.0', 'url': GLO_BFP_URL},
            {'label': '路网、海岸线与地标轮廓：OpenStreetMap 贡献者 · ODbL 1.0', 'url': OSM_URL},
            {'label': '春茧（深圳湾体育中心）轮廓与 40m 高度：OSM way/665408865、way/665408866', 'url': OSM_URL},
            {'label': '腾讯滨海大厦（南塔 245.8m / 北塔 194.8m）轮廓与高度：OSM way/694152192、way/694152193', 'url': OSM_URL},
            {'label': '春笋（中国华润大厦）建筑高度：CTBUH 392.5m', 'url': CTBUH_CR_URL},
        ],
        'note': '平地近似；建筑高度为 3D-GloBFP 模型估算，春茧两馆取 OSM 40m、腾讯滨海双塔取 OSM 245.8/194.8m；后海/深圳湾水面为远景示意，春笋 392.5m；道路宽度为推定值。',
        'provenance': {
            'landmarkEvidence': ('CTBUH building record lists China Resources Tower at 392.5m; '
                                 'OSM way/529272473 supplies the 37-point outline (building:levels 68). '
                                 'Architectural height, not an exact roof model.'),
            'note': ('Extruded massing only. Building heights are 3D-GloBFP model estimates, not surveyed heights. '
                     'The two Spring Cocoon stadium outlines come from OSM building=stadium with the OSM height tag '
                     '(40m). The two Tencent Seafront Towers come from OSM way/694152192 (South Tower, 245.8m) and '
                     'way/694152193 (North Tower, 194.8m), both OSM height tags, not surveys. '
                     'Surface roads use inferred widths; no terrain or grade separation. '
                     'Street furniture is procedural, not a surveyed layout. '
                     'Water is a background plane and is not collidable. '
                     'Combined derived data retains ODbL obligations.'),
        },
    },
    # 南山全区（8×8km）：5×5 样区的上一级。外框 [113.90,22.49,113.98,22.57] 里只有
    # ~96% 属于南山区，其余是宝安（西北角新安/宝体一带）与海面，所以建筑/道路不是按矩形裁，
    # 而是 **矩形 ∩ 南山区行政边界**（`boundary`）；`bounds` 仍是 8×8 外框，切瓦片用外框网格。
    # 这里刻意不把它当运行时单 JSON：>20,000 栋超过 data.ts 的 20k 上限，只作为
    # split_tiles.py 的输入（`tileOnly`），运行时不读 assets/city/nanshan-wide.json。
    'nanshan-wide': {
        'name': '南山 · 全区 8×8km（行政边界裁剪）',
        'origin': (113.940, 22.530),
        'bbox': (113.900, 22.490, 113.980, 22.570),
        'output': 'nanshan-wide.json',
        'tileOnly': True,
        'boundary': 'nanshan-wide-boundary.geojson',
        # 地标/补充体量沿用 5×5 配置（同一批 OSM 轮廓、同一套高度口径，见模块常量）。
        'inputs': {
            'globfp': 'nanshan-wide-globfp.geojson',
            'roads': 'nanshan-wide-osm.json',
            'landmarks': 'nanshan-5x5-landmarks.json',
            'extra': 'nanshan-5x5-extra-buildings.json',
        },
        'landmark': None,
        'landmarks': NANSHAN_LANDMARKS,
        'extraBuildings': NANSHAN_EXTRA_BUILDINGS,
        'extraBuildingOverlapRatio': 0.45,
        # 出生点与 5×5 相同（人才公园北缘）：两代场景在同一世界坐标下可无缝对比。
        'spawn': (113.941, 22.5135),
        'spawnHint': None,
        'street': NANSHAN_STREET,
        # 8×8 外框的南段本来就在深圳湾里：矩形背景板会盖住陆地，所以用 OSM coastline
        # 闭合出"海岸线以南"的海面再裁到外框（顶点全在 ±5000m 内）。只渲染、不碰撞。
        'water': {'coastline': {'marginDeg': 0.02, 'simplifyM': 1.0, 'minAreaM2': 50000.0,
                                'maxRings': 4, 'level': -0.1}},
        'attribution': [
            {'label': '建筑轮廓及估高：3D-GloBFP / Che et al. 2024 · CC BY 4.0', 'url': GLO_BFP_URL},
            {'label': '路网、海岸线与地标轮廓：OpenStreetMap 贡献者 · ODbL 1.0', 'url': OSM_URL},
            {'label': '南山区行政边界（8×8 外框内排除宝安一侧）：OSM relation/5664195 · ODbL 1.0',
             'url': OSM_NANSHAN_URL},
            {'label': '春茧（深圳湾体育中心）轮廓与 40m 高度：OSM way/665408865、way/665408866', 'url': OSM_URL},
            {'label': '腾讯滨海大厦（南塔 245.8m / 北塔 194.8m）轮廓与高度：OSM way/694152192、way/694152193', 'url': OSM_URL},
            {'label': '春笋（中国华润大厦）建筑高度：CTBUH 392.5m', 'url': CTBUH_CR_URL},
        ],
        'note': '平地近似；8×8 外框按南山区行政边界裁（宝安一侧不纳入）；建筑高度为 3D-GloBFP 模型估算，春笋 392.5m；海面由 OSM 海岸线闭合，只渲染不碰撞；道路宽度为推定值。',
        'provenance': {
            'landmarkEvidence': ('CTBUH building record lists China Resources Tower at 392.5m; '
                                 'OSM way/529272473 supplies the 37-point outline (building:levels 68). '
                                 'Architectural height, not an exact roof model.'),
            'boundaryEvidence': ('Nominatim polygon_geojson for relation/5664195 (南山区, boundary=administrative, '
                                 'admin_level=6), fetched 2026-11-21. Used only to clip buildings/roads to the '
                                 'district; it is not a survey-grade boundary.'),
            'note': ('Extruded massing only. The 8x8 km frame is clipped to the Nanshan district polygon, so the '
                     'Bao\'an side of the frame is excluded. Building heights are 3D-GloBFP model estimates; the '
                     'two Spring Cocoon outlines use the OSM height tag (40m) and the two Tencent Seafront Towers '
                     'use OSM 245.8m/194.8m. Water is reconstructed by closing the OSM coastline south of the shore '
                     'and is not collidable. Surface roads use inferred widths; street furniture is procedural. '
                     'Combined derived data retains ODbL obligations.'),
        },
    },
}

SCENE_NAMES = tuple(sorted(SCENES))


def polygons(geometry):
    """Polygon / MultiPolygon / 空几何 → 只含 Polygon 的列表。"""
    if geometry.geom_type == 'Polygon':
        return [geometry]
    return [p for p in getattr(geometry, 'geoms', []) if p.geom_type == 'Polygon']


def ring(coordinates):
    """Shapely 闭合环 → 数据里的 2 位小数开放环（末点重复，去掉）。"""
    return [[round(x, 2), round(z, 2)] for x, z in list(coordinates)[:-1]]


def wall_distance(prepared_buildings, x, z, ux, uz, minimum=3.0, maximum=60.0, step=0.5):
    """沿单位方向 (ux, uz) 从 (x, z) 采样，返回第一次进入建筑的距离；打不到返回 None。

    与 scripts/verify/verify-nanshan-city.py 的 8 向 raycast 判定口径对齐
    （3m < 墙距 < 60m），保证数据生成时"出生点附近有墙可冲撞"。
    """
    distance = minimum
    while distance <= maximum:
        if prepared_buildings.contains(Point(x + ux * distance, z + uz * distance)):
            return distance
        distance += step
    return None


def find_spawn(roads, building_polygons, boundary, ground_y, margin=20.0, hint=None):
    """沿道路中线找可复现的清水出生点：距建筑 >3m，且 8 个方向 3–60m 内能打到楼墙。

    `ground_y` 是出生点的 y：有铺装时传铺装顶（0.12），没有铺装时传 0（脚下真实碰撞面）。
    不写死经纬度：南山道路与福田完全不同，写死一个点等于把一处坐标搬过来。
    `hint` 是局部米制的取样偏好（场景里的 spawnHint）：候选按"离 hint 近"排序，
    否则第一个可用的点常常落在样区边角，镜头一进场就到城市边缘。
    排序键全是确定值，重跑结果一致。
    """
    prepared_buildings = prep(unary_union(building_polygons))
    tree = STRtree(building_polygons)
    minx, minz, maxx, maxz = boundary.bounds
    hint_point = Point(hint[0], hint[1]) if hint else Point(0.0, 0.0)
    directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    candidates = []
    for index, road in enumerate(roads):
        points = road['points']
        for (ax, az), (bx, bz) in zip(points, points[1:]):
            length = math.hypot(bx - ax, bz - az)
            steps = max(1, int(length // 5))
            for step in range(steps):
                t = step / steps
                candidates.append((ax + (bx - ax) * t, az + (bz - az) * t, index, road['walkway']))
    candidates.sort(key=lambda c: (round(math.hypot(c[0] - hint_point.x, c[1] - hint_point.y), 6),
                                   not c[3], c[2]))
    for x, z, _, _ in candidates:
        if not (minx + margin <= x <= maxx - margin and minz + margin <= z <= maxz - margin):
            continue
        point = Point(x, z)
        nearest = building_polygons[int(tree.nearest(point))]
        clearance = point.distance(nearest)
        # 净空要 >2m（硬规则），但墙体又要在 60m 内可达，太远就换下一个点。
        if not 3.0 <= clearance <= 60.0:
            continue
        for dx, dz in directions:
            norm = math.hypot(dx, dz)
            if wall_distance(prepared_buildings, x, z, dx / norm, dz / norm) is not None:
                return [round(x, 2), ground_y, round(z, 2)], clearance
    raise RuntimeError('在南山样区找不到满足净空与近墙条件的出生点')


def landmark_specs(config):
    """福田的单数 landmark 与南山/后续场景的复数 landmarks 合成一份有序清单。"""
    specs = []
    if config.get('landmark'):
        specs.append(config['landmark'])
    specs.extend(config.get('landmarks') or [])
    return specs


def is_shell_spec(spec):
    """壳体地标（春茧）：没有楼体、没有 OSM 轮廓，只有程序化壳体参数。"""
    return spec.get('kind') == 'shell'


def shell_payload(spec, buildings):
    """壳体条目：中心/半轴由 `shellFrom` 里那些真实体量的轮廓算出来，不手填坐标。

    覆盖整块矩形的椭圆半轴 = 半边长 × √2（矩形的角落在椭圆上），再留 1% 余量——
    不留余量的话 `shellCoveredBuildingIds()` 的"轮廓完全在壳内"判定会在角上跟浮点打平。
    """
    points = []
    for building_id in spec['shellFrom']:
        building = next((b for b in buildings if b['id'] == building_id), None)
        if building is None:
            raise ValueError(f"壳体覆盖的体量缺失：{building_id}")
        for ring_points in building['rings']:
            points.extend(ring_points)
    xs = [point[0] for point in points]
    zs = [point[1] for point in points]
    margin = 1.01
    return {
        'id': spec['id'],
        'name': spec['name'],
        'height': spec['height'],
        'kind': 'shell',
        'shell': {
            'center': [round((min(xs) + max(xs)) / 2, 2), round((min(zs) + max(zs)) / 2, 2)],
            'radii': [round((max(xs) - min(xs)) / 2 * math.sqrt(2) * margin, 2),
                      round((max(zs) - min(zs)) / 2 * math.sqrt(2) * margin, 2)],
            'height': spec['height'],
            'ribs': spec.get('ribs', 28),
        },
    }


def landmark_payload(spec, buildings):
    """一个 landmarks[] 条目：收分塔写 `profile`，壳体写 `kind/shell`。"""
    if is_shell_spec(spec):
        return shell_payload(spec, buildings)
    return {
        'id': spec['id'],
        'name': spec['name'],
        'height': spec['height'],
        'profile': [list(point) for point in spec['profile']],
    }


def landmark_geometry(spec, sources, to_local):
    """从输入裁片里取出一个核验地标/补充建筑在局部米制下的轮廓（Polygon）。

    也服务于 `extraBuildings`：那一档不需要 `profile`，但同样按 id 精确取 OSM 轮廓，
    并可选地用 `osmName` / `osmHeight` 做一致性校验（对不上就报错，不静默用别处的几何）。

    兼容两种输入：OSM GeoJSON（`features[].id` 形如 `way/535860513`）与
    Overpass JSON（`elements[].type/id` 是分开的字段）。只按 id 精确匹配，
    不拿"最近的一栋楼"冒充；wikidata / OSM 名称与高度只是可选的交叉校验。
    """
    raw = sources[spec.get('input', 'osm')]
    if 'features' in raw:
        feature = next((f for f in raw['features'] if f.get('id') == spec['id']), None)
        if feature is None:
            raise ValueError(f"地标轮廓缺失：{spec['id']}")
        properties = feature.get('properties') or {}
        geometry = shape(feature['geometry'])
    else:
        element_type, _, element_id = str(spec['id']).partition('/')
        wanted = int(element_id or spec['id'])
        feature = next((e for e in raw['elements']
                        if e.get('type', 'way') == (element_type or 'way') and e.get('id') == wanted), None)
        if feature is None:
            raise ValueError(f"地标轮廓缺失：{spec['id']}")
        properties = feature.get('tags') or {}
        geometry = Polygon([(point['lon'], point['lat']) for point in feature['geometry']])
    if spec.get('wikidata') and properties.get('wikidata') != spec['wikidata']:
        raise ValueError(f"{spec['id']} 的 wikidata 与配置不一致")
    if spec.get('osmName') and properties.get('name') != spec['osmName']:
        raise ValueError(f"{spec['id']} 的 name 与配置不一致：{properties.get('name')!r}")
    if spec.get('osmHeight') is not None and properties.get('height') != str(spec['osmHeight']):
        raise ValueError(f"{spec['id']} 的 OSM height 与配置不一致：{properties.get('height')!r}")
    tower = transform(to_local, geometry)
    if tower.geom_type != 'Polygon' or not tower.is_valid or tower.area < 4:
        raise ValueError(f"{spec['id']} 的轮廓不是有效多边形")
    return tower


def water_payload(boundary, options):
    """南边界以南的海面：从样区南沿向南铺一块矩形背景板，东西各延 `extendX`。

    只给远景用，不参与碰撞；刻意与样区地面不重叠（z 从 bounds 南沿开始），
    避免水面盖住道路/建筑。坐标上限仍受 data.ts 的 5000m 校验约束。
    """
    xmin, _, xmax, zmax = boundary.bounds
    extend = float(options.get('extendX', 2000.0))
    depth = float(options.get('depth', 2000.0))
    level = float(options.get('level', -0.1))
    ring = [[round(xmin - extend, 2), round(zmax, 2)],
            [round(xmax + extend, 2), round(zmax, 2)],
            [round(xmax + extend, 2), round(zmax + depth, 2)],
            [round(xmin - extend, 2), round(zmax + depth, 2)]]
    if max(abs(value) for point in ring for value in point) > 5000:
        raise ValueError('水面超出 data.ts 的 5000m 坐标上限')
    return {'rings': [ring], 'level': level}


def place_furniture(roads, building_polygons, boundary, spawn, options):
    """沿 spawn 附近主路自动生成树/灯（确定性，不写死坐标）。

    规则与 README 的零件净空一致：树距建筑 >3m、灯 >0.7m；另外保持 6m 以上间距，
    避免一棵树压着另一盏灯。主路 = 宽度 ≥7m 且不是人行道/步道；位置从道路中线
    向两侧偏移"半条路宽 + 人行道余量"，采样间隔固定，所以重跑结果一致。
    """
    radius = float(options.get('radius', 300.0))
    spacing = float(options.get('spacing', 14.0))
    target = int(options.get('target', 40))
    lamp_cycle = max(2, int(options.get('lampCycle', 4)))
    margin = float(options.get('margin', 5.0))
    required = {'tree': 3.0, 'lamp': 0.7}
    offsets = {'tree': 1.6, 'lamp': 0.9}
    spawn_point = Point(spawn[0], spawn[2])
    minx, minz, maxx, maxz = boundary.bounds
    tree = STRtree(building_polygons)
    main_roads = []
    for road in roads:
        if road['walkway'] or road['width'] < 7:
            continue
        line = LineString(road['points'])
        distance = line.distance(spawn_point)
        if distance <= radius:
            main_roads.append((round(distance, 6), road['id'], road))
    main_roads.sort(key=lambda item: (item[0], item[1]))
    placements = []
    for _, _, road in main_roads:
        line = LineString(road['points'])
        length = line.length
        if length < 1:
            continue
        samples = max(1, int(length // spacing))
        for index in range(samples + 1):
            t = index / samples
            center = line.interpolate(t, normalized=True)
            kind = 'lamp' if index % lamp_cycle == lamp_cycle - 1 else 'tree'
            before = line.interpolate(max(0.0, t - 0.5 / length), normalized=True)
            after = line.interpolate(min(1.0, t + 0.5 / length), normalized=True)
            ux, uz = after.x - before.x, after.y - before.y
            norm = math.hypot(ux, uz)
            if norm < 1e-9:
                continue
            nx, nz = -uz / norm, ux / norm
            for side in (1, -1):
                offset = road['width'] / 2 + offsets[kind]
                x, z = center.x + nx * offset * side, center.y + nz * offset * side
                if not (minx + margin <= x <= maxx - margin and minz + margin <= z <= maxz - margin):
                    continue
                point = Point(x, z)
                if point.distance(building_polygons[int(tree.nearest(point))]) <= required[kind]:
                    continue
                if any(math.hypot(x - item['x'], z - item['z']) < spacing * 0.45 for item in placements):
                    continue
                placements.append({'kind': kind, 'x': round(x, 2), 'z': round(z, 2), 'yaw': 0})
                break
            if len(placements) >= target:
                return placements
    if len(placements) < 30:
        raise ValueError(f'沿 spawn 附近主路只放下 {len(placements)} 个街道零件（需要 30–50）')
    return placements


def coast_water(roads_source, to_local, config, boundary):
    """用 OSM coastline 闭合出"海岸线以南"的海面，再裁到外框（只渲染，不参与碰撞）。

    为什么不用矩形背景板（5×5 的做法）：8×8 外框的南段本来就在深圳湾里，矩形板要么
    从外框南沿才开始（海湾里 1.4km 被画成地面），要么往北铺就会盖住后海的陆地。
    OSM coastline 是有向折线（陆地靠左），取与外框外扩区相交的最长一条链，用外扩区
    南沿把两端连起来，得到"海岸线以南"的面；再与外框求交，顶点自然都在 ±5000m 内，
    满足 data.ts 的坐标上限。链断开（海岸线没接上）时宁可报错，也不画一块假海。
    """
    options = config['water']['coastline']
    margin = float(options.get('marginDeg', 0.02))
    simplify = float(options.get('simplifyM', 1.0))
    minimum_area = float(options.get('minAreaM2', 50000.0))
    max_rings = int(options.get('maxRings', 4))
    level = float(options.get('level', -0.1))
    west, south, east, north = config['bbox']
    region = transform(to_local, box(west - margin, south - margin, east + margin, north + margin))

    lines = []
    for item in roads_source['elements']:
        if (item.get('tags') or {}).get('natural') != 'coastline':
            continue
        points = [to_local(point['lon'], point['lat']) for point in item.get('geometry') or []]
        if len(points) < 2:
            continue
        clipped = LineString(points).intersection(region)
        if clipped.is_empty:
            continue
        if clipped.geom_type == 'LineString':
            lines.append(clipped)
        else:
            lines.extend(part for part in getattr(clipped, 'geoms', []) if part.geom_type == 'LineString')
    if not lines:
        raise ValueError('海岸线缺失：无法闭合水面')

    merged = linemerge(unary_union(lines))
    parts = [merged] if merged.geom_type == 'LineString' else list(getattr(merged, 'geoms', []))
    if not parts:
        raise ValueError('海岸线无法合并成折线')
    # 最长的一条链就是深圳湾岸线；短的小环（礁石/围合水面）不参与闭合。
    path = max(parts, key=lambda part: part.length)
    coords = list(path.coords)
    if coords[0][0] > coords[-1][0]:  # 统一成西→东，闭合时"外侧"始终是南边
        coords.reverse()
    # 局部坐标 z 向南为正：外框"南沿"是 zmax（不是 zmin），闭合线必须走南边，
    # 否则闭合出来的面会落在陆地上（spawn 与上万栋楼会被判进水里）。
    south_edge = region.bounds[3]
    sea = Polygon([*coords, (coords[-1][0], south_edge), (coords[0][0], south_edge)])
    if not sea.is_valid:
        sea = sea.buffer(0)
    if sea.is_empty or sea.geom_type not in ('Polygon', 'MultiPolygon'):
        raise ValueError('海岸线闭合失败：水面不是多边形')
    sea = sea.intersection(boundary)  # 裁到外框：不让水面溢出 bounds

    rings = []
    for polygon in polygons(sea):
        if polygon.area < minimum_area:
            continue
        simplified = polygon.simplify(simplify, preserve_topology=True)
        ring = [[round(x, 2), round(z, 2)] for x, z in simplified.exterior.coords[:-1]]
        if len(ring) < 3:
            continue
        rings.append((simplified.area, ring))
    if not rings:
        raise ValueError('海岸线闭合出的水面为空')
    rings.sort(key=lambda item: (-item[0], len(item[1])))
    rings = [ring for _, ring in rings[:max_rings]]
    if any(abs(value) > 5000 for ring in rings for point in ring for value in point):
        raise ValueError('水面超出 data.ts 的 5000m 坐标上限')
    return {'rings': rings, 'level': level}


def coast_side_water(roads_source, to_local, config, boundary):
    """按 OSM coastline 的方向闭合海面（陆地在走向左侧），适用于海不在正南的场景（宝安：海在西）。

    `coast_water` 假定海在外框南边，用南沿闭合；宝安中心区的岸线南北走向、海在西侧，
    那样闭合会把陆地判成海。这里不假设方位：把外框沿海岸线切开，每一块用"离它最近的
    岸线段在哪一侧"判海陆。局部坐标 z 朝南，相对经纬度是镜像的，所以 OSM 的"陆地在左"
    在局部坐标里是"陆地在右、海在左"。另可并入 OSM natural=water 内陆水面（inland）。
    """
    from shapely.ops import nearest_points, split
    options = config['water']['coastline']
    simplify = float(options.get('simplifyM', 1.0))
    minimum_area = float(options.get('minAreaM2', 50000.0))
    max_rings = int(options.get('maxRings', 4))
    level = float(options.get('level', -0.1))

    lines = []
    for item in roads_source['elements']:
        if (item.get('tags') or {}).get('natural') != 'coastline':
            continue
        points = [to_local(point['lon'], point['lat']) for point in item.get('geometry') or []]
        if len(points) >= 2:
            lines.append(LineString(points))
    if not lines:
        raise ValueError('海岸线缺失：无法闭合水面')
    merged = linemerge(unary_union(lines))
    chains = [merged] if merged.geom_type == 'LineString' else list(merged.geoms)
    cutter = unary_union([chain.intersection(boundary) for chain in chains])
    pieces = polygons(split(boundary, cutter)) if not cutter.is_empty else [boundary]

    sea_parts = []
    for piece in pieces:
        probe = piece.representative_point()
        best = None
        for chain in chains:
            distance = chain.distance(probe)
            if best is None or distance < best[0]:
                best = (distance, chain)
        chain = best[1]
        at = chain.project(nearest_points(chain, probe)[0])
        a = chain.interpolate(max(at - 1.0, 0.0))
        b = chain.interpolate(min(at + 1.0, chain.length))
        cross = (b.x - a.x) * (probe.y - a.y) - (b.y - a.y) * (probe.x - a.x)
        if cross > 0:  # 局部坐标里在岸线走向左侧 = 海
            sea_parts.append(piece)
    if not sea_parts:
        raise ValueError('海岸线闭合出的水面为空')
    sea = unary_union(sea_parts)

    rings = []
    for polygon in polygons(sea):
        if polygon.area < minimum_area:
            continue
        simplified = polygon.simplify(simplify, preserve_topology=True)
        rings.append((simplified.area, [[round(x, 2), round(z, 2)] for x, z in simplified.exterior.coords[:-1]]))
    rings.sort(key=lambda item: (-item[0], len(item[1])))
    rings = [ring for _, ring in rings[:max_rings]]

    inland = config['water'].get('inland')
    if inland:
        candidates = []
        for item in roads_source['elements']:
            tags = item.get('tags') or {}
            if tags.get('natural') != 'water' or tags.get('aio:role') == 'inner':
                continue
            points = [to_local(point['lon'], point['lat']) for point in item.get('geometry') or []]
            if len(points) < 4 or points[0] != points[-1]:
                continue
            shape_ = Polygon(points)
            if not shape_.is_valid:
                shape_ = shape_.buffer(0)
            for polygon in polygons(shape_.intersection(boundary).difference(sea)):
                if polygon.area >= float(inland.get('minAreaM2', 200.0)):
                    simplified = polygon.simplify(simplify, preserve_topology=True)
                    candidates.append((simplified.area, item['id'],
                                       [[round(x, 2), round(z, 2)] for x, z in simplified.exterior.coords[:-1]]))
        candidates.sort(key=lambda item: (-item[0], item[1]))
        rings.extend(ring for _, _, ring in candidates[:int(inland.get('maxRings', 20)) - len(rings)])
    rings = [ring for ring in rings if len(ring) >= 3]
    if any(abs(value) > 5000 for ring in rings for point in ring for value in point):
        raise ValueError('水面超出 data.ts 的 5000m 坐标上限')
    return {'rings': rings, 'level': level}


def build_scene(scene, source=DEFAULT_SOURCE):
    """按 SCENES[scene] 生成一份 CityData（与 world/src/city/data.ts 的冻结 schema 对齐）。"""
    if scene not in SCENES:
        raise SystemExit(f"未知场景 {scene!r}，可选：{', '.join(SCENE_NAMES)}")
    config = SCENES[scene]
    source = Path(source)
    to_local = frame(config['origin'])
    # boundary = bbox 外框：data['bounds']、spawn 边界余量、水面裁切都用它，
    # 所以 8×8 的外框网格（切瓦片）与几何裁剪是两件事。
    boundary = transform(to_local, box(*config['bbox']))

    files = {key: source / name for key, name in config['inputs'].items()}
    sources = {key: json.loads(path.read_text(encoding='utf-8')) for key, path in files.items()}
    globfp = sources['globfp']
    roads_source = sources['roads']
    if roads_source.get('remark'):
        raise ValueError(roads_source['remark'])

    # clip = 建筑/道路真正的裁剪面：默认就是外框；配了 boundary 的场景再与外框求交，
    # 这样 8×8 外框里宝安一侧的建筑不会进来（行政区边界只裁几何，不改 bounds/原点）。
    clip = boundary
    boundary_file = config.get('boundary')
    if boundary_file:
        path = source / boundary_file
        admin = json.loads(path.read_text(encoding='utf-8'))
        admin_union = unary_union([shape(feature['geometry']) for feature in admin['features']])
        clip = boundary.intersection(transform(to_local, admin_union))
        if clip.is_empty or clip.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError(f'{boundary_file} 与外框没有交集')


    landmarks = [spec for spec in landmark_specs(config) if not is_shell_spec(spec)]
    towers = [landmark_geometry(spec, sources, to_local) for spec in landmarks]
    # 补充建筑（春茧两馆、腾讯滨海双塔）：普通 CityBuilding，不进 landmarks（见场景注释）。
    extra_specs = config.get('extraBuildings') or []
    extras = [landmark_geometry(spec, sources, to_local) for spec in extra_specs]
    extra_union = unary_union(extras) if extras else None
    extra_prepared = prep(extra_union) if extra_union is not None else None
    # 重叠 ≥ 该比例就把整栋 GloBFP 当成错位的同一体量丢掉；小于比例才做差集。
    replace_ratio = float(config.get('extraBuildingOverlapRatio', 0.45))
    # 单地标走原路径（福田必须逐字节可复现）：只有地标+补充建筑合计多于一个几何时
    # 才合并成一份裁切几何，避免同一块地面画两层体块。
    tower_cut = towers[0] if len(towers) == 1 else (unary_union(towers) if towers else None)
    cut_parts = [*towers, *extras]
    if not cut_parts:
        cut_geometry = None
    elif len(cut_parts) == 1:
        cut_geometry = cut_parts[0]
    else:
        cut_geometry = unary_union(cut_parts)

    buildings = []
    rejected = 0
    cut = 0
    extra_replaced = 0
    extra_trimmed = 0
    outside_boundary = 0
    seen = set()
    for feature in globfp['features']:
        # 仓库既有裁片用 height_m；3D-GloBFP 官方分块的字段名是 Height（宝安直接取自官方分块）。
        height = feature['properties'].get('height_m', feature['properties'].get('Height'))
        if not isinstance(height, (int, float)) or not math.isfinite(height) or height <= 0:
            raise ValueError(f"Invalid height: {feature['id']}")
        source_geometry = transform(to_local, shape(feature['geometry']))
        geometry = source_geometry.intersection(clip)
        if config.get('boundary') and geometry.is_empty:
            # 行政区边界之外的 GloBFP 体量（8×8 外框西北角的宝安）。单列计数：
            # 它和"面积太小/重复被丢"不是一回事，报告里要能直接读出边界裁掉多少。
            outside_boundary += 1
            continue
        if extra_prepared is not None and extra_prepared.intersects(geometry):
            overlap = geometry.intersection(extra_union).area
            if geometry.area > 0 and overlap / geometry.area >= replace_ratio:
                # 同一体量、两套轮廓错位：整栋让位给 OSM 轮廓，别留下被切剩的碎块。
                extra_replaced += 1
                continue
            extra_trimmed += 1
        if tower_cut is not None and geometry.intersects(tower_cut):
            cut += 1
        if cut_geometry is not None and geometry.intersects(cut_geometry):
            geometry = geometry.difference(cut_geometry)
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
    for spec, tower in zip(landmarks, towers):
        buildings.append({'id': spec['id'], 'name': spec['name'], 'height': spec['height'],
                          'heightSource': 'ctbuh', 'rings': [ring(tower.exterior.coords)]})
    for spec, extra in zip(extra_specs, extras):
        extra_ring = ring(extra.exterior.coords)
        rounded = Polygon(extra_ring)
        if not rounded.is_valid or rounded.area < 4:
            raise ValueError(f"{spec['id']} 取整后不是有效多边形")
        if any(building['id'] == spec['id'] for building in buildings):
            raise ValueError(f"{spec['id']} 与已有建筑 id 重复")
        # 高度与 heightSource 由配置显式给出（春茧=OSM height 40，仍标注 estimate）：
        # 不拿 GloBFP 的估高覆盖 OSM 标签，也不把体育馆标成 ctbuh。
        buildings.append({'id': spec['id'], 'name': spec['name'], 'height': round(spec['height'], 2),
                          'heightSource': spec['heightSource'], 'rings': [extra_ring]})

    roads = []
    widths = config.get('roadWidths') or WIDTHS
    for item in roads_source['elements']:
        tags = item.get('tags', {})
        kind = tags.get('highway')
        if (kind not in widths or tags.get('layer', '0') != '0'
                or tags.get('tunnel', 'no') != 'no' or tags.get('bridge', 'no') != 'no'):
            continue
        points = [to_local(p['lon'], p['lat']) for p in item.get('geometry', [])]
        if len(points) < 2:
            continue
        geometry = LineString(points).intersection(clip)
        lines = [geometry] if geometry.geom_type == 'LineString' else list(getattr(geometry, 'geoms', []))
        for index, line in enumerate(lines):
            if line.geom_type != 'LineString' or line.length < 1:
                continue
            roads.append({'id': f"way/{item['id']}:{index}", 'width': widths[kind],
                          'walkway': kind in WALKWAY_KINDS,
                          'points': [[round(x, 2), round(z, 2)] for x, z in line.coords]})

    occupied = unary_union([Polygon(b['rings'][0], b['rings'][1:]) for b in buildings])
    street_config = config['street']
    if street_config['pavingBoxes']:
        design = unary_union([box(*limits) for limits in street_config['pavingBoxes']])
        paving_geometry = design.difference(occupied.buffer(0.4))
        paving = [[ring(p.exterior.coords), *[ring(h.coords) for h in p.interiors]]
                  for p in polygons(paving_geometry) if p.area > 2]
    else:
        paving_geometry = None
        paving = []

    paving_height = street_config['pavingHeight']
    # 出生高度 = 脚下真实碰撞面：有铺装时是铺装顶（硬规则，福田 0.12）；
    # 没有铺装时可见地面与碰撞顶都在 0.0（CityScene 的地面块），沿用原房间 spawn.y=0，
    # 否则玩家会从 0.12 落到 0.0 —— 视觉悬空，浏览器验收的落地断言也会红。
    ground_height = paving_height if paving else 0.0
    building_polygons = [Polygon(b['rings'][0], b['rings'][1:]) for b in buildings]
    if config.get('spawn'):
        sx, sz = to_local(*config['spawn'])
        spawn = [round(sx, 2), ground_height, round(sz, 2)]
        clearance = min(Point(spawn[0], spawn[2]).distance(polygon) for polygon in building_polygons)
    else:
        hint = to_local(*config['spawnHint']) if config.get('spawnHint') else None
        spawn, clearance = find_spawn(roads, building_polygons, boundary, ground_height, hint=hint)
    if clearance <= 2:
        raise ValueError(f'Spawn clearance is only {clearance} m')

    placements = []
    if street_config.get('autoPlacements'):
        # 南山：树/灯沿 spawn 附近主路自动排，位置由道路几何与净空筛选决定。
        placements = place_furniture(roads, building_polygons, boundary, spawn,
                                     street_config['autoPlacements'])
    else:
        for kind, x, zs in street_config['placements']:
            for z in zs:
                clearance_needed = 3 if kind == 'tree' else 1.8 if kind == 'bench' else 0.7
                point = Point(x, z)
                if point.distance(occupied) > clearance_needed and paving_geometry is not None \
                        and paving_geometry.covers(point):
                    placement = {'kind': kind, 'x': x, 'z': z, 'yaw': 0}
                    if kind == 'sign' and street_config.get('signLabel'):
                        placement['label'] = street_config['signLabel']
                    placements.append(placement)
    street = {'pavingHeight': street_config['pavingHeight'], 'paving': paving,
              'placements': placements}
    if street_config.get('canopy'):
        street['canopy'] = street_config['canopy']
    if street_config.get('signs') is not None:
        street['signs'] = street_config['signs']

    data = {
        'version': 1,
        'name': config['name'],
        'origin': list(config['origin']),
        'bounds': [round(v, 2) for v in boundary.bounds],
        'spawn': spawn,
        'buildings': buildings,
        'roads': roads,
        'street': street,
        'attribution': config['attribution'],
    }
    if config.get('landmark'):
        landmark = config['landmark']
        data['landmark'] = {
            'id': landmark['id'],
            'name': landmark['name'],
            'height': landmark['height'],
            'profile': [list(point) for point in landmark['profile']],
        }
    if config.get('landmarks'):
        data['landmarks'] = [landmark_payload(spec, buildings) for spec in config['landmarks']]
    if config.get('water'):
        if (config['water'].get('coastline') or {}).get('side') == 'osm':
            data['water'] = coast_side_water(roads_source, to_local, config, boundary)
        elif config['water'].get('coastline'):
            data['water'] = coast_water(roads_source, to_local, config, boundary)
        else:
            data['water'] = water_payload(boundary, config['water'])
    data['note'] = config['note']
    data['provenance'] = {
        'globfpNominalYear': 2020,
        'osmSnapshot': roads_source['osm3s']['timestamp_osm_base'],
        'inputsSha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in sorted(files.values())},
        'note': config['provenance']['note'],
    }
    if boundary_file:
        # 行政边界是裁剪合同的一部分：文件、sha256、OSM relation 与许可都写进数据，
        # 换边界就会同时改字节与署名，测试也能发现"数据没换但边界换了"。
        boundary_path = source / boundary_file
        relation = next((feature for feature in admin['features']
                         if feature.get('id', '').startswith('relation/')), None)
        data['provenance']['boundary'] = {
            'file': boundary_file,
            'sha256': hashlib.sha256(boundary_path.read_bytes()).hexdigest(),
            'osmRelation': relation['id'] if relation else None,
            'licence': (relation or {}).get('properties', {}).get('licence'),
            'usedFor': 'buildings and roads clipped to the district inside the bounding box',
        }
        data['provenance']['boundaryEvidence'] = config['provenance']['boundaryEvidence']
    if 'landmarkEvidence' in config['provenance']:
        data['provenance']['landmarkEvidence'] = config['provenance']['landmarkEvidence']
    if 'named' in sources:
        data['provenance']['osmNamedBuildingReference'] = (
            f"{len(sources['named'].get('elements', []))} named OSM buildings retained as reference; "
            'massing comes from 3D-GloBFP only.')
    if 'landmarks' in sources and not config.get('landmark'):
        reference = (f"{len(sources['landmarks'].get('elements', []))} OSM landmark outlines retained as reference "
                     f"({', '.join(spec['id'] for spec in landmarks)} added as ctbuh massing).")
        if extra_specs:
            reference += (f" {len(extra_specs)} OSM building outlines added as ordinary estimate massing "
                          f"({', '.join(spec['id'] for spec in extra_specs)}, OSM height tags).")
        data['provenance']['osmLandmarkReference'] = reference
    data['cleaning'] = {
        'minimumAreaM2': 4,
        'simplifyToleranceM': 0.25,
        'discardedSmallOrDuplicateParts': rejected,
        'globfpFeaturesClippedByLandmark': cut,
        'spawnClearanceM': round(clearance, 2),
    }
    if extra_specs:
        # 只在配置了补充建筑的场景追加：福田的 cleaning 字段顺序/内容不能变（字节合同）。
        data['cleaning']['globfpFeaturesReplacedByExtraBuildings'] = extra_replaced
        data['cleaning']['globfpFeaturesClippedByExtraBuildings'] = extra_trimmed
    if config.get('boundary'):
        data['cleaning']['globfpFeaturesOutsideBoundary'] = outside_boundary
    return data


def build(source=DEFAULT_SOURCE):
    """历史入口（福田）；test_futian.py 仍按这个名字 import。"""
    return build_scene('futian', source)


def main(argv=None):
    parser = argparse.ArgumentParser(description='生成城市街区运行数据（GloBFP 建筑 + OSM 路网）')
    parser.add_argument('--scene', choices=SCENE_NAMES, default='futian',
                        help='futian=福田样板街；nanshan=南山 5×5 样区；'
                             'nanshan-wide=南山 8×8 全区（按行政边界裁，只作切分输入）')
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE,
                        help='裁片输入目录（默认 world/tools/build-city/source）')
    parser.add_argument('--output', type=Path,
                        help='输出文件（默认 world/assets/city/<scene>.json）')
    args = parser.parse_args(argv)
    output = args.output or WORLD / 'assets/city' / SCENES[args.scene]['output']
    data = build_scene(args.scene, args.source)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False),
                      encoding='utf-8')
    try:
        shown = str(output.resolve().relative_to(WORLD.parent.resolve()))
    except ValueError:  # --output 指向仓库外（例如 tmp 或另一个 clone）时就给绝对路径
        shown = str(output.resolve())
    evidence = {'scene': args.scene, 'output': shown,
                'buildings': len(data['buildings']), 'roads': len(data['roads']),
                'landmarks': [entry['id'] for entry in data.get('landmarks', [])],
                'extraBuildings': [spec['id'] for spec in SCENES[args.scene].get('extraBuildings') or []],
                'waterRings': len(data['water']['rings']) if data.get('water') else 0,
                'boundary': data['provenance'].get('boundary'),
                'tileOnly': bool(SCENES[args.scene].get('tileOnly')),
                'placements': len(data['street']['placements']),
                'spawn': data['spawn'],
                'bytes': output.stat().st_size, 'cleaning': data['cleaning']}
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
