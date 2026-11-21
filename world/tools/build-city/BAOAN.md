# 宝安接入（准备中）

宝安按「区域接入-管理员手册」的标准流程接入，复用南山已跑通的瓦片流式（`split_tiles.py` → `src/city/tiles.ts`），
**不另造加载器**。本文件只记录宝安特有的取舍与待核实项；通用规则见 `docs/区域接入-管理员手册.md`。

## 流程

```bash
# 1) 下载原始输入（能访问 Overpass 的机器；产物放下载暂存区，不进 git）
python world/tools/build-city/fetch_region.py osm    --bbox <试点 bbox> --out tmp/baoan-raw
python world/tools/build-city/fetch_region.py globfp --bbox <试点 bbox> --input <GloBFP 官方分块> --out tmp/baoan-raw
# 2) 裁进仓库
python world/tools/build-city/crop_inputs.py --globfp tmp/baoan-raw/globfp.geojson --osm tmp/baoan-raw/osm.json \
    --prefix baoan-pilot --bbox <试点 bbox>
# 3) 在 build_city.py 的 SCENES 加 'baoan'（必须带 'roadWidths': ARTERIAL_WIDTHS），生成并切瓦片
python world/tools/build-city/build_city.py --scene baoan
python world/tools/build-city/split_tiles.py --scene baoan
# 4) test_city.py 加宝安断言；main.ts/index.html 入口由 L 接线
```

## 宝安特有的规则

| 项 | 规则 | 原因 |
|---|---|---|
| 路宽表 | 场景配置写 `'roadWidths': ARTERIAL_WIDTHS` | 默认表不含 trunk/motorway/*_link，宝安大道、广深公路、沿江高速、机荷高速会整条消失 |
| 水面 | 用 OSM 海岸线/水面多边形，不用矩形背景板 | 宝安海岸在西侧，形状不规则（填海区、河口） |
| 立面 | 外观参数走 `src/city/facade-grammar.ts#facadeSpec`（底商/楼身/楼顶三段 + 每栋楼稳定种子） | 宝安大量城中村和厂房，按高度三分会千楼一面 |
| 互动点 | 结构见 `src/city/poi.ts` | 玩法/交互层按 `kind` 分派 |

## 待核实（开工前必须在地图上确认，确认后删掉这一节对应行）

- 试点 2×2km：宝安中心区·欢乐港湾一带（含前海湾海岸、湾区之光摩天轮、高层办公、附近城中村）。**bbox 未定**。
- 核验地标及高度来源（CTBUH/官方记录），GloBFP 会低估超高层。
- 出生点（距建筑 >2m、首帧朝向地标）。

## 已知缺口（未做，不是已通过）

- 桥/隧道/`layer≠0` 仍被生成器整段丢弃；高架是 P1（需要 data.ts 扩展 `elevated` 字段，冻结接口，先和 L 商量）。
- 建筑类别（城中村/厂房/住宅等）还没进数据：`facadeSpec` 目前按高度推断类别，等生成器从 OSM landuse 写入真实类别。
- multipolygon 水面（深圳湾、茅洲河口、水库）：`fetch_region.py` 下载 `relation[natural=water]`/`relation[waterway=riverbank]` 后摊平成 way（tags 带 `aio:relation`、`aio:role`，inner 环是岛）；`crop_inputs.py` 也直接认 relation 的成员几何，没几何的元素会在 stderr 和报告 `noGeometry` 里列出，不再静默丢。
- **`build_city.py` 仍不消费 OSM 水面**：水面还是配置里的矩形（`water`）。宝安海岸线是斜的，需要按 `aio:relation` 把 outer/inner 拼成多边形、与 coastline 合成海面，这是下一步。
- 地形平地近似；铁仔山/凤凰山一带会失真。
