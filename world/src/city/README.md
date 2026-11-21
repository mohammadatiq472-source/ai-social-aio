# 街区场景（福田 / 南山）与程序化零件

## 范围与入口

`?scene=futian|nanshan` 走同一个 `CityScene`，数据各是一份 `assets/city/<scene>.json`：

| scene | 内容 | 样板街零件 |
|---|---|---|
| `futian` | 福田约 2×2km，1,230 体块 + 809 段路网 | 有（铺装/树/灯/长椅/路牌/雨棚/地标竖向构件） |
| `nanshan` v0.3 | 南山后海/深圳湾约 5.1×5.5km，**12,194 体块 + 4,558 段路网**（默认走 1km compact JSON 瓦片），春笋 392.5m（`landmarks[]`），深圳湾水面 1 环，40 个树/灯 | **无铺装**（`paving=[]`，树/灯贴地不走铺设） |

入口是 `runtime.ts#loadCity(scene)`；`?scene=` 的解析与页面 UI 在 `main.ts`/`index.html`（公共脊柱，归 L）。

福田样板街位于平安金融中心东侧，路边段约 200m；道路大位置来自 OSM，但新增铺装、设施与入口雨棚是设计示意，不是测绘复原。其余建筑仍是估高体块，不宣称精细实景。南山 v0.3 有一处核验地标（春笋 392.5m，OSM 轮廓 + CTBUH 高度）与深圳湾远景水面，但**没有铺装样板街**；水面/岸线/屋顶设备/远山/人行道/车都是视觉示意，不是岸线、屋顶设备或停车的测绘。南山默认走 `assets/city/nanshan/index.json` + `tiles/*.json`（见「瓦片流式加载」），单 JSON `nanshan.json` 保留为回退/对照。

不修改 AIO 群聊、不更换 three.js/Rapier、不读取或移植 `aio-world/src`。世界的位置写入口、固定物理步长和角色控制器继续使用原系统。

**多街区的关键约束**：装配代码里不许出现某个街区的名字、坐标或高度。地标、雨棚、路牌文字全部来自数据；数据没声明的就不建（宁可少一个零件，也不要在别的街区凭空长出一栋平安金融中心）。新增街区 = 加一份 JSON + 在 `CitySceneKey` 上加一个 key。

## 文件与所有权

| 文件 | 管什么 | 修改边界 |
|---|---|---|
| `data.ts` | 城市与零件数据类型、加载边界校验 | 协议坐标是米；`landmark/canopy/signs/note` 是可选的（没有就不建/不写）；不改变世界核心冻结类型 |
| `geometry.ts` | 普通建筑/地标体块、米制 UV、立面分桶、路面、屋顶细节、水面/岸线/远山 | 渲染几何与碰撞顶点必须同源；`roofGeometry`/`shoreGeometry`/`ridgeGeometry` 是**纯视觉**（不进 `colliderArrays`） |
| `landmark.ts` | 收分曲线插值（`landmarkScale(profile, height)`）、轮廓边界 | 曲线来自数据（`landmark.profile` / `landmarks[].profile`）；`PING_AN_PROFILE` 只是旧签名兜底与生成器参考 |
| `materials.ts` | 物理立面、PBR石材/沥青、颜色与室外光照、水面/岸线/屋顶/远山材质、夜间亮窗 | 立面atlas本地生成；三种色调（冷蓝/青绿/银灰）由 id 稳定分桶；PBR贴图打包在本地，运行时不请求外部CDN；`emissiveMap` 复用颜色 atlas；不改原房间预设 |
| `kit.ts` | 街树、树池、灯、长椅、路牌、雨棚、地标竖向构件 | 几何集中生成和合并；**零件的位置/尺寸/文字来自数据**；基座高度按"脚下有没有铺装"逐点判断；没有字段的零件不建 |
| `runtime.ts` | `loadCity(scene)`（瓦片索引优先/单 JSON 回退）、装配、真实碰撞、视觉图层（水/岸线/人行道/车/远山/屋顶）、夜间亮窗、UI、资源销毁 | 不写玩家 transform，不调整角色手感；视觉图层不烘焙碰撞；空几何不建 mesh、不烘焙 |
| `tiles.ts` | 瓦片索引/单片校验、`TileStreamer`（LOD0/LOD1/预算/视锥优先）、每片 `city-roofs`、250m 碰撞环、`DynamicGround` | 契约见 `docs/world/瓦片格式-v2.md`（v3 compact JSON）；碰撞复用 LOD0 顶点；屋顶只给 LOD0 且不 bake；地面块 ≤128m |
| `city.test.ts` / `kit.test.ts` | 几何、数据、真实 Rapier 接触与零件合同 | 既有凹轮廓/内院/贴墙/地板接缝测试不能删除；南山用例缺 `nanshan.json` 时必须**红**而不是 skip |

