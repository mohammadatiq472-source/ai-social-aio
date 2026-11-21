/**
 * 入口：把渲染内核、时钟、世界层粘起来（spec §3 的接线处）。
 *
 * 每帧的顺序（这个顺序有讲究，别调换）：
 *   1. rAF 给 dt
 *   2. dt → Clock（固定步长累加器）
 *   3. Clock 决定跑几步物理 → world.tick(1/60) × N
 *   4. 相机用**渲染 dt** 跟随（不是物理 dt：镜头观感跟画面走）
 *   5. render
 *
 * 第 3 步和第 4 步用的是不同的 dt，这是刻意的：
 * 物理要确定性（固定 dt），镜头要顺滑（跟画面帧率）。
 */

import * as THREE from 'three';
import { Clock } from './core/clock';
import { World } from './core/world';
import { createTransform } from './core/types';
import { PhysicsWorld } from './physics/engine';
import { ThirdPersonCamera, FACE_CAM } from './render/camera';
import { resolvePresetKey } from './render/lighting';
import { WorldRenderer } from './render/scene';
import { actorSourceOf } from './render/env';
import { AgentAvatars, feetYFromCenter } from './render/agent-avatars';
import { AvatarAnimator } from './render/avatar';
import { AssetLoader, applyTint, instantiateAvatar } from './assets/loader';
import { ANIM_CLIP_ALIAS, WHALEGIRL } from './assets/registry';
import { CharacterController, DEFAULT_CHARACTER } from './physics/character';
import { DEFAULT_EMOTE_KEYS, KeyboardInput, horizontalize } from './input/keyboard';
import { PlayerController, CAPSULE_CENTER_HEIGHT } from './interact/player';
import { SeatMarkers, PropMeshes } from './interact/scene';
import { bindInteract, pickAvatarAt } from './interact/bind';
import { createInteractProbe } from './interact/probe';
import { startAgentDemo, type AgentDemoHandle } from './demo/wire-demo';
import { DEMO_ROOM } from '../rooms/demo-room';
import type { CityScene } from './city/runtime';

/**
 * 玩家与 Agent 都不染色（用户明确要求"不要再把颜色涂上去"）。
 *
 * 保留这个常量只为让"取消染色"这件事可搜索、可追溯：
 * 早先这里给玩家一个白色 tint、给 6 个 Agent 6 种彩色，观感像调色板。
 * 现在全部用**原始材质**，靠位置/朝向/动作/名字区分。
 */
const USE_TINT = false;

export interface WorldApp {
  renderer: WorldRenderer;
  camera: ThirdPersonCamera;
  clock: Clock;
  world: World;
  dispose(): void;
}

