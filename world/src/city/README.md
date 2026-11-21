# 福田场景与程序化零件

## 范围与入口

`?scene=futian` 加载福田约 2×2km。样板街位于平安金融中心东侧，路边段约 200m；道路大位置来自 OSM，但新增铺装、设施与入口雨棚是设计示意，不是测绘复原。其余建筑仍是估高体块，不宣称精细实景。

不修改 AIO 群聊、不更换 three.js/Rapier、不读取或移植 `aio-world/src`。世界的位置写入口、固定物理步长和角色控制器继续使用原系统。

## 文件与所有权

| 文件 | 管什么 | 修改边界 |
|---|---|---|
| `data.ts` | 城市与零件数据类型、加载边界校验 | 协议坐标是米；不改变世界核心冻结类型 |
| `geometry.ts` | 普通建筑/地标体块、米制 UV、立面分桶、路面 | 渲染几何与碰撞顶点必须同源 |
| `landmark.ts` | 平安金融中心识别、收分曲线、轮廓边界 | 599.1m 是参考建筑高度；收分参数是简化建模参数 |
| `materials.ts` | 物理立面、PBR石材/沥青、颜色与室外光照 | 立面atlas本地生成；PBR贴图打包在本地，运行时不请求外部CDN；不改原房间预设 |
| `kit.ts` | 街树、树池、灯、长椅、路牌、雨棚、地标竖向构件 | 几何集中生成和合并；不为每个窗格创建对象 |
| `runtime.ts` | 装配、真实碰撞、UI、资源销毁 | 不写玩家 transform，不调整角色手感 |
| `city.test.ts` / `kit.test.ts` | 几何、数据、真实 Rapier 接触与零件合同 | 既有凹轮廓/内院/贴墙/地板接缝测试不能删除 |

输入：`../../tools/build-city/source/` 保存裁出的 GloBFP、OSM 建筑与路网，不依赖临时目录。
生成器：`../../tools/build-city/build_futian.py`。
运行数据：`../../assets/city/futian.json`，随现有资产拷贝流程进入 dist。

## 坐标与数据

- 原点 WGS84 `[114.054, 22.540]`；+X 向东，+Z 向南，+Y 向上，单位米。
- 局部米制转换使用 WGS84 椭球在原点的曲率半径；测试将样区四角对照独立 ECEF 切平面，误差要求 <1m。
- `heightSource=estimate`：GloBFP 估高，名义年份 2020；`ctbuh`：当前仅平安金融中心。
- 建筑轮廓面积 <4m² 的碎片被过滤，简化容差 0.25m；不修饰为精确城市完整率。
- 地标替换先从 GloBFP 裁去与 OSM 地标重叠的部分，再加入地标；禁止两个来源直接叠放。
- `street.paving` 是带孔洞的多边形列表，已减去建筑外扩 0.4m，避免铺装穿进楼体。
- `street.placements` 保存 `kind/x/z/yaw`。本版只支持 yaw=0，非零值校验拒绝；生成位置已经按建筑净空筛选，不要仅改随机种子后盲放。
- 树要求距建筑 >3m、长椅 >1.8m、其余 >0.7m；这些是程序化布局约束，不是现场测量值。

## 立面组件

入口：`facadeStyle(building)`、`facadeMaterial(style, stoneImage)`。当前使用MeshPhysicalMaterial；颜色、粗糙度、金属度和微法线分别生成，不再把相同的蓝色渐变画进每扇窗。

| 样式 | 选择规则 | 材质意图 | roughness / metalness |
|---|---|---|---|
| glass | 地标，或高度 ≥65m | 银灰反射玻璃、细金属框、层间带 | 1×贴图 / 1×贴图 |
| office | 24m ≤高度 <65m | 石材颗粒、成组窗、部分百叶 | 1×贴图 / 1×贴图 |
| stone | 高度 <24m | 浅石材裙房、大窗面、水平石材带 | 1×贴图 / 1×贴图 |

公共参数 `FACADE_MODULE`：模块宽3.2m、高3.8m；atlas为512×512，横4模块×纵6模块，每模块双窗，共48窗，实际重复范围12.8×22.8m。RepeatWrapping，anisotropy=8。这里只是视觉重复尺度，不能据此反推实际楼层数。玻璃粗糙度由约32–51/255的贴图值控制；金属框与窗面分开，clearcoat=0.85（非玻璃模板0.25），不启用transmission穿透，因为当前没有室内几何。

