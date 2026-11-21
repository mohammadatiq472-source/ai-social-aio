// 探针：找出"关 CCD 时真的会穿墙"的临界速度。
// 如果找不到，说明在合理速度范围内离散检测够用，那 CCD 是防御性配置而非修复真 bug。
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../src/physics/engine.ts';
import { parseRoom } from '../src/core/room.ts';

const room = parseRoom({
  name: 'thinwall',
  spawn: [[0, 1, 0]],
  lights: [],
  static: [
    { type: 'box', size: [20, 0.2, 20], pos: [0, -0.1, 0], mat: 'floor' },
    { type: 'box', size: [20, 2, 0.2], pos: [0, 1, -3], mat: 'wall' },
  ],
  props: [],
  seats: [],
});

async function fling(ccd: boolean, speed: number): Promise<number> {
  const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
  try {
    const prop = pw.spawnProp(0.25, 0.25, 0.25, 10, 0, 0.5, 0, ccd);
    prop.body.enableCcd(ccd);
    prop.body.setLinvel({ x: 0, y: 0, z: -speed }, true);
    for (let i = 0; i < 90; i++) pw.step();
    return prop.body.translation().z;
  } finally {
    pw.dispose();
  }
}

console.log('速度(m/s)  关CCD最终z    开CCD最终z    墙在 -3');
console.log('─'.repeat(58));
for (const v of [30, 60, 100, 150, 200, 300, 500, 800, 1200]) {
  const off = await fling(false, v);
  const on = await fling(true, v);
  const offPass = off > -3 ? '挡住' : '❌穿墙';
  const onPass = on > -3 ? '挡住' : '❌穿墙';
  console.log(
    `${String(v).padStart(7)}  ${off.toFixed(2).padStart(9)} ${offPass.padStart(6)}  ` +
      `${on.toFixed(2).padStart(9)} ${onPass.padStart(6)}`,
  );
}