export function bootWorld(container: HTMLElement, city?: CityScene): WorldApp {
  const room = city?.room ?? DEMO_ROOM;
  const spawn = room.spawn[0] ?? [0, 0, 0];
  // 房间数据在构造时就注入：渲染层要用它建地板/墙/台阶（`render/env.ts`），
  // 物理层稍后用它烘焙碰撞体（`physics/bake.ts`）。
  // **同一个对象**喂两边，所以"看得见的墙"与"撞得到的墙"必然同源。
  const renderer = new WorldRenderer({ container, room, fogDistanceScale: city ? 70 : 1, lightingPresets: city?.lightingPresets });
  // 关键：告诉相机"传进来的 actorPos 是胶囊中心"，让它内部换算成脚底。
  // 不传的话相机会把 0.87m 的胶囊中心当脚底，注视点凭空高 0.85m —— 特写时角色出画。
  const camera = new ThirdPersonCamera({ capsuleCenterHeight: CAPSULE_CENTER_HEIGHT });
  if (city) {
    camera.camera.far = 6000;
    camera.camera.updateProjectionMatrix();
    // 城市首帧朝向第一个核验地标（福田=平安，南山=春笋）；相机在角色背后，数据侧负责
    // 让 spawn 背后有净空（见 docs/区域接入-管理员手册：「spawn 背后 6m 必须无遮挡」）。
    // yaw 约定见 render/camera.ts：forward = (-sin yaw, 0, -cos yaw)。
    let yaw = 0.6;
    const landmark = city.data.landmarks?.[0] ?? city.data.landmark;
    const target = landmark ? city.data.buildings.find(building => building.id === landmark.id) : undefined;
    const ring = target?.rings[0];
    if (ring?.length) {
      let sx = 0, sz = 0;
      for (const point of ring) { sx += point[0]; sz += point[1]; }
      const dx = sx / ring.length - spawn[0];
      const dz = sz / ring.length - spawn[2];
      if (Math.hypot(dx, dz) > 1) yaw = Math.atan2(-dx, -dz);
    }
    camera.setYaw(yaw);
    camera.setPitch(-0.1);
    camera.setDistance(6);
  }
  const clock = new Clock();
  const world = new World();

  // 相机 aspect 必须跟着 canvas 的真实尺寸走，否则 resize 会拉伸
  camera.resize(renderer.cssWidth, renderer.cssHeight);
  renderer.events.resize = (w, h) => camera.resize(w, h);

  camera.attachInput(renderer.canvas);

  // ── 特写模式（`?cam=face`）──
  //
  // 用户明确要求"能看到脸"的特写镜头。这不只是"把距离拉近"：
  // 俯仰角要接近水平（默认 0.32 rad 是俯视，脸会变形），注视点要抬到脸部高度。
  // 参数集中在 camera.ts 的 FACE_CAM，避免这里散落魔法数。
  //
  // 为什么不直接调 ZOOM_MIN：滚轮仍要能用（用户可能想看全身），
  // 特写只是一个**起始预设**，不是强制锁定。
  if (isFaceCamRequest()) {
    camera.setDistance(FACE_CAM.distance);
    camera.setPitch(FACE_CAM.pitch);
    // 关键 1：绕到角色正面。默认 yaw=π 是背后视角，不改这里只会看到后脑勺。
    camera.setYaw(FACE_CAM.yaw);
    // 关键 2：注视点抬到脸部。默认 1.25m 是胸口，特写时脸会被顶出画面。
    camera.setLookHeight(FACE_CAM.lookHeight);
  }

  // ── 时间/天气（`?time=day|dusk|night|storm`）──
  //
  // 初始化时**立即应用**（无过渡）：页面刚打开就应该是目标氛围，
  // 否则会先闪 0.8s 的白天再过渡过去。
  // 之后切换（调试面板/脚本）走 setLighting 的平滑过渡。
  const presetKey = resolvePresetKey(new URLSearchParams(location.search).get('time'));
  renderer.setLightingImmediate(presetKey);

  // ── 场景内容 ──
  // 静态几何（地板/墙/踢脚线/台阶）、地砖缝、墙脚暗化、网格线、接触阴影
  // 全部由 `render/env.ts` 的 RoomVisual 负责，数据源是构造时注入的 DEMO_ROOM。
  //
  // 这里**不再**手写"遍历 DEMO_ROOM.static 建 BoxGeometry"：
  // 那种写法的后果是只画 box、跳过 ramp/stairs，于是"物理里有台阶、画面里没有"。
  // 现在两边都走 `core/room.ts#roomSolids()`，几何种类（box/ramp/stairs）一处定义。
  //
  // 接触阴影的数据源：世界实体表。物理就绪前表里只有玩家，就绪后 Agent 自动进来。
  renderer.setActorSource(actorSourceOf(world));

  // 网格线句柄：M11 面板的 G 键要切它。
  // 房间立起来之后网格线默认**关**（见 env.ts），按 G 才出现。
  // 移动端也建（只有 1 条 LineSegments，且默认不可见 → 不产生 drawCall），
  // 这样 G 键在移动端不是死键——"按键存在但无效果"比没有这个键更误导人。
  const gridHelper: THREE.Object3D | null = renderer.getRoomVisual()?.grid ?? null;

  // ── 玩家化身 ──
  // M5 已落地，玩家不该还是个光秃秃的胶囊（D7 要录片，胶囊会被录进去）。
  // 用一个与 6 个 Agent 都不同的 tint（`tint-hero` → 白色系）区分"这是我"。
  //
  // 注意：物理胶囊 1.70m vs 资产视觉 1.62m 的 8cm 差异是**有意保留**的
  // （physics-agent 在 engine.ts 的 CHARACTER_CAPSULE 注释里说明了：
  //  物理胶囊略大于视觉模型，避免手肘/头发穿墙，碰撞判定更宽容）。
  // 所以这里只换渲染层，不动物理尺寸。
  const heroId = world.nextId('p');
  world.spawn({
    id: heroId,
    kind: 'human',
    name: '你',
    transform: createTransform([spawn[0]!, spawn[1]!, spawn[2]!]),
    anim: 'idle',
    animPhase: 0,
  });

  // 占位胶囊：资产加载完成前先顶上，避免"进房头几百毫秒什么都没有"。
  // 资产就绪后会被移除（见下方 heroAvatar 的创建）。
  const placeholder = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 1.06, 4, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.05 }),
  );
  placeholder.name = 'hero-placeholder';
  placeholder.castShadow = renderer.tier.shadows;
  placeholder.position.set(spawn[0]!, spawn[1]! + 0.81, spawn[2]!);
  renderer.scene.add(placeholder);

  /** 玩家化身句柄（资产就绪后赋值；在此之前用占位胶囊）。 */
  let heroAvatar: {
    root: THREE.Group;
    animator: AvatarAnimator;
    mixer: THREE.AnimationMixer;
  } | null = null;

  // ── 键盘输入（WASD 行走 / Shift 奔跑 / 空格跳跃 / 1-6 表情）──
  // 输入层只产出意图（方向 + run + jump），交给 CharacterController.update()。
  // **绝不直接写 transform** —— 那会绕过物理，表现为穿墙/悬空。
  const keyboard = new KeyboardInput();
  keyboard.attach(window);
  /** 玩家的物理控制器（物理就绪后赋值）。 */
  let heroController: CharacterController | null = null;
  /** 物理给玩家的动画状态（由 writeTransform 回调写入，渲染层据此选动画）。 */
  let heroAnimFromPhysics: 'idle' | 'walk' | 'run' | 'jump' | 'fall' = 'idle';
  /** 待执行的表情 clip（由数字键触发，动画层消费后清零）。 */
  let pendingEmote: string | null = null;
  keyboard.bindEmotes(DEFAULT_EMOTE_KEYS, (clip) => {
    pendingEmote = clip;
  });

  // ── M10 交互（坐/起、推箱提示、看向焦点）──
  // 三个句柄都在物理就绪后赋值：PlayerController 需要 CharacterController，
  // PropMeshes 需要物理侧的真实道具刚体。声明放在这里是为了让主循环与
  // 异步 IIFE 共享同一作用域。
  let player: PlayerController | null = null;
  let seatMarkers: SeatMarkers | null = null;
  let propMeshes: PropMeshes | null = null;
  /** 验收探针的自动走位覆盖（null = 用真实键盘输入）。 */
  let autoMove: { dirX: number; dirZ: number; run: boolean; jump: boolean } | null = null;
  let unbindInteract: (() => void) | null = null;

  // ── 物理 ──
  // M3 的 PhysicsWorld 需要 await RAPIER.init()（WASM 加载），是异步的。
  // 但首帧不能等它：先把渲染跑起来（空场景本来就能出图），物理就绪后再挂到同一个
  // Clock 上。这样"进房到可操作"不被 WASM 下载阻塞，也符合 spec §8 的首屏预算。
  //
  // 注意：物理就绪前 Clock 仍然每帧在跑（tick 照常推进），只是没有物理步。
  // 这不是偷懒——它保证了 alpha/插值链路从第一帧就成立，接上物理时不会有跳变。
  let physics: PhysicsWorld | null = null;
  let physicsSteps = 0;

  // ── M11 调试面板要读的实时状态 ──
  // `rapierNs` 存下来是给物理线框用的：`PhysicsDebugDraw` 解析 Cuboid/Capsule
  // 等形状类需要 Rapier 命名空间，而它只在这个 IIFE 里可见。
  let rapierNs: unknown = null;
  /** P 键暂停物理。渲染与动画照常跑（那才看得出"物理停了但画面没停"）。 */
  let physicsPaused = false;
  /** 本帧物理总耗时（毫秒）。一帧可能跑 2~3 步，所以要累加而不是取最后一步。 */
  let framePhysicsMs = 0;
  /** 调试面板的卸载钩子（异步装上，所以是"稍后才有"的函数）。 */
  let debugPanelDispose: (() => void) | null = null;

  // 6 Agent 演示与化身的句柄。声明在 IIFE **外面**：
  // 物理就绪的异步流程里赋值，主循环（同作用域）每帧读，所以必须是同一个作用域变量。
  let agentDemo: AgentDemoHandle | null = null;
  let agentAvatars: AgentAvatars | null = null;
  /** 累计说过的气泡数（验收探针用：证明 say → HUD 这条链通过）。 */
  let bubblesSeen = 0;

  void (async () => {
    try {
      // 用 compat 版。原因（实测过，别再改成非 compat 版）：
      // 非 compat 版 `@dimforge/rapier3d` 通过 `import * as wasm from "./rapier_wasm3d_bg.wasm"`
      // 同步绑定 WASM，依赖 bundler 的「ESM integration for Wasm」。
      // 但 Vite 不支持那个提案（vite:wasm-fallback 会直接抛错），默认把 .wasm 当**资产 URL**：
      // 产物里是 `new URL("rapier_wasm3d_bg-xxx.wasm", import.meta.url).href` —— 一个字符串。
      // 于是 `__wbg_set_wasm(wasm)` 收到字符串，构建能过、运行时所有 Raw* 类型都是 undefined，
      // 表现为"物理初始化成功但第一次 step 就崩"。这种静默失败比体积超标更糟。
      //
      // 体积代价：compat 版把 2.94MB wasm base64 内联成 4.14MB JS（gzip 1.57MB）。
      // 但那是**传输字节**问题，而独立 wasm 也要传 2.94MB（gzip 1.12MB）——
      // 真实差异只有 base64 的 33% 膨胀（约 +0.45MB gzip），不是"省 2.9MB"。
      // 结论：体积口径的事交给 lead 定标准，不拿运行时可崩换。
      const RAPIER = await import('@dimforge/rapier3d-compat');
      await RAPIER.init();
      const ns = RAPIER.default ?? RAPIER;
      rapierNs = ns;
      physics = await PhysicsWorld.create(ns, room, {
        propPoolSize: 256,
      });
      city?.mount(renderer, physics, ns);
      console.info('[world] 物理就绪', physics.stats);

      // ── 相机接物理：地面高度 + 避障射线 ──
      //
      // 之前这两个都是默认值（groundHeight 恒返回 0、occlude 为 null），
      // 也就是**相机一直按"平地 + 无遮挡"算**。加了四面墙之后，
      // 第三人称镜头退到墙外就会穿墙，画面变成墙的内壁（一片纯色）。
      //
      // groundHeight：向下打射线拿真实地面高度（有台阶/斜坡时镜头才不会穿地）。
      // occlude：从注视点向理想机位打射线，命中则把镜头拉近（boom collision）。
      // 两者都用 CHARACTER 身份查询，不包含 AGENT —— 相机不该被其他角色挡住。
      const physForCam = physics;
      camera.groundHeight = (x, z) => {
        const hit = physForCam.groundHeightAt(x, z, 50, 60);
        return hit ? hit.y : 0;
      };
      camera.occlude = (from, to) => physForCam.raycastDistance(from, to, 60);

      // ── 玩家物理控制器（WASD 驱动的那个胶囊）──
      // 胶囊中心高度 = 半高 + 半径（与 DEFAULT_CHARACTER 一致）。
      // 出生点用房间的 spawn[0]，与视觉化身同位置。
      const capsuleCenter = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;
      const spawn = room.spawn[0] ?? [0, 0, 0];
      heroController = new CharacterController(
        ns,
        physics,
        spawn[0],
        spawn[1] + capsuleCenter + 0.05,
        spawn[2],
      );
      console.info('[world] 玩家控制器就绪');

      // ── M10：交互对象可见化 + 玩家交互控制器 ──
      // 座位标记与箱子必须先画出来：看不见的椅子没法"走近坐下"，
      // 看不见的箱子没法"推"。座位数据来自 room.seats（与物理同一份），
      // 箱子位置来自物理侧的真实刚体（每帧同步，不自己积分）。
      seatMarkers = new SeatMarkers(renderer.scene, room.seats);
      propMeshes = new PropMeshes(renderer.scene, physics.roomProps, {
        shadows: renderer.tier.shadows,
      });
      console.info(
        `[world] 交互对象就绪：${seatMarkers.count} 个座位 / ${propMeshes.count} 个箱子`,
      );

      player = new PlayerController({
        world,
        id: heroId,
        controller: heroController,
        seats: room.seats,
        // 方向来源：验收探针的自动走位优先，否则用真实键盘（相对相机）
        readMove: () => {
          if (autoMove) return autoMove;
          const camF = horizontalize(camera.getForward());
          const camR = horizontalize(camera.getRight());
          return keyboard.sample(camF, camR);
        },
        readPropPositions: () =>
          physics
            ? physics.roomProps.map((p) => {
                const t = p.body.translation();
                return [t.x, t.y, t.z] as [number, number, number];
              })
            : [],
      });

      // 键盘 E / 鼠标左键单击角色 → 交互。射线拾取需要 camera + scene，
      // 都在这个作用域里，所以在这里绑（而不是在 interact/bind.ts 里 import three 的渲染器）。
      unbindInteract = bindInteract({
        player,
        canvas: renderer.canvas,
        keyTarget: window,
        pickEntity: (cx, cy) => {
          const rect = renderer.canvas.getBoundingClientRect();
          return pickAvatarAt(camera.camera, renderer.scene, cx, cy, rect)?.id ?? null;
        },
      });
      console.info('[world] 交互接线就绪（E 坐/起，左键点角色切焦点）');

      // ── Agent 演示（默认 0 个，用 ?agents=N 开启）──
      //
      // 为什么默认关掉（2026-11-20 用户要求）：
      // 每个 Agent 都是完整角色（1 SkinnedMesh + 3 张贴图 + 41 骨骼 + 20 条动画），
      // 6 个 Agent = 约 18MB 显存 + 6 套骨骼动画每帧计算，且会把画面塞满、看不清玩家。
      // v0.1 的验收目标是"一个人能在真物理世界里正常走、跳、坐"，Agent 是演示项不是必需项。
      //
      // 代码全部保留（M9 的 629 条测试仍绿），只是默认不加载：
      //   ?agents=6  → 恢复 6 Agent 演示
      //   ?agents=3  → 3 个
      // 这样做的好处：验收/录片按需开启，不浪费已完成的 M9 工作，也不吃显存。
      const agentCount = readAgentCount();
      if (agentCount > 0) {
        agentDemo = startAgentDemo({
          world,
          RAPIER: ns,
          physics,
          room,
          count: agentCount,
        });
      }

      // 化身：把 Agent 实体映射成场景里的可见角色。
      // Agent 默认为 0（`?agents=N` 才开），此时不建 avatar 层，省掉整块显存与每帧开销。
      if (agentDemo) {
        agentAvatars = await AgentAvatars.create(
          {
            scene: renderer.scene,
            world,
            hudContainer: container,
            shadows: renderer.tier.shadows,
            agents: agentDemo.runtimes.map((rt) => {
              const actor = world.getActor(rt.id);
              return {
                id: rt.id,
                name: actor?.name ?? rt.id,
                tint: actor?.tint ?? 'tint-0',
              };
            }),
          },
          renderer.renderer,
        );
      }

      if (agentAvatars) {
        agentAvatars.resize(renderer.cssWidth, renderer.cssHeight);
        // HUD 尺寸跟随 canvas（与相机 aspect 同一个 resize 事件源）
        const prevResize = renderer.events.resize;
        renderer.events.resize = (w, h) => {
          prevResize?.(w, h);
          agentAvatars?.resize(w, h);
        };
        console.info(`[world] ${agentAvatars.count} 个 Agent 化身就绪`);
      }

      // ── 玩家真化身（替换占位胶囊）──
      // 复用同一个 AssetLoader（资产已缓存，不会重复下载/解码）。
      // 不染色：用原始材质，靠位置与朝向区分"哪个是我"（相机始终跟着自己）。
      try {
        const loader = new AssetLoader();
        const loaded = await loader.loadAvatar(WHALEGIRL, renderer.renderer);
        const root = await instantiateAvatar(loaded.template);
        root.name = `avatar:${heroId}`;
        if (USE_TINT) applyTint(root, '#f2f5fa');
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = renderer.tier.shadows;
          m.receiveShadow = renderer.tier.shadows;
        });

        const mixer = new THREE.AnimationMixer(root);
        const animator = new AvatarAnimator(heroId);
        animator.bind(mixer, loaded.clips, ANIM_CLIP_ALIAS);

        const actor = world.getActor(heroId);
        const p = actor?.transform.p ?? [0, 0, 0];
        root.position.set(p[0], p[1], p[2]);
        renderer.scene.add(root);

        // 占位胶囊退场
        placeholder.removeFromParent();
        placeholder.geometry.dispose();
        (placeholder.material as THREE.Material).dispose();

        heroAvatar = { root, animator, mixer };
        loader.dispose();
        console.info('[world] 玩家化身就绪');
      } catch (err) {
        // 玩家化身失败不该让世界崩：占位胶囊继续用，画面仍有"我"
        console.error('[world] 玩家化身加载失败，保留占位胶囊', err);
      }

      // HUD 每帧渲染（CSS2D 需要显式 render）
      renderer.onFrame(() => {
        if (agentAvatars) agentAvatars.renderHud(camera.camera);
      });

      // 把"谁在说话"接到 HUD 气泡上：world 的 actor:say 事件是唯一来源
      world.events.on('actor:say', ({ id, text }) => {
        agentAvatars?.say(id, text);
        bubblesSeen += 1;
      });

      // ── Agent 探针（仅 dev）：给 tools/smoke-agents.mjs 与 verify-locomotion-live 读 ──
      // 验收要证的是"场景里真的有 6 个可见角色在动"，不是"实体表里有 6 个 id"，
      // 所以同时暴露 avatarCount（场景里实际挂上的根节点）与 agents（位置/动画状态）。
      //
      // 另外必须暴露**玩家**（p:*）——早先只暴露了 6 个 Agent，导致
      // lead 的 verify-locomotion-live.mjs 读不到玩家位置、拿不到 walk 位移（dist: -1），
      // 看起来像"WASD 没通"。这是探针缺字段，不是功能坏。
      if (import.meta.env.DEV) {
        const api = {
          read(): Record<string, unknown> {
            const avatars = agentAvatars?.debug() ?? [];
            const heroActor = world.getActor(heroId);
            const hp = heroActor?.transform.p ?? null;
            return {
              avatarCount: agentAvatars?.count ?? 0,
              agents: avatars,
              // 玩家状态：验收脚本用它验证 WASD / 跳跃 / 朝向
              hero: hp
                ? {
                    id: heroId,
                    // transform.p 是**胶囊中心**；feetY 才是脚底（渲染用的那个值）
                    pos: [round2(hp[0]), round2(hp[1]), round2(hp[2])],
                    feetY: round2(feetYFromCenter(hp[1])),
                    anim: heroAvatar?.animator.state ?? heroActor?.anim ?? 'idle',
                    grounded: !(heroAnimFromPhysics === 'jump' || heroAnimFromPhysics === 'fall'),
                    // 水平速度：由渲染层按位移差分算出（物理的 vx/vz 是 private）
                    speed: heroAvatar ? lastHeroSpeed : 0,
                  }
                : null,
              // 兼容别名：lead 的 verify-locomotion-live.mjs 读的是 `players` 数组。
              // 保留 `hero` 单数形式是因为它语义更清楚（只有一个玩家）；
              // `players` 数组形式让既有脚本不用改。两者指向同一份数据。
              players: hp
                ? [
                    {
                      id: heroId,
                      pos: [round2(hp[0]), round2(hp[1]), round2(hp[2])],
                      feetY: round2(feetYFromCenter(hp[1])),
                      anim: heroAvatar?.animator.state ?? heroActor?.anim ?? 'idle',
                      grounded: !(heroAnimFromPhysics === 'jump' || heroAnimFromPhysics === 'fall'),
                      speed: heroAvatar ? lastHeroSpeed : 0,
                    },
                  ]
                : [],
              bubblesSeen,
              activeBubbles: avatars.length > 0 ? avatars[0]!.bubbles : 0,
              worldActors: world.actorCount,
              physicsSteps,
              tick: world.tickCount,
            };
          },
        };
        (window as unknown as { __agentDebug: typeof api }).__agentDebug = api;
      }

      // ── M10 交互探针（仅 dev）：给 tools/verify-interact.mjs 读 ──
      // 验收要证的是"走近椅子按 E 真的坐下了"，而不是"实体表里有个 sitting 字段"。
      // 所以探针同时暴露：真实距离、真实位置、真实箱子位移。
      // 自动走位只填 readMove() 的返回值，位移仍然由物理算——不伪造结果。
      if (import.meta.env.DEV && player) {
        const probe = createInteractProbe({
          world,
          player,
          seats: room.seats,
          readPropPositions: () =>
            physics
              ? physics.roomProps.map((p) => {
                  const t = p.body.translation();
                  return [t.x, t.y, t.z] as [number, number, number];
                })
              : [],
          setAutoMove: (m) => {
            autoMove = m;
          },
          camera: camera.camera,
          scene: renderer.scene,
          canvas: renderer.canvas,
        });
        (window as unknown as { __interactDebug: typeof probe }).__interactDebug = probe;
      }
    } catch (err) {
      // 物理起不来不该让整个世界白屏：渲染继续，只是没有物理。
      if (city) {
        renderer.stop();
        showBootError(err);
      } else {
        console.error('[world] 物理初始化失败，以降级模式继续（无碰撞）', err);
      }
    }
  })();

  const heroPos = new THREE.Vector3(0, 0, 0);
  /** 玩家上一帧的水平速度（m/s），调试探针用。 */
  let lastHeroSpeed = 0;
  /** M10 焦点注视点（复用同一个向量，避免每帧 new）。 */
  const focusPoint = new THREE.Vector3();
  /** 上一帧的焦点实体 id（用于只在目标**变化**时重置相机缓动）。 */
  let lastFocusId: string | null = null;
  let alpha = 0;

  // ── 6 Agent 演示（M9 接线，D5 验收的核心）──
  // 时机：物理就绪后再启动。因为 AgentSystem 需要 CharacterController（胶囊），
  // 而控制器要绑到 PhysicsWorld 上；物理没就绪时启动会得到 6 个"无物理模式"的 Agent
  // （意图被消费但角色不动），表现为"有 6 个 id 但没有 6 个角色"。
  // 句柄已在上面声明，这里只是占位说明；实际赋值在物理 IIFE 里。

  // 资产探针（仅 dev）：给 tools/measure-assets.mjs 读
  if (import.meta.env.DEV) {
    installAssetProbe(renderer);
  }

  renderer.onFrame((frameDt) => {
    // 本帧物理耗时要逐帧归零，否则面板会显示"自启动以来的总和"（第一个坑）
    framePhysicsMs = 0;

    // 关键：dt 先交给 Clock（固定步长累加器），物理只吃 Clock 吐出的 1/60。
    // 渲染永远不直接喂物理，掉帧时物理会按 maxSteps 追步而不是变慢。
    //
    // 步进顺序（agent-system 实测过的契约，别改）：
    //   physics.step() → demo.tick() → world.tick()
    // demo.tick() 里的 writeTransform 读 body.translation()，那是**本步已结算**的位置。
    // 放 step 之前会读到上一步的位置，实体表永远慢一帧（实测滞后 0.0367m = 2.2m/s × 1/60）。
    //
    // P 键暂停物理（M11）：**只跳过 physics.step()**，agentDemo.tick() 与 world.tick()
    // 照常跑。理由——面板要能回答"物理停了画面还在动吗"，所以暂停的语义是
    // "刚体不再被求解"，不是"整个世界冻结"。若把 world.tick 也停掉，
    // 调试面板的 fps 数字会一起冻住，看不出渲染是否正常。
    const info = clock.runSteps(frameDt, (fixedDt) => {
      // 玩家控制器必须在 physics.step() **之前** update：
      // controller.update() 设的是 setNextKinematicTranslation（下一步生效），
      // 放 step 之后就晚一帧（实测滞后 0.0367m = 2.2m/s × 1/60）。
      //
      // M10 之后这里交给 PlayerController.step()：它内部做的是同一件事
      // （controller.update → writeTransform），但多了一层"坐着时方向位清零、
      // **仍然**喂物理"的门控。坐在椅子上不该让角色失去贴地/坡度校正。
      if (player) {
        player.step(fixedDt);
        // 动画状态仍由物理给（坐下时 PlayerController 会覆盖成 'sit'）
        const a = world.getActor(heroId);
        if (a) heroAnimFromPhysics = a.anim as typeof heroAnimFromPhysics;
      } else if (heroController) {
        // 降级：M10 的 PlayerController 没装上（理论上不会，除非物理半途失败）
        const camF = horizontalize(camera.getForward());
        const camR = horizontalize(camera.getRight());
        const input = keyboard.sample(camF, camR);
        heroController.update(
          {
            dirX: input.dirX,
            dirZ: input.dirZ,
            run: input.run,
            jump: input.jump,
          },
          fixedDt,
        );
        // 写回实体表：渲染层只从 world 读，不碰物理内部。
        // writeTransform 收的是回调（t, anim）→ 由调用方决定怎么落到实体表。
        heroController.writeTransform((t, anim) => {
          heroAnimFromPhysics = anim;
          world.updateActor(heroId, {
            transform: t,
            anim,
            animPhase: 0,
          });
        });
      }

      if (physics && !physicsPaused) {
        const t0 = performance.now();
        physics.step(fixedDt);
        framePhysicsMs += performance.now() - t0;
        physicsSteps += 1;
      }
      agentDemo?.tick();
      world.tick(fixedDt);
    });
    alpha = clock.alpha;

    // 化身更新用**渲染 dt**（动画/观感跟画面帧率走），位置仍从 world 读
    if (agentAvatars) {
      agentAvatars.update(frameDt, performance.now());
    }

    // 玩家化身：位置从 world 读（与 Agent 同一条数据源），朝向跟位移方向
    const actor = world.getActor(heroId);
    if (actor) heroPos.set(actor.transform.p[0], actor.transform.p[1], actor.transform.p[2]);
    if (heroAvatar) {
      const hp = heroAvatar.root.position;
      const dx = heroPos.x - hp.x;
      const dz = heroPos.z - hp.z;
      // ⚠ y 要减掉胶囊中心高度：transform.p[1] 是胶囊中心，模型脚底在局部 y=0。
      // 不减会让玩家悬空 0.85m（与 Agent 同一个 bug，见 agent-avatars.ts 的注释）。
      heroAvatar.root.position.set(heroPos.x, feetYFromCenter(heroPos.y), heroPos.z);
      if (dx * dx + dz * dz > 1e-6) {
        // 物理侧约定 +Z 为前方，yaw = atan2(fx, fz)
        heroAvatar.root.rotation.y = Math.atan2(dx, dz);
      }
      const speed = Math.hypot(dx, dz) / Math.max(frameDt, 1e-6);
      lastHeroSpeed = speed;
      // 表情键（1-6）：一次性动作，播完由 animator 自己回落
      if (pendingEmote && heroAvatar.animator.hasClip(pendingEmote)) {
        heroAvatar.animator.playOneShot(pendingEmote);
        pendingEmote = null;
      }
      // grounded / verticalSpeed 从物理给的动画状态反推：
      // `CharacterController` 的 grounded/vy 是 private（physics-agent 的作用域），
      // 但它的 anim 是公开给渲染层的契约（'jump'/'fall' 即离地）。
      // 用契约而不是偷看私有字段，换实现也不会坏。
      const airborne = heroAnimFromPhysics === 'jump' || heroAnimFromPhysics === 'fall';
      // M10：坐着时传 sitting 位——状态机的优先级里 sit 高于 idle/walk，
      // 不传的话人会"坐在座位上站着"，这是 M10 最容易漏掉的一环
      // （位置对了、状态对了，但动画还是 idle）。
      heroAvatar.animator.update(
        {
          speed,
          grounded: !airborne,
          verticalSpeed: heroAnimFromPhysics === 'jump' ? 1 : heroAnimFromPhysics === 'fall' ? -1 : 0,
          sitting: player?.sitting === true,
        },
        frameDt,
      );

      // ── 待机动作轮播 ──
      //
      // 放在 animator.update **之后**：要读更新后的状态才知道现在是不是 idle。
      // 只在"真的静止 + 当前 idle"时推进；走动/跳跃/坐下期间完全不干预。
      //
      // ⚠ 2026-11-20 撤掉了"待机动作轮播"（原 idle-cycle.ts）。
      // 用户否决的理由是对的，值得记下来防止再犯：
      //   用**上半身/头部**的轻动作做待机变体，会做出"一边跑一边点头思考"的混合姿势 ——
      //   因为 playOneShot 是叠加在状态机之上的，玩家中途开始走时上半身动作还在继续。
      //   现实中没有人这样走路。这个设计本身就是错的，不是参数没调好。
      //
      // 正确做法（如果将来还要做）：整身动作，且必须能被移动状态**立刻打断**。
      // 或者干脆不做 —— 修好动画权重之后，idle 本身就会动（实测 41 根骨骼有 8 根在动），
      // 角色并不"像假人"。先不要为不存在的问题加复杂度。
    }

    // ── M10：箱子位置从物理同步（每渲染帧一次，跟得上被推动的刚体）──
    // 绝不自己积分位置：那会和物理漂移，表现为"箱子被推走了但画面里的箱子还在原地"。
    if (propMeshes && physics) propMeshes.sync(physics.roomProps);

    // ── M10：座位高亮（玩家够得着时放大一点，提示"这里能按 E"）──
    if (seatMarkers && player) {
      seatMarkers.highlight(player.prompt.sit === 'can_sit' ? player.interactState.seatId : null);
    }

    // ── M10：焦点缓动（渲染 dt，跟画面帧率走）──
    // PlayerController 维护纯逻辑进度；相机那边自己缓动注视点。
    // 两者同源同参数（1s），所以不会出现"进度走完了镜头还没到"。
    if (player) {
      player.tickFocus(frameDt);
      const target = player.focusTarget;
      if (target) {
        const ta = world.getActor(target);
        if (ta) {
          // 注视点用**脚底**高度（相机内部再加 lookHeight）
          focusPoint.set(
            ta.transform.p[0],
            ta.transform.p[1] - CAPSULE_CENTER_HEIGHT,
            ta.transform.p[2],
          );
          // ⚠ 只在**目标变化时**调 focusOn：它内部会把 focusT 重置成 0。
          // 每帧都调等于让相机缓动永远停在起点（实测：镜头完全不跟，进度条却走完了）。
          // 目标不变时只更新 focusTarget 的位置（人在走，镜头要跟住）。
          if (lastFocusId !== target) {
            camera.focusOn(focusPoint);
            lastFocusId = target;
          } else {
            camera.updateFocusTarget(focusPoint);
          }
        } else {
          // 目标离场了：自动回自己，不要锁在一个不存在的实体上
          camera.clearFocus();
          player.setFocus(null);
          lastFocusId = null;
        }
      } else if (lastFocusId !== null || camera.hasFocus) {
        camera.clearFocus();
        lastFocusId = null;
      }
    }

    // 相机用**渲染 dt** 跟随（不是物理 dt）：镜头观感要跟画面帧率走
    camera.update(heroPos, frameDt);
    city?.update(heroPos, camera.camera);
    void info;
  });

  renderer.start(camera.camera);

  // ── dev 构建才挂调试口（生产构建会被 Vite 的 define 摇掉） ──
  if (import.meta.env.DEV) {
    installDebug({
      renderer,
      camera,
      clock,
      world,
      get alpha() {
        return alpha;
      },
      physicsSteps: () => physicsSteps,
      // 化身数量：玩家（heroAvatar 就绪后才算）+ 6 个 Agent。
      // 用场景里真实挂上的根节点数，不是实体表里的 id 数——两者可能不一致，
      // 而验收要证的是"画面上有 N 个角色"。
      avatarCount: () => (heroAvatar ? 1 : 0) + (agentAvatars?.count ?? 0),
      agentCount: () => agentAvatars?.count ?? 0,
      getPhysics: () => physics,
      getHeroFacing: () => heroAvatar?.root.rotation.y ?? null,
      getHeroPlayingClips: () => heroAvatar?.animator.playingClips() ?? [],
      getOneShotState: () => {
        const a = heroAvatar?.animator;
        if (!a) return null;
        const d = a.debugOneShot();
        return {
          playing: d.playing,
          elapsed: d.elapsed,
          max: d.max,
          current: String(d.current),
          desired: String(d.desired),
        };
      },
      getAnimChain: () => {
        const c = heroController as unknown as { anim?: string } | null;
        return {
          actor: world.getActor(heroId)?.anim ?? '?',
          phys: String(c?.anim ?? '?'),
          fromPhysics: heroAnimFromPhysics,
          animator: heroAvatar?.animator.state ?? '?',
        };
      },
      getPhysState: () => {
        const c = heroController as unknown as
          | { anim?: string; grounded?: boolean; vy?: number; state?: string }
          | null;
        if (!c) return null;
        return {
          anim: String(c.anim ?? '?'),
          grounded: Boolean(c.grounded),
          vy: Number(c.vy ?? 0),
          state: String(c.state ?? '?'),
        };
      },
      getHeroHasClip: (n: string) => heroAvatar?.animator.hasClip(n) ?? false,
    });
  }

  // ── M11 调试面板（spec §6 M11）──
  // 守卫是两个**编译期字面量**：生产构建里 `DEV` 折叠成 false、`MODE` 折叠成
  // 'production'，整个分支连同下面那个 `import('./render/debug')` 一起被 Rollup 删掉，
  // 所以 `src/render/debug.ts` 连 chunk 都不会产出。
  // 反过来，只要这里出现任何"运行时才能求值再决定 import 谁"的写法，整块就会被保留。
  // 因此 `?debug=1` 的判断放在**被 import 的模块内部**（`shouldEnableDebugPanel`）。
  if (import.meta.env.DEV || import.meta.env.MODE === 'debug') {
    void (async () => {
      const { installDebugPanel, shouldEnableDebugPanel } = await import('./render/debug');
      const enabled = shouldEnableDebugPanel({
        isDev: import.meta.env.DEV,
        mode: import.meta.env.MODE,
        search: location.search,
      });
      if (!enabled) return;
      const h = installDebugPanel({
        renderer,
        camera,
        clock,
        world,
        getPhysics: () => physics,
        getRapier: () => rapierNs,
        getGrid: () => gridHelper,
        getFramePhysicsMs: () => framePhysicsMs,
        getPhysicsSteps: () => physicsSteps,
        isPhysicsPaused: () => physicsPaused,
        setPhysicsPaused: (v) => {
          physicsPaused = v;
        },
        container,
      });
      renderer.onFrame(() => h.tick(performance.now()));
      debugPanelDispose = () => h.dispose();
    })();
  }

  const app: WorldApp = {
    renderer,
    camera,
    clock,
    world,
    dispose() {
      debugPanelDispose?.();
      debugPanelDispose = null;
      // M10：先解绑事件（否则 dispose 后按 E 还会调到一个已废弃的控制器）
      unbindInteract?.();
      unbindInteract = null;
      player?.dispose();
      player = null;
      seatMarkers?.dispose();
      seatMarkers = null;
      propMeshes?.dispose();
      propMeshes = null;
      autoMove = null;
      city?.dispose();
      renderer.dispose();
      camera.detachInput();
      // 物理可能是异步初始化失败/尚未完成，所以必须判空
      physics?.dispose();
      physics = null;
      world.reset();
    },
  };
  return app;
}

