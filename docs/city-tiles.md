# 城市瓦片接入（公开版）

> 面向各区的管理员/贡献者：一个区如何切成 1km 瓦片、运行时怎么加载、验收看什么。
> 开发仓是邀请制的私有仓；这份公开版只讲格式与流程，不含内部地址。

---

## 1. 为什么要瓦片

实测（5×5km，12,194 栋）：

| 格式 | 总量 | 单片 |
|---|---:|---:|
| 烘焙 LOD0 二进制 | 56.1MB | 中位 1.78MB / 最大 3.8MB |
| **compact JSON 瓦片（默认）** | **3.4MB** | **中位 33KB / 最大 251KB** |

按 20 万栋外推：烘焙 ~900MB，compact ~54MB。所以默认是 **compact JSON 瓦片 + 运行时建几何**，不是把整城烘成二进制。

---

## 2. 目录

```
world/assets/city/<scene>/
  index.json
  tiles/<ix>_<iz>.json
```

- 1km × 1km 一片；建筑按轮廓中心归片；道路按中点归片。
- 密集片可再切 500m 子片，但优先保持 1km。

---

## 3. `index.json`（v3）

```json
{
  "version": 3,
  "scene": "nanshan",
  "tileSize": 1000,
  "bounds": [xmin, zmin, xmax, zmax],
  "origin": [lon, lat],
  "spawn": [x, y, z],
  "name": "南山 · 后海/深圳湾",
  "note": "可选",
  "attribution": [{ "label": "...", "url": "https://..." }],
  "landmark": { "id": "...", "name": "...", "height": 599.1, "profile": [[0,1]], "rings": [[[x,z]]] },
  "landmarks": [{ "id": "...", "name": "...", "height": 392.5, "profile": [[0,1]], "rings": [[[x,z]]] }],
  "water": { "rings": [[[x,z], ...]], "level": -0.1 },
  "street": { "pavingHeight": 0.12, "paving": [], "placements": [], "canopy": null, "signs": null },
  "counts": { "buildings": 12194, "roads": 4558 },
  "tiles": [
    { "id": "0_0", "bounds": [x0, z0, x1, z1], "file": "tiles/0_0.json", "counts": { "buildings": 120, "roads": 40 } }
  ]
}
```

- `street` 是**全局**的（树/灯/雨棚/铺装），不按片重复。
- `landmarks[].rings` 用局部米制轮廓：运行时用它算出生相机朝向。
- `bounds` 是整城；`spawn` 必须在 bounds 内。

## 4. `tiles/<id>.json`

```json
{ "buildings": [ /* CityBuilding: id,name?,height,heightSource,rings */ ],
  "roads":     [ /* CityRoad: id,width,walkway,points */ ] }
```

- 与 `world/src/city/data.ts` 的 `CityData` 同结构；`street/water/landmarks` 不放进片。
- 每片 `counts` 必须与实际数组长度一致；运行时逐片校验。

---

## 5. 运行时行为

| 距离 | LOD | 碰撞 |
|---|---|---|
| < 600m | LOD0 全立面 | 250m 内才建 Rapier trimesh |
| 600–1500m | LOD1 盒子（每栋 12 三角） | 否 |
| 1500–2000m | 保留、低优先级 | 否 |
| > 2000m | 卸载（dispose） | 否 |

- 出生：同步加载 spawn 所在 3×3 LOD0（含 roads/walkways/sidewalks）。
- 运行时：每帧最多 2 片 / ≤8ms；视锥内优先。
- 地面：5×5 个 128m 碰撞块跟随玩家（保持「地面碰撞块 ≤128m」的硬规则）；视觉地面由片/全局平面负责。
- `?tiles=0` → 回退单 JSON `<scene>.json`（排障/对照）。
- 索引 404 或开发服务器把缺失文件回退成 HTML → 自动回退单 JSON；其它非 2xx 抛错，不静默。

---

## 6. 一个区的最小交付

1. `world/tools/build-city/source/<区>-*.geojson|json`：GloBFP / OSM 建筑 / 道路 / 水面 / 地标轮廓。
2. `world/tools/build-city/build_city.py` 的 `SCENES['<区>']`：origin/bbox/landmarks/spawn/note。
3. `world/assets/city/<区>.json`（单 JSON fallback）。
4. `python world/tools/build-city/split_tiles.py --scene <区>` → `index.json` + 1km JSON 片。
5. `test_city.py` 加 `<区>` 断言；`CitySceneKey` 与导航入口由维护者加。

验收：

```bash
cd world
npx tsc --noEmit
npx vitest run src/city/
python tools/build-city/build_city.py --scene <区>
python tools/build-city/split_tiles.py --scene <区>
python ../scripts/verify/verify-<区>-city.py --url http://127.0.0.1:5199/
```

浏览器至少检查：3×3 片加载、`?tiles=0` 回退、出生点不陷地、鸟瞰不传送、瓦片边界不穿/不掉、零 pageerror。

---

## 7. 纪律

- 一个区 = 一个 `assets/city/<scene>/`，不改别人的区。
- 不要改 `world/src/city/tiles.ts` / `runtime.ts` 的流式逻辑；需要新能力先开 issue。
- 不把数据/瓦片/截图提交进 git 之外的临时目录；输入入库 `source/`。
- 许可：GloBFP CC BY 4.0、OSM ODbL 1.0；派生数据保留署名。