UV 按墙面世界米制生成，按法线选择水平 X 或 Z；屋顶固定采样材质底色，不能把窗格铺满屋顶。建筑 ID 决定小幅、可复现的颜色差异，不使用运行时随机。

`facadeChunks` 按四象限 × 三种材质合并，最多 12 批建筑。`buildingChunks` 保留四象限基础几何接口用于低层几何/碰撞测试；运行时用 facadeChunks，不能把“四批测试”误读成最终场景总 draw call。

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

建成项目截图只用于外观对照，不打包进游戏纹理：[入口幕墙](https://images.adsttc.com/media/images/5a4c/6cbf/b22e/38b5/fa00/03e1/medium_jpg/4_Ping_An_FC_(c)_Tim_Griffith.jpg?1514958007)、[石材细部](https://images.adsttc.com/media/images/5a4c/6ca7/b22e/38b5/fa00/03e0/medium_jpg/2_Ping_An_FC_(c)_Tim_Griffith.jpg?1514957984)。照片版权不因作为参考而转移。

## 地标组件

`PING_AN_ID = way/535860513`，OSM 唯一实体 Q1077308。

`PING_AN_PROFILE` 控制从基底轮廓向中心收分：

| 高度 m | 水平比例 |
|---:|---:|
| 0 | 1.000 |
| 12 | 1.000 |
| 60 | 0.985 |
| 400 | 0.860 |
| 540 | 0.760 |
| 565 | 0.660 |
| 599.1 | 0.025 |

体块沿高分 60 段，线性插值比例；底部轮廓保持 OSM 数据，顶部收成窄冠，不增加未经核验的 660m 尖塔。八条竖向银色构件按同一条比例曲线定位，主体半径 0.8m、顶部 0.3m。

**这是识别型简化，不是施工图。** 高度有外部参考，但收分节点、截面比例、构件半径与入口均为本项目建模参数；不得写成“真实测量尺寸”。改变曲线后必须同时复跑楼墙接触与顶高/基底测试。

参考：
- [CTBUH 建筑记录](https://www.skyscrapercenter.com/shenzhen/ping-an-finance-center/54)：599.1m。此次核对了搜索索引与 OSM 标签，CTBUH 正文请求返回 403，不声称拿到了测绘数据。
- [KPF 项目介绍 / ArchDaily，2018](https://www.archdaily.com/886473/ping-an-finance-centre-kpf)：建成后的收分外立面、裙楼与不锈钢构件；避免使用 2012 年未建成方案。
- [KPF 建筑近景参考照片](https://oss.gooood.cn/uploads/2018/02/003-Ping-An-Finance-Centre-Shenzhen-China-by-KPF-960x1450.jpg)：只作观察参考，不打包进运行资产，不沿用图片版权。

## 街道零件参数

统一入口 `buildStreetKit(data)`；参数集中在 `STREET_KIT`，颜色集中在 `STREET_PALETTE`。

| 零件 | 参数（米） | 生成方法与约束 |
|---|---|---|
| 街树 | 干高 3.4、干半径 0.19；冠半径 2.1、冠中心高 4.6 | 圆柱树干 + 三簇低面数树冠；树冠最低处必须高于2m |
| 树池 | 半边 1.4，边框宽 0.18、高 0.24 | 四段矩形边框，底面跟随铺装高度 |
| 路灯 | 高6、杆半径0.075、横臂1.8 | 杆、臂、灯壳合并；亮面是Basic材质，不为每盏灯添加PointLight |
| 长椅 | 宽2.2、深0.65、座高0.46、靠背总高约0.9 | 金属脚架与木条合并；有碰撞，本版尚未接E坐下交互 |
| 路牌 | 板宽3.3、高0.85；中心高2.2 | 本地Canvas文字；只标已知地名，不编造商户或设施 |
| 雨棚 | 中心x=-333.1、z=372.08；宽7、进深16、高4.2 | 入口示意，非实测入口；顶面与支撑共用碰撞几何 |
| 铺装 | 高0.12；颜色512²、法线/ARM256²，周期2m | CC0花岗岩PBR；真实薄台面，渲染和碰撞同源 |

`streetSign()` 为路牌生成1024×256文字纹理；建筑入口使用1024×128透明底文字，不再放巨大的蓝色广告板。文字由本地字体绘制，不是外部图片。尺寸位置由标签记录决定；页面文字继续用 textContent，不能把数据当HTML。

各几何部件按顶点颜色合并为一个街道实体网格；灯具亮面独立一批；路牌文字独立网格。模型细节只落在样板街，不在全城散布大量道具。

## 物理硬约束

1. 地面碰撞块最大128m。两公里宽的薄cuboid在真实探针中会导致约22cm下沉；不要合回巨型块，不要通过抬高玩家或放松断言绕过。
2. 铺装顶面0.12m、出生点y=0.12；玩家胶囊必须从 `spawn.y + capsuleCenter` 创建。原房间spawn.y=0，行为不变。
3. 建筑、铺装、街道实体网格的顶点同时交给渲染和 `bakeTrimesh()`；只有贴在实体表面的路牌文字、灯具亮面不另造碰撞。
4. 不能用建筑包围盒替换凹轮廓/内院，否则会制造看不见的墙。
5. 相机与玩家位置分开；鸟瞰只改相机，不传送角色。
6. 固定物理步长、KCC参数、模型朝向、动画状态机不归此模块调整。

## 光照与资源预算

`CITY_LIGHTING` 提供 day/dusk/night/storm，注入 WorldRenderer 实例；不得原地改全局 `LIGHTING_PRESETS`，原房间需要保持不变。

白天：天空0xc4d0d8、远雾0xd6dcdf、太阳强度2.3、半球光0.7、场景IBL0.6、曝光1.0；显式绑定反射图的立面另用自身增益。城市雾距离仍乘70。局部方向光阴影跟随玩家，覆盖90×90m；shadow far=1800，避免高楼超出原房间60m裁剪距离。

立面atlas由代码生成，石材与道路使用六张本地CC0 PBR贴图，客户端不请求外部CDN。**不等于零成本**：本地贴图也计首屏传输与GPU纹理内存，反射采样也计初始化开销。每轮需要实测首屏压缩字节与1080p帧时，不能沿用旧白模数字。

CityScene持有并销毁自己的geometry/material/texture/collider、路牌与面板。灯光预设由renderer持有。新增零件必须进入同一销毁路径，不能仅从scene移除。

## 复跑与步行验收

仓库根目录：

```bash
python world/tools/build-city/build_futian.py
python world/tools/build-city/build_materials.py
python world/tools/build-city/test_futian.py
python scripts/verify/verify-futian-city.py --shots tmp/futian-street/functional
python scripts/verify/verify-futian-street.py
```

world目录：

```bash
npx tsc --noEmit
npx vitest run
npm run build
node tools/verify-physics.mjs --url http://127.0.0.1:5199/
node tools/verify-scene.mjs --url http://127.0.0.1:5199/
node tools/verify-perf.mjs --hardware --url "http://127.0.0.1:5200/?scene=futian"
```

性能命令需先在另一终端运行 `npm run preview -- --port 5200 --host 127.0.0.1`；它检查生产产物，不把 dev 的模块请求当发布体积。

浏览器脚本统一通过 `tools/chromium.mjs` 定位浏览器。功能脚本默认真实GPU，`--software`只用于无GPU环境的功能验证。样板街脚本拒绝把SwiftShader当GPU，固定1920×1080，沿入口→路边→路口真实键盘行走，截图与帧时保存到 `tmp/futian-street/`。不通过传送制造“已走通”的证据。

验收需同时检查：脚底/路沿高度、楼墙与长椅碰撞、门前净空、路牌可读、纹理不游动、路口视线、原房间回归。新版本实测数字写到交接，不把短采样或单张截图冒充全城验收。

## 许可与保留

- 自编零件/程序纹理代码：项目MIT；不复制研究案例的代码、结构命名或资源。
- GloBFP轮廓与估高：Che et al. 2024 / CC BY 4.0；OSM道路与地标轮廓：ODbL 1.0。派生数据继续保留署名与ODbL义务，不因渲染代码是MIT就改称数据也是MIT。
- 本目录源文件、本文档、数据生成器、裁剪输入与测试应一起保留。`tmp/`仅放截图/探针输出/版权参考图，不作为程序化零件的唯一保存位置。