interface DebugDeps {
  renderer: WorldRenderer;
  camera: ThirdPersonCamera;
  clock: Clock;
  world: World;
  alpha: number;
  physicsSteps: () => number;
  /** 场景里的化身总数（玩家 + Agent）。验收脚本用它数角色，不靠截图。 */
  avatarCount: () => number;
  /** 仅 Agent 的化身数（不含玩家）。 */
  agentCount: () => number;
  /** 物理世界（避障验收时直接测射线用；未就绪时返回 null）。 */
  getPhysics: () => PhysicsWorld | null;
  /** 玩家化身朝向角（弧度）；未加载时 null。 */
  getHeroFacing: () => number | null;
  /** 玩家化身实际在播的动画 clip 名。 */
  getHeroPlayingClips: () => string[];
  /** 物理控制器内部状态（诊断用）。 */
  getPhysState: () => { anim: string; grounded: boolean; vy: number; state: string } | null;
  /** 三个 anim 来源的实时值。 */
  getAnimChain: () => { actor: string; phys: string; fromPhysics: string; animator: string };
  /** animator 内部一次性动作状态。 */
  getOneShotState: () => {
    playing: boolean;
    elapsed: number;
    max: number;
    current: string;
    desired: string;
  } | null;
  /** 玩家化身是否有某个 clip。 */
  getHeroHasClip: (name: string) => boolean;
}