输入：`../../tools/build-city/source/` 保存裁出的 GloBFP、OSM 建筑与路网，不依赖临时目录。
生成器：`../../tools/build-city/build_city.py --scene futian|nanshan`（`build_futian.py` 保留兼容）。
运行数据：`../../assets/city/futian.json`、`../../assets/city/nanshan.json`，随现有资产拷贝流程进入 dist。

## 坐标与数据

- 每个 scene 自己的原点：福田 `[114.054, 22.540]`，南山 `[113.945, 22.532]`（写在各自 JSON / 瓦片索引的 `origin`）；+X 向东，+Z 向南，+Y 向上，单位米。南山 v0.3 的 `bounds` 是 `[-2571.85, -2768.44, 2571.85, 2768.44]`（约 5.1km 东西 × 5.5km 南北）。
- 局部米制转换使用 WGS84 椭球在原点的曲率半径；测试将样区四角对照独立 ECEF 切平面，误差要求 <1m。
- `heightSource=estimate`：GloBFP 估高，名义年份 2020；`ctbuh`：福田平安金融中心与南山春笋（各 1 个，全数据共 2 个）。
- 建筑轮廓面积 <4m² 的碎片被过滤，简化容差 0.25m；不修饰为精确城市完整率。
- 地标替换先从 GloBFP 裁去与 OSM 地标重叠的部分，再加入地标；禁止两个来源直接叠放。南山春笋来自 OSM way/529272473 的 37 点轮廓 + CTBUH 392.5m，`heightSource='ctbuh'`。
- `street.paving` 是带孔洞的多边形列表，已减去建筑外扩 0.4m，避免铺装穿进楼体。**允许为空**（南山），此时不铺装、也不烘焙铺装碰撞。
- `street.placements` 保存 `kind/x/z/yaw`，sign 允许带 `label`（≤40 字，用于路牌文字）。本版只支持 yaw=0，非零值校验拒绝；生成位置已经按建筑净空筛选，不要仅改随机种子后盲放。
- 树要求距建筑 >3m、长椅 >1.8m、其余 >0.7m；这些是程序化布局约束，不是现场测量值。
- `spawn` 必须在 `bounds` 内（校验器强制）；测试另外要求距建筑轮廓 >2m 且不在建筑内部——南山 v0.3 的出生点由数据线选点（`[102.87, 0, 1827.17]`），不是手填的。
- 可选字段：`landmark`（单地标，福田）、`landmarks[]`（多核验地标，南山春笋）、`street.canopy`、`street.signs`、`water`、`note`。**都没写 = 都不建**，这条是跨街区的默认行为。
- `water` 是**远景水面**（南山：bounds 南沿以南，level -0.1），只渲染、不参与碰撞。正常玩法走不到水里。瓦片路径从 `index.json` 读同一份 `water`。

## 立面组件

入口：`facadeStyle(building, landmarkIds?)`、`facadeMaterial(style, stoneImage, tint)`。当前使用MeshPhysicalMaterial；颜色、粗糙度、金属度和微法线分别生成，不再把相同的蓝色渐变画进每扇窗。

| 样式 | 选择规则 | 材质意图 | roughness / metalness |
|---|---|---|---|
| glass | 数据声明的地标，或高度 ≥65m | 反射玻璃、细金属框、层间带 | 1×贴图 / 1×贴图 |
| office | 24m ≤高度 <65m | 石材颗粒、成组窗、部分百叶 | 1×贴图 / 1×贴图 |
| stone | 高度 <24m | 浅石材裙房、大窗面、水平石材带 | 1×贴图 / 1×贴图 |

**三种色调**（`FACADE_TINTS`）：`cool` 冷蓝、`teal` 青绿、`silver` 银灰，区别在窗面 RGB 偏移与整体明度，不改变窗格/材质结构。`facadeChunks(data)` 用 FNV-1a（`stableHash`）把 `building.id` 稳定映到一个色调，再按 `样式 × 色调` 合并——同一栋楼每次加载都是同一个颜色，不依赖运行时随机或数据顺序。

**draw call 预算**：立面上限 `3 种样式 × 3 种色调 = 9 批`（任务给的上限是 ≤36，当前实测 **9 批**）。为什么没有继续叠四象限：9 批已经比原来的 3 批多，再叠四象限会到 36 批；在 2~4km 城市尺度上少 draw call 比细粒度视锥剔除更值。`buildingChunks` 仍保留四象限分桶（≤4 批），只用于低层几何/碰撞测试；运行时用 `facadeChunks`，不能把"四批测试"误读成最终场景总 draw call。

公共参数 `FACADE_MODULE`：模块宽3.2m、高3.8m；atlas为512×512，横4模块×纵6模块，每模块双窗，共48窗，实际重复范围12.8×22.8m。RepeatWrapping，anisotropy=8。这里只是视觉重复尺度，不能据此反推实际楼层数。玻璃粗糙度由约32–51/255的贴图值控制；金属框与窗面分开，clearcoat=0.85（非玻璃模板0.25），不启用transmission穿透，因为当前没有室内几何。9 个立面材质各有 4 张 512² 生成的 atlas（颜色/粗糙度/金属度/法线）；这是 GPU 纹理内存成本，不是网络传输（本地 canvas 生成）。