/**
 * window.__worldDebug（spec §6 M1 第 5 条）。
 *
 * 只在 dev 构建存在：生产构建里 `import.meta.env.DEV` 是字面量 false，
 * 整个 if 块会被摇掉，所以线上页面无法通过它探测内部结构。
 * e2e 断言也走这个口——它读的是 renderer.info 的真实数字，不是估算。
 */
function installDebug(deps: DebugDeps): void {
  const read = (): Record<string, unknown> => {
    const stats = deps.renderer.getStats();
    return {
      fps: stats.fps,
      frameMs: stats.frameMs,
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      geometries: stats.geometries,
      textures: stats.textures,
      // 物理与时钟
      tick: deps.world.tickCount,
      worldTime: Math.round(deps.clock.worldTime * 1000) / 1000,
      physicsSteps: deps.physicsSteps(),
      overruns: deps.clock.overruns,
      // 丢弃秒数：配合 worldTime 算出"时间丢弃率"，
      // 才能判断 overrun 是帧率问题（软渲染）还是物理问题。
      droppedSeconds: Math.round(deps.clock.droppedSeconds * 1000) / 1000,
      alpha: Math.round(deps.alpha * 100) / 100,
      // 画质档位（验收要看降级是否生效）
      tier: deps.renderer.tier.kind,
      shadows: deps.renderer.tier.shadows,
      dpr: deps.renderer.renderer.getPixelRatio(),
      size: [deps.renderer.cssWidth, deps.renderer.cssHeight],
      // 场景里的化身数量（含玩家）。验收脚本用它直接数，不用靠截图人眼判断。
      avatarCount: deps.avatarCount(),
      agentCount: deps.agentCount(),
      camera: {
        yaw: Math.round(deps.camera.currentYaw * 1000) / 1000,
        pitch: Math.round(deps.camera.currentPitch * 1000) / 1000,
        distance: Math.round(deps.camera.currentDistance * 100) / 100,
      },
      // 场景图盘点：验收要能说清"drawCall 多出来的是哪几个"，
      // 而不是只看总数（被视锥剔除的对象会让总数看起来达标但画面缺东西）。
      scene: deps.renderer.describeScene(),
    };
  };

  const api = {
    /** 快照式读取（e2e 用）。 */
    read,
    /** 平均 fps 采样：等 ms 毫秒后返回均值，比读瞬时值稳。 */
    async measureFps(ms = 1000): Promise<number> {
      const start = performance.now();
      let frames = 0;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          frames += 1;
          if (performance.now() - start >= ms) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return Math.round((frames * 1000) / (performance.now() - start) * 10) / 10;
    },
    setDistance(d: number) {
      deps.camera.setDistance(d);
    },
    orbit(dx: number, dy: number) {
      deps.camera.orbitBy(dx, dy);
    },
    /**
     * 绝对设置环绕角（弧度）。
     *
     * 为什么需要它而不只用 `orbit`：`orbit` 是增量接口（像素 → 角度），
     * 用它"设到某个角度"要自己算差值，且**每次调用都会累积浮点误差**
     * （实测连续扫 8 个角度，误差累积到 -34157°，完全失控）。
     * 绝对 setter 让调试脚本与验收脚本都能可靠复现。
     */
    setYaw(rad: number) {
      deps.camera.setYaw(rad);
    },
    setTime(key: string) {
      return deps.renderer.setLighting(key);
    },
    setTimeImmediate(key: string) {
      return deps.renderer.setLightingImmediate(key);
    },
    /**
     * 开关接触阴影（**仅验收用**）。
     *
     * 为什么需要：接触阴影是"把地面压暗"的东西，单张截图量亮度分不清
     * 是阴影、是角色投影、还是地砖贴图造成的。开/关两张图做像素差才是证据。
     * 与审计文档 §3.2 的教训一致：测量手段本身要能被验证。
     */
    setContactShadows(enabled: boolean) {
      deps.renderer.getRoomVisual()?.setContactShadowsEnabled(enabled);
      return enabled;
    },
    /**
     * 泄漏探针（**仅验收用**）：造一整套房间视觉再销毁。
     *
     * 为什么不能靠"重建整个 WorldApp"来测：那会把物理、相机、HUD、资产一起拆了重建，
     * 中间任何一个环节的噪声都会混进 geometries/textures 计数。
     * 这里只反复建/拆 **RoomVisual** —— 本轮新增的全部渲染对象都在它里面
     * （InstancedMesh 接触阴影、LineSegments 网格线、程序化贴图、合并几何）。
     */
    leakProbe() {
      deps.renderer.rebuildRoomVisual();
    },
    lightingState() {
      return deps.renderer.getLightingState();
    },
    /**
     * 相机**实际**世界位置。
     *
     * 为什么需要它：`read().camera.distance` 只是**输入值**（玩家想拉多远），
     * 避障不会改它 —— 避障改的是最终机位。所以验收"相机有没有穿墙"
     * 必须读实际坐标，读 distance 会得到"永远没变"的错误结论。
     */
    cameraPosition() {
      const p = deps.camera.camera.position;
      return [p.x, p.y, p.z] as [number, number, number];
    },
    /**
     * 直接测物理射线（避障用的那个）。
     * 验收"避障能不能发现墙"时用它，比摆相机机位可靠得多。
     */
    raycast(
      from: [number, number, number],
      to: [number, number, number],
    ): number | null {
      const p = deps.getPhysics();
      if (!p) return null;
      return p.raycastDistance(
        { x: from[0], y: from[1], z: from[2] },
        { x: to[0], y: to[1], z: to[2] },
        100,
      );
    },
    /** 相机避障的当前可见比例（1 = 无遮挡）。 */
    boomFraction(): number {
      return deps.camera.boomVisibility;
    },
    /**
     * 玩家化身的朝向角（弧度，绕 Y）。
     *
     * 为什么单独暴露：`read().hero` 里没有朝向字段，而"模型朝向反了"这类问题
     * 必须能读到 root.rotation.y 才能判断 —— 靠截图人眼比对太慢。
     * 返回 null 表示化身还没加载。
     */
    heroFacing(): number | null {
      return deps.getHeroFacing();
    },
    /**
     * 暴露场景对象（仅 dev）。
     *
     * 为什么需要：动画是否真的在播，只能靠"读骨骼四元数看帧间有没有变化"判断。
     * 截图看动作幅度太小不可靠（idle 的呼吸幅度只有几度）。
     */
    scene(): unknown {
      return deps.renderer.scene;
    },
    /** 玩家化身当前实际在播的动画 clip（不是状态机想要的那个）。 */
    heroPlayingClips(): string[] {
      return deps.getHeroPlayingClips();
    },
    /**
     * 物理控制器内部状态（诊断"跳跃后卡死"用）。
     *
     * 为什么需要：`hero.anim` 来自 world actor，而 actor 的值由
     * `c.writeTransform` 回调写入，中间隔了两层。光看 actor 分不清
     * 是"物理没更新"还是"回调没写回"。
     */
    physState(): { anim: string; grounded: boolean; vy: number; state: string } | null {
      return deps.getPhysState();
    },
    /** animator 内部的一次性动作状态（诊断卡死用）。 */
    oneShotState(): {
      playing: boolean;
      elapsed: number;
      max: number;
      current: string;
      desired: string;
    } | null {
      return deps.getOneShotState();
    },
    /** 三个 anim 来源的实时值，用来定位"哪一层没更新"。 */
    animChain(): { actor: string; phys: string; fromPhysics: string; animator: string } {
      return deps.getAnimChain();
    },
    /** 玩家化身是否有某个 clip（验收待机轮播时用）。 */
    heroHasClip(name: string): boolean {
      return deps.getHeroHasClip(name);
    },
  };

  (window as unknown as { __worldDebug: typeof api }).__worldDebug = api;
}

/**
 * 资产探针（仅 dev 构建）。
 *
 * 做三件事，全部为了 M2 验收能拿到**真实**数字：
 * 1. 计时加载 whalegirl.glb（含 sha256 校验）
 * 2. 量归一化后的高度与脚底是否贴地
 * 3. 逐个加染色变体，每次读 renderer.info.memory.geometries
 *
 * 第 3 点是关键：如果染色变体复制了几何，geometries 会 1→2→3 线性增长；
 * 共享正确的话应该 1→1→1（材质才会增长）。
 */
function installAssetProbe(renderer: WorldRenderer): void {
  const api = {
    async measure(): Promise<Record<string, unknown>> {
      const { AssetLoader, instantiateAvatar, applyTint, AVATAR_HEIGHT_M } = await import(
        './assets/loader'
      );
      const { WHALEGIRL } = await import('./assets/registry');
      const THREE = await import('three');

      const loader = new AssetLoader({ verifyIntegrity: true });
      const t0 = performance.now();
      const loaded = await loader.loadAvatar(WHALEGIRL, renderer.renderer);
      const loadMs = Math.round(performance.now() - t0);

      // 量高度与脚底
      const box = new THREE.Box3().setFromObject(loaded.template);
      const heightM = Math.round((box.max.y - box.min.y) * 1000) / 1000;
      const feetOnGround = Math.abs(box.min.y) < 0.02;

      const baseline = renderer.renderer.info.memory.geometries;

      // 逐个加变体，每次读 geometries
      const tints = ['#ffffff', '#7fa8ff', '#ffb37a'];
      const counts: number[] = [];
      const group = new THREE.Group();
      renderer.scene.add(group);

      for (const tint of tints) {
        const inst = await instantiateAvatar(loaded.template);
        applyTint(inst, tint);
        group.add(inst);
        renderer.renderer.render(renderer.scene, new THREE.PerspectiveCamera());
        counts.push(renderer.renderer.info.memory.geometries);
      }

      const [g1, g2, g3] = counts as [number, number, number];
      // 线性增长判定：3 个变体时的几何数明显多于 1 个变体（容忍少量运行时新增）
      const geometriesLinear = g3 > g1 * 1.5;

      const stats = renderer.getStats();

      // 清理
      group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.SkinnedMesh) {
          // geometry 是共享的，只清材质，避免把模板的几何也删了
          const m = o.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      group.removeFromParent();

      return {
        bytes: loaded.bytes,
        loadMs,
        heightM,
        feetOnGround,
        expectedHeight: AVATAR_HEIGHT_M,
        originalHeightM: Math.round(loaded.originalHeight * 1000) / 1000,
        scaleApplied: Math.round(loaded.scaleApplied * 10000) / 10000,
        animations: loaded.clips.map((c) => c.name),
        baselineGeometries: baseline,
        geometries1: g1,
        geometries2: g2,
        geometries3: g3,
        geometriesLinear,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
      };
    },
  };

  (window as unknown as { __worldAssets: typeof api }).__worldAssets = api;
}