UV 按墙面世界米制生成，按法线选择水平 X 或 Z；屋顶固定采样材质底色，不能把窗格铺满屋顶。建筑 ID 决定小幅、可复现的颜色差异，不使用运行时随机。

## 实际PBR材质与反射

材质输入为Poly Haven CC0素材，不是参考建筑照片：

| 材质 | 作者与来源 | 周期 | 用途 |
|---|---|---:|---|
| Granite Tile 04 | Amal Kumar，[官方页](https://polyhaven.com/a/granite_tile_04) | 2m | 铺装、步道、立面石材颗粒 |
| Asphalt 02 | Rob Tuytel，[官方页](https://polyhaven.com/a/asphalt_02) | 3m | 道路颗粒、细裂纹与粗糙度 |

每套包含颜色512²、OpenGL法线256²、ARM256²；六张WebP合计157,636字节。颜色图使用sRGB，法线/ARM使用线性空间；ARM的R是AO、G是粗糙度，石材/道路不使用B作为金属度。granite颜色在生成阶段做饱和度0.1、亮度1.35的中性灰调整；法线缩小后重新归一化。原图与官方MD5留在 `tools/build-city/source/materials/`，输出、作者、来源、变换、SHA256留在 `assets/city/materials/manifest.json`。

`build_materials.py`可离线复用已下载原图重建；首次缺文件才按已记录官方URL下载，MD5不符即失败。浏览器只读取本地打包贴图，加载失败显示明确错误，不能悄悄退回旧草稿材质。

反射用位于样板街上方18m的128² CubeCamera采样当前街区，经PMREM生成环境贴图。进场与光照预设切换结束时更新，不逐帧重拍；是局部静态反射近似，不是SSR或逐窗精确镜像，不承诺准确反射动态人物。

**three.js r170的坑**：material.envMap为空时，renderer会用scene.environmentIntensity覆盖材质的envMapIntensity。立面和金属零件因此必须显式绑定捕获的贴图；玻璃反射增益4，普通立面1.8。更新时先使用原环境做采样，再切换所有绑定、释放旧RenderTarget；dispose也要恢复原环境并释放新目标。

金属竖杆/灯杆与木料/叶片不再共用同一粗糙度：`kit.ts`写入surface属性，金属为roughness0.28/metalness0.85，其它为0.88/0。碰撞几何没有改变。

## 视觉图层：水面 / 岸线 / 屋顶 / 远山 / 人行道 / 低模车

这些层都是**纯视觉**产物（`runtime.ts#waterLayerParts` / `cityLayerParts` / `geometry.ts#roofGeometry` / `ridgeGeometry`），**不进碰撞、不 `bakeTrimesh`**：它们是远景、贴地装饰或楼顶细节，不该挡住玩家。全部进 `CityScene.dispose()` 的同一条销毁路径（geometry/material/texture 全部登记）；瓦片模式下屋顶按片挂、随 LOD 升降销毁。

| 图层 | 来源 | 参数 | 是否碰撞 / 投影 |
|---|---|---|---|
| `city-water` | `data.water.rings`（局部米制多边形）+ `level ?? -0.1` | **深圳湾蓝绿 0x2e5f73**，roughness **0.05**、metalness **0.3**、clearcoat 0.45、**envMapIntensity 2**；显式 envMap（`captureEnvironment()`） | 不碰撞；`castShadow=false`、`receiveShadow=false` |
| `city-shore` | 同上水环，沿内侧铺一条 7m 亮带（`SHORE_WIDTH`），比水面高 0.02m | 浅冷白 0xe2ece6、roughness 0.92、metalness 0（纯色几何，不用贴图，不绑反射图） | 不碰撞；不投影不接收 |
| `city-roofs`（单 JSON 一个 / 瓦片每片一个） | `data.buildings` 的**外轮廓**（收分地标按顶部比例缩） | 女儿墙高 0.5–0.8m（按 `building.id` hash）、厚 0.28m，顶点色比立面屋顶深一档；>60m 的楼再加 1–3 个设备盒（3–6m 宽、1.2–3.1m 高，位置按 hash） | 不碰撞、不 bake；`castShadow=false` |
| `city-ridges` | `data.bounds`（不写死街区坐标） | 南/西边界外 3.2km 起一条低模山脊（分段 56×2、最高 ≤260m）+ 远景地坪；深蓝灰 0x35485a、顶点色、`fog: true`（远山靠雾收尾） | 不碰撞、不投影 |
| `city-sidewalks` | `data.roads` 里 `walkway=false` 且宽度 ≥7m 的车行道，两侧各一条 | 宽 1.2–1.8m（按 `road.id` 稳定取）、高 0.035m、浅灰花岗岩贴图 | 不碰撞；接收阴影 |
| `city-cars` | 同上道路里最长路段中点，离最近楼墙 ≥半路宽+4m，按 id 排序等距取 10 辆 | 车身 1.85×0.62×4.3 + 车顶 1.6×0.5×2.4，顶点色，静态合并成一个 mesh | 不碰撞；投影 |

水面与车是低粗糙度/带金属度的材质，必须**显式绑定** `captureEnvironment()` 的反射图（three r170 在 `envMap` 为空时会用 `scene.environmentIntensity` 覆盖 envMapIntensity）；人行道复用已加载的花岗岩贴图，不额外请求资产。岸线亮带与远山**故意不绑**反射图：白沫是粗糙面，绑了会变成一条发亮的银边。

水面多边形逐环绕序归一到逆时针后再三角化，保证法线朝上（朝下会被 FrontSide 材质剔除、整片消失）。南山的海面在 `bounds` 南沿以南，房间地板（由地面块推出，约到 z=2320）会遮住靠岸约 105m 的一条；再往南是可见海面，这是远景示意，不是精确岸线。

远山为什么还要一片"远景地坪"：南山的水面只铺到 `bounds` 南沿外 2km（z≈4768），山脚在 5968，中间 1.2km 没有几何时露出来的是**背景色**，看起来像倒置的地平线。地坪铺在水面以下 0.25m（低于 `water.level=-0.1`，不会 z-fighting），从山脚一直铺到城市下方。

空数据安全：没有 `water` 字段 → 不建 `city-water`/`city-shore`；没有车行道 → 不建人行道/车；没有 >6m 的楼栋轮廓 → 不建 `city-roofs`；几何为空时直接 `dispose()`，不留下 `mergeGeometries([])` 的 null。

**屋顶细节的三条硬边界**（改之前先读 `geometry.ts#roofGeometry` 注释）：
1. 不参与碰撞——它是独立几何，`mount`/`TileStreamer` 单独挂 mesh；立面几何才是碰撞源（`colliderArrays()` → `bakeTrimesh`）。
2. 只给 LOD0——LOD1 是 600m 外的盒子，加屋顶纯属浪费三角形；降级时 `removeLod0()` 连它一起拆。
3. 确定性——女儿墙高度/设备数量/位置全部来自 `stableHash(building.id)`，同一栋楼每次加载一样。

建成项目截图只用于外观对照，不打包进游戏纹理：[入口幕墙](https://images.adsttc.com/media/images/5a4c/6cbf/b22e/38b5/fa00/03e1/medium_jpg/4_Ping_An_FC_(c)_Tim_Griffith.jpg?1514958007)、[石材细部](https://images.adsttc.com/media/images/5a4c/6ca7/b22e/38b5/fa00/03e0/medium_jpg/2_Ping_An_FC_(c)_Tim_Griffith.jpg?1514957984)。照片版权不因作为参考而转移。

## 瓦片流式加载（v3 compact JSON）

`?scene=nanshan` 默认走瓦片：`assets/city/<scene>/index.json` + `tiles/<id>.json`；没有瓦片索引的街区（或加 `?tiles=0`）回退单 JSON —— 两条路径共用同一套 `CityScene` 装配与碰撞规则。

**为什么是 compact JSON 而不是烘焙二进制**（Lead 2026-11-21 实测）：5×5（12,194 栋）烘焙 LOD0 总 **56.1MB**（单片 median 1.78MB / max 3.8MB），同数据 compact JSON 只有 **3.24MB**（median 113KB / max 251KB）。按这个比例，20 万栋 baked ≈900MB、compact ≈54MB —— 只有 compact 能扩到全深圳。代价是每片现建几何（~3k 栋/片），用「每帧 1–2 片 / ≤8ms」的预算兜住。

数据格式（字节级契约见 `docs/world/瓦片格式-v2.md`）：

- `index.json`：`version=3`、`tileSize=1000`、全局 `bounds/origin/spawn/name/note/attribution/landmarks[]（带 rings）/water/street/counts`，`tiles[]` 每项 `{id,bounds,file,counts}`。
- `tiles/<id>.json`：`{buildings:[CityBuilding], roads:[CityRoad]}`，结构与 `data.ts` 完全一致；`street` 不按片重复。
- 切片规则：建筑按轮廓中心归片；道路裁到片；跨片建筑整体归中心片。

`tiles.ts` 的行为：

| 项 | 规则 |
|---|---|
| 加载 | `loadCity` 先 fetch index；`?tiles=0` / index 404 → 单 JSON；其它非 2xx 抛错（坏索引不悄悄回退掩盖烘焙故障） |
| 出生 | `loadCity` 先 await spawn 3×3 JSON（校验 `counts`），`mount()` 同步建 LOD0 + 250m 碰撞（冻结接口仍是同步 `mount`） |
| 距离 | <600m LOD0；600–1500m LOD1；1500–2000m 只保留已加载片、不再新加载；>2000m 立即卸载 |
| 预算 | 每帧最多 2 片 / 8ms（加载/建几何/升降 LOD/补碰撞共用）；卸载与移出碰撞环立即执行 |
| 顺序 | 已加载片补碰撞 → 视锥内（-2000m 加权）→ 距离近 → 降级 |
| LOD0 | 复用 `facadeChunks`（样式×色调，每片 ≤9 批）+ 每片一个 `city-roofs`（女儿墙/设备盒），9 个立面材质与 1 个屋顶材质跨片共享，不额外建 atlas |
| LOD1 | 每栋 12 三角盒子（`lod1Geometry`），顶点色来自 `materials.ts#TILE_TINT_RGB`，不采样 atlas；**不建屋顶细节** |
| 道路/人行道 | 每片 `roadGeometry` ×2（车行道/步道）+ `sidewalkGeometry`，随 LOD 保留、升降不重建 |
| 碰撞 | 仅 250m 内的 LOD0 用 `colliderArrays()` bakeTrimesh；离开即 remove。渲染与碰撞同一份顶点（屋顶几何不在碰撞源里） |
| 地面 | 瓦片模式不给全城铺碰撞：`DynamicGround` 维护 5×5 个 128m 块跟随玩家（跨格 `setTranslation`，不重建 collider）；视觉地面由 `RoomVisual` 的全局 `room-floor` 平面负责 |
| 销毁 | `CityScene.dispose()` 先 `streamer.dispose()`（几何/网格/碰撞）再 `ground.dispose()`，与既有台账同一路径 |
| 调试 | `__worldDebug.read()` 增加 `tilesLoaded/lod0/lod1/collisionTiles/loadsLastFrame/msLastFrame`（city 模块包装 `read`，`main.ts` 不改；dispose 还原） |

`?tiles=0` 用于对照/排障。`?lod=0`（只加载 LOD1）**未做**：只渲染盒子会给玩家"能穿墙"的错觉，需要更多配合再评估。

## 地标组件

地标由数据声明，代码里不认任何 id/高度常量：

- `data.landmark`：**单个**核验地标（福田 `way/535860513`，OSM 唯一实体 Q1077308，平安金融中心）。
- `data.landmarks[]`：**多个**核验地标（南山 `way/529272473`，春笋/中国华润大厦 392.5m）。
- 两者合并成 `id → profile`（`geometry.ts#landmarkProfiles`），同 id 先到先得。地标 id 必须能在 `data.buildings` 里找回同一栋楼。

行为：

- 信息卡（`cityInfoText`）同样合并两个字段，按 id 去重后列出所有声明地标及其参考高度；没有声明就只说"建筑高度均为模型估算"。
- 找回失败（id 对不上）→ 不建竖向构件，也不拿"最近的那栋楼"冒充地标。
- 两个字段都没声明 → 完全不建，楼体按 1 段直筒挤出。
- 楼体收分只认数据：`buildingGeometry(building, profile?)` 给了 profile 就按它收 60 段；只有**没给 profile** 的平安 id 才回落到 `PING_AN_PROFILE`（旧签名兼容，福田行为不变）。
- 竖向构件（`kit.ts`）遍历 `landmark` + `landmarks[]`、同 id 去重，每条按自己的 profile 定位；找不到建筑就跳过。主体半径 0.8m、末段（曲线倒数第二个节点以上）0.3m。

福田的 `data.landmark.profile`（`[高度 m, 水平比例]`，高度严格递增）：

| 高度 m | 水平比例 |
|---:|---:|
| 0 | 1.000 |
| 12 | 1.000 |
| 60 | 0.985 |
| 400 | 0.860 |
| 540 | 0.760 |
| 565 | 0.660 |
| 599.1 | 0.025 |

南山的 `data.landmarks[0].profile`（春笋，OSM 37 点轮廓 + CTBUH 392.5m）：

| 高度 m | 水平比例 |
|---:|---:|
| 0 | 1.000 |
| 20 | 0.990 |
| 100 | 0.950 |
| 200 | 0.860 |
| 300 | 0.700 |
| 360 | 0.450 |
| 392.5 | 0.080 |

体块沿高分 60 段，线性插值比例；底部轮廓保持 OSM 数据，顶部收成窄冠。八条竖向银色构件按**同一条 `profile`** 定位：基底外轮廓内缩（大点取 9m，小于 27m 的体块按边长 1/3 收，避免锚点挤到反方向）。

**这是识别型简化，不是施工图。** 高度有外部参考（CTBUH/OSM 标签），但收分节点、截面比例、构件半径与入口均为本项目建模参数；不得写成"真实测量尺寸"。改变曲线后必须同时复跑楼墙接触与顶高/基底测试（`city.test.ts` 的春笋收分与 `kit.test.ts` 的收分单调 + 顶高断言会先红）。

参考：
- [CTBUH 建筑记录](https://www.skyscrapercenter.com/shenzhen/ping-an-finance-center/54)：599.1m。此次核对了搜索索引与 OSM 标签，CTBUH 正文请求返回 403，不声称拿到了测绘数据。
- [KPF 项目介绍 / ArchDaily，2018](https://www.archdaily.com/886473/ping-an-finance-centre-kpf)：建成后的收分外立面、裙楼与不锈钢构件；避免使用 2012 年未建成方案。
- [KPF 建筑近景参考照片](https://oss.gooood.cn/uploads/2018/02/003-Ping-An-Finance-Centre-Shenzhen-China-by-KPF-960x1450.jpg)：只作观察参考，不打包进运行资产，不沿用图片版权。

## 街道零件参数

统一入口 `buildStreetKit(data)`；**树/灯/长椅/树池**参数集中在 `STREET_KIT`，颜色集中在 `STREET_PALETTE`；**雨棚与路牌文字来自数据**。

| 零件 | 参数（米） | 生成方法与约束 |
|---|---|---|
| 街树 | 干高 2.8、干半径 0.16；冠半径 1.75、冠中心高 3.8（约原来 0.82 倍） | 圆柱树干 + 三簇低面数树冠；树冠最低处必须高于2m（3.8−1.75×0.78≈2.4m） |
| 树池 | 半边 1.4，边框宽 0.18、高 0.24 | 四段矩形边框，底面跟随铺装高度 |
| 路灯 | 高6、杆半径0.075、横臂1.8 | 杆、臂、灯壳合并；亮面是Basic材质，不为每盏灯添加PointLight |
| 长椅 | 宽2.2、深0.65、座高0.46、靠背总高约0.9 | 金属脚架与木条合并；有碰撞，本版尚未接E坐下交互 |
| 路牌 | 板宽3.3、高0.85；中心高2.2 | 文字 = `placement.label ?? '街区示意'`；本地Canvas；只标已知地名，不编造商户或设施 |
| 雨棚 | 来自 `street.canopy`（福田：中心 x=-333.1、z=372.08；宽7、进深16、高4.2；label=平安金融中心） | 没有 `canopy` 就不建；顶面与支撑共用碰撞几何；立柱/檐口位置按宽深等比推导 |
| 铺装 | 高0.12；颜色512²、法线/ARM256²，周期2m | CC0花岗岩PBR；真实薄台面，渲染和碰撞同源；`paving` 为空则不建 |

`streetSign()` 为路牌生成1024×256文字纹理；建筑入口使用1024×128透明底文字，不再放巨大的蓝色广告板。文字由本地字体绘制，不是外部图片。尺寸位置由标签记录决定；页面文字继续用 textContent，不能把数据当HTML。

各几何部件按顶点颜色合并为一个街道实体网格；灯具亮面独立一批；路牌文字独立网格。模型细节只落在样板街，不在全城散布大量道具。

**树/灯的基座高度**：每个 placement 先用点-多边形（含孔洞）判断脚下有没有铺装——有才用 `street.pavingHeight`（福田 0.12），没有就是 0（南山 `paving=[]`，40 个树/灯贴地）。这不是"全城统一台面"：铺装本身是局部多边形。

**空 street**：`streetKitParts()` 只返回有顶点的零件，`mount` 只遍历它——空几何不建 mesh、不调 `bakeTrimesh`，剩下的空几何就地 `dispose()`。`combine([])` 返回空 `BufferGeometry`，不返回 `mergeGeometries([])` 的 `null`（null 会在 `new THREE.Mesh` 处炸掉整个 `mount`）。南山 v0.2 有 40 个树/灯但**没有铺装**：街道实体网格与灯具亮面会建，`city-paving` 不建。

## 物理硬约束

1. 地面碰撞块最大128m。两公里宽的薄cuboid在真实探针中会导致约22cm下沉；不要合回巨型块，不要通过抬高玩家或放松断言绕过。
2. 铺装顶面0.12m、出生点y=0.12；玩家胶囊必须从 `spawn.y + capsuleCenter` 创建。原房间spawn.y=0，行为不变。
3. 建筑、铺装、街道实体网格的顶点同时交给渲染和 `bakeTrimesh()`；只有贴在实体表面的路牌文字、灯具亮面不另造碰撞。
4. 不能用建筑包围盒替换凹轮廓/内院，否则会制造看不见的墙。
5. 相机与玩家位置分开；鸟瞰只改相机，不传送角色。
6. 固定物理步长、KCC参数、模型朝向、动画状态机不归此模块调整。

## 光照与资源预算

`CITY_LIGHTING` 提供 day/dusk/night/storm，注入 WorldRenderer 实例；不得原地改全局 `LIGHTING_PRESETS`，原房间需要保持不变。

白天：天空 0xc4d0d8、**暖灰海雾 0xd8d3c9**、太阳强度 2.3、半球光 0.72（sky 0xdbe6ec / ground 0x77736c）、场景 IBL 0.6、曝光 1.0；显式绑定反射图的立面另用自身增益，水面 envMapIntensity 2。城市雾距离仍乘 70：`near 36 / far 84` → 实际约 2520m / 5880m，比原来的 1400m / 3500m 更远，站街能看见深圳湾对岸的轮廓而不是一堵灰墙。局部方向光阴影跟随玩家，覆盖 90×90m；shadow far=1800，避免高楼超出原房间 60m 裁剪距离。**只改了 `CITY_LIGHTING.day`，原房间 `LIGHTING_PRESETS` 的数值和对象都不动**（`kit.test.ts` 锁着原 background 0x1a2028）。

**夜间亮窗**：9 个立面材质都带 `emissiveMap = 颜色 atlas`（同一张 512² 贴图，**不额外占纹理**）、`emissive = 0xffc98a`（暖色）、出厂 `emissiveIntensity = 0`。`CityScene.update()` 每帧按 `renderer.getLightingState()` 调用 `windowEmissiveIntensity()`：`current === 'night'` 或 `target === 'night'`（0.8s 过渡途中）→ **0.6**，其它预设 → **0**。为什么过渡里就看 `target`：`current` 只在过渡结束才变，否则切到夜晚的 0.8s 里楼是黑的、过渡一结束"啪"一下全亮。**原房间预设与 `LIGHTING_PRESETS` 一个数都没改**（`city.test.ts` 的「原房间光照预设不被夜间亮窗改动」锁着）；`mount()` 末尾也会按当前预设先设一次，避免首帧闪一下黑楼。

**这个做法的真实观感要在验收时说清楚**：颜色 atlas 里窗面是深的（48–70/255）、窗框/石材是亮的，所以夜里亮起来的是**幕墙框与层间带**（暖色描边/网格），不是"每扇窗都开灯"。它读起来像深圳常见的幕墙 LED 描边，而不是写字楼夜景；要真"亮窗"需要一张单独的窗格 emissive mask（按 id hash 点亮部分窗），代价是 9×512² 额外纹理 + 每栋楼的窗格索引，见「未做」。

立面atlas由代码生成，石材与道路使用六张本地CC0 PBR贴图，客户端不请求外部CDN。**不等于零成本**：本地贴图也计首屏传输与GPU纹理内存，反射采样也计初始化开销。每轮需要实测首屏压缩字节与1080p帧时，不能沿用旧白模数字。

CityScene持有并销毁自己的geometry/material/texture/collider、路牌与面板。灯光预设由renderer持有。新增零件必须进入同一销毁路径，不能仅从scene移除。

## 复跑与步行验收

仓库根目录：

```bash
python world/tools/build-city/build_city.py --scene futian
python world/tools/build-city/build_city.py --scene nanshan
python world/tools/build-city/build_materials.py
python world/tools/build-city/test_city.py
python scripts/verify/verify-futian-city.py --shots tmp/futian-street/functional
python scripts/verify/verify-futian-street.py
```

world目录：

```bash
npx tsc --noEmit
npx vitest run src/city/          # 含南山数据/南山 CityScene/空 street/瓦片流式用例
npx vitest run
npm run build
node tools/verify-physics.mjs --url http://127.0.0.1:5199/
node tools/verify-scene.mjs --url http://127.0.0.1:5199/
node tools/verify-perf.mjs --hardware --url "http://127.0.0.1:5200/?scene=futian"
```

`src/city/city.test.ts` 的南山用例**直接读** `assets/city/nanshan.json`（v0.3：12,194 建筑 / 4,558 道路 / 春笋 392.5m / water 1 环 / 40 个 placements）：文件缺失、还是旧数据或数字漂移时它会**红**而不是 skip。`tiles.test.ts` 另外覆盖瓦片路径（真实 `assets/city/nanshan/index.json` 存在时自动读真实片，否则用合成 fixture，不 skip）。想只跑快的那几条可以用 `npx vitest run src/city/ -t 空街区`。当前 `npx vitest run src/city/` 是 **92 项全绿**（city 59 + tiles 21 + kit 8 + material-assets 4）；单 JSON 立面上限 9 批 draw call（≤36 预算），瓦片每片 LOD0 ≤13 批（≤9 立面 + 3 道路/人行道 + 1 屋顶）但材质共享。

## 视觉 P1 实测（2026-11-21，几何口径）

不是帧时实测（浏览器/GPU 验收仍归 Lead），是**几何与 draw call 的静态口径**，用来守住 3×3 / ≤120 draw calls / ≤2.5M 三角形：

| 项 | 单 JSON 南山（12,194 栋全 LOD0） | 出生 3×3（9 片，全部 LOD0） |
|---|---:|---:|
| 立面三角形 | 288,212（9 批） | — |
| 屋顶细节三角形 | 281,484（约 23.5 三角/栋） | — |
| 道路/人行道/街道零件/水/岸线/远山 | 约 102,000 | — |
| **合计三角形** | **≈672,000** | **117,906** |
| **draw calls** | ≈19（9 立面 + 2 道路 + 2 街道零件/灯 + 水/岸线/人行道/车/屋顶/远山各 1） | **78** |
| 最密一片（0_0，1,170 栋） | 8 立面批 + 3 道路 + 屋顶 = **12 批**，44,766 三角 | — |
| LOD1 片 | — | 盒子 + 3 道路 = **4 批** |

**9 片 × 13 批 = 117 ≤ 120**，这是"每片都满 9 个立面批 + 屋顶"的保守上界；实测出生 3×3 只有 78 批（有的片没楼、立面批不足 9 个）。屋顶几何建一片 1,170 栋的瓦片约 22ms（12,194 栋整城约 230ms），比立面的 224ms/片小一个量级；这也是为什么**瓦片模式本轮不加 `city-cars`**：再加一批就是 9×14=126 > 120（单 JSON 的 10 辆车仍在）。

**dev 构建实测（浏览器 `renderer.info`，`__worldDebug.read()`，2026-11-21，软件 GL 只用来读几何/调用数、不看 fps）**：`?scene=nanshan&time=day` 出生点，`tilesLoaded=10 / lod0=5 / lod1=5 / collisionTiles=1`，朝南 **29 draw calls / 102,566 三角形**，朝北（密集 CBD）**48 / 134,492**。`read().scene` 里逐个确认 `city-water` 2 三角、`city-shore` 12、`city-ridges` 226、`tile-2_4-roofs` 184 都存在且 visible=true。切光照预设那一帧会出现 247 calls / 544k 三角——那是 `captureEnvironment()` 的 128² CubeCamera 探针（6 面各渲染一次），下一帧就回落到 29；不是预算回归。

性能命令需先在另一终端运行 `npm run preview -- --port 5200 --host 127.0.0.1`；它检查生产产物，不把 dev 的模块请求当发布体积。

浏览器脚本统一通过 `tools/chromium.mjs` 定位浏览器。功能脚本默认真实GPU，`--software`只用于无GPU环境的功能验证。样板街脚本拒绝把SwiftShader当GPU，固定1920×1080，沿入口→路边→路口真实键盘行走，截图与帧时保存到 `tmp/futian-street/`。不通过传送制造“已走通”的证据。

验收需同时检查：脚底/路沿高度、楼墙与长椅碰撞、门前净空、路牌可读、纹理不游动、路口视线、原房间回归。新版本实测数字写到交接，不把短采样或单张截图冒充全城验收。

**南山 v0.3 现状**：12,194 体块 + 4,558 段路 + 春笋 392.5m + 深圳湾水面 + 40 个树/灯；默认 32 片 compact JSON（总 3.24MB），单 JSON 为回退。`street.paving=[]`，所以**没有铺装**（出生点 y=0；树/灯也贴地）。瓦片路径下的几何/碰撞同源、地面块 ≤128m、LOD 收敛、预算、视锥优先、动态地面与回退已由 `npx vitest run src/city/tiles.test.ts`（含真实瓦片端到端）覆盖。`?scene=nanshan` 的浏览器功能/帧率验收由 Lead 单独跑，**跑通前不要写成已通过**。

## 未做（P1 后续，本轮有意留）

- **逐窗随机亮**：夜间是"幕墙框 + 层间带被暖色描边"（`emissiveMap` 复用颜色 atlas，框比窗亮），不是每扇窗随机开关。要做真"亮窗"需要单独一张窗格 emissive mask（按 id hash 点亮部分窗）+ 每个窗格的世界坐标，会多 9×512² 纹理与一套窗格索引；本轮按"不额外占纹理"取舍。
- **水面动画**：`city-water` 是静态平面，没有法线扰动/流动/浪花贴图；岸线亮带也是静止的。
- **瓦片模式 `city-cars`**：每片 1–2 辆会多一批 draw call（9×14=126 > 120 预算），见上面实测表；要做需要先把每片立面批数压下来或把车并进某个已有批次。
- **北/东侧远山**：只做了任务要求的南/西两侧；北/东边界外仍是背景色（松岗/羊台山方向未做）。
- **南山浏览器功能验收与帧时实测**：Lead 负责；几何口径的数字不等于 1080p 帧时。

## 许可与保留

- 自编零件/程序纹理代码：项目MIT；不复制研究案例的代码、结构命名或资源。
- GloBFP轮廓与估高：Che et al. 2024 / CC BY 4.0；OSM道路与地标轮廓：ODbL 1.0。派生数据继续保留署名与ODbL义务，不因渲染代码是MIT就改称数据也是MIT。
- 本目录源文件、本文档、数据生成器、裁剪输入与测试应一起保留。`tmp/`仅放截图/探针输出/版权参考图，不作为程序化零件的唯一保存位置。