declare global {
  interface Window {
    /** M1 调试口（dev only）：fps / drawCalls / triangles / tick / tier。 */
    __worldDebug?: {
      read(): Record<string, unknown>;
      measureFps(ms?: number): Promise<number>;
      setDistance(d: number): void;
      orbit(dx: number, dy: number): void;
      /** 绝对设置环绕角（弧度）。调试/验收用，避免 orbit 的累积误差。 */
      setYaw(rad: number): void;
      /** 切换时间/天气预设（带 0.8s 平滑过渡）。返回 false 表示 key 不存在。 */
      setTime(key: string): boolean;
      /** 立即应用（无过渡），验收脚本用它避免等待。 */
      setTimeImmediate(key: string): boolean;
      /** 开关接触阴影（验收用：开/关两张图做像素差）。 */
      setContactShadows(enabled: boolean): boolean;
      /** 泄漏探针（验收用）：重建一整套房间视觉，用于验证 dispose 不泄漏。 */
      leakProbe(): void;
      /** 当前光照状态：{ current, target, progress }。 */
      lightingState(): { current: string; target: string | null; progress: number };
      /** 相机实际世界位置（避障验收用，不能用 distance 代替）。 */
      cameraPosition(): [number, number, number];
      /** 直接测物理射线（避障用的那个）。命中返回距离，无命中 null。 */
      raycast(
        from: [number, number, number],
        to: [number, number, number],
      ): number | null;
      /** 相机避障的当前可见比例（1 = 无遮挡）。 */
      boomFraction(): number;
      /** 玩家化身朝向角（弧度）；null = 化身未加载。 */
      heroFacing(): number | null;
      /** 暴露场景对象（dev only），用于读骨骼判断动画是否真的在播。 */
      scene(): unknown;
      /** 玩家化身实际在播的动画 clip 名（权重 > 0 的）。 */
      heroPlayingClips(): string[];
    };
    /** M2 资产探针（dev only）：加载耗时、归一化高度、变体 geometry 计数。 */
    __worldAssets?: { measure(): Promise<Record<string, unknown>> };
    /** M9 Agent 探针（dev only）：6 个 avatar 的数量/位置/动画状态。 */
    __agentDebug?: { read(): Record<string, unknown> };
    /** M10 交互探针（dev only）：坐/起、推箱、焦点的可复跑验收入口。 */
    __interactDebug?: import('./interact/probe').InteractProbeApi;
  }
}

/** 保留两位小数（调试探针用：原始浮点读起来太长）。 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ───────────────────────────── 启动 ─────────────────────────────

/**
 * 兜底：WebGL2 不可用 / 上下文创建失败时，给一个能读的错误页而不是白屏
 * （spec §6 M2 的「缺资产不白屏」同理，这里是缺能力）。
 */
function showBootError(err: unknown): void {
  const box = document.getElementById('boot-error');
  const msg = document.getElementById('boot-error-msg');
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (msg) msg.textContent = text;
  if (box) box.dataset['visible'] = 'true';
  console.error('[world] 启动失败', err);
}

/**
 * `?verify=1` 入口（spec §6 M12 / docs/world/verify-contract.md）。
 *
 * 为什么单独一条路径、而不是在 bootWorld 里加个 if：
 * 物理验收要的是**干净、隔离、可复现**的世界，不应该被渲染初始化、相机、HUD、
 * 甚至 WebGL 是否可用所影响。所以 verify 模式**不建渲染器**，直接跑物理用例。
 * 好处：headless 环境即使 GPU/WebGL 出问题，P1–P12 照样能测。
 *
 * 用例本身在 `src/verify/harness.ts`（归 physics-agent，判定逻辑已在那边锁死），
 * 外面由 `tools/verify-physics.mjs` 轮询 `window.__verify` 取结果。
 */
async function bootVerify(): Promise<void> {
  const { runVerify } = await import('./verify/harness');
  // 只跑指定用例（调试用）：`?verify=1&only=P6,P11`。
  // 参数从 URL 读而不是硬编码，因为"跑哪几条"是**外部驱动**的决定
  // （tools/verify-physics.mjs 的 argv），页面只负责执行。
  //
  // 注意：`report.total` 仍恒为 12（契约要求），只跑子集时外面按 cases 的长度判，
  // 不许把"只跑了 2 条"说成"12/12 通过"。
  const raw = new URLSearchParams(location.search).get('only');
  const only = raw
    ? raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^P\d+$/.test(s))
    : [];
  // 不 await 完再返回：页面要尽快把 __verify 置成 running，外面的轮询才看得到进度
  void runVerify(only.length ? { only } : {}).catch((err: unknown) => {
    console.error('[verify] 运行失败', err);
    // 契约要求：绝不能停在 running。崩了也要让外面知道是崩了而不是还在跑。
    const w = window as unknown as { __verify?: { status: string } };
    if (w.__verify) w.__verify.status = 'crashed';
  });
}

const mount = document.getElementById('app');
if (isVerifyRequest()) {
  void bootVerify();
} else if (mount) {
  try {
    const scene = new URLSearchParams(location.search).get('scene');
    if (scene === 'futian' || scene === 'nanshan') {
      void import('./city/runtime').then(async ({ loadCity }) => {
        const city = await loadCity(scene);
        bootWorld(mount, city);
      }).catch(showBootError);
    } else {
      bootWorld(mount);
    }
  } catch (err) {
    showBootError(err);
  }
} else {
  showBootError(new Error('index.html 缺少 #app 挂载点'));
}

/** 只认 `?verify=1`，与 harness 的 `isVerifyMode` 保持同一正则（避免两处规则漂移）。 */
function isVerifyRequest(): boolean {
  return /[?&]verify=1(?:&|$)/.test(window.location.search);
}

/** 是不是特写模式（`?cam=face`）。只认这一个值，别的 cam 值当默认第三人称。 */
function isFaceCamRequest(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('cam') === 'face';
  } catch {
    return false;
  }
}

/**
 * 从 URL 读 Agent 数量（`?agents=N`），默认 0。
 *
 * 为什么默认 0 而不是 6：见调用处的注释。用户要的是"一个人能在真物理世界里正常活动"，
 * 6 个 Agent 会吃约 18MB 显存、塞满画面、并让特写镜头无处落脚。
 *
 * 上限 8：spec §8 的同屏角色预算是 8，超过也没意义（会明显掉帧）。
 * 解析失败（`?agents=abc`）回落到 0 而不抛错 —— URL 参数是用户输入，不该炸页面。
 */
function readAgentCount(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('agents');
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 8);
  } catch {
    return 0;
  }
}
