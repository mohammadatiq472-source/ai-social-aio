/**
 * 可推动刚体（M3 归物理 Agent）。占位。
 */

export interface PropOptions {
  id: string;
  /** 质量（kg）。P8 验收要求 10kg 箱子可被持续推动。 */
  mass: number;
  /** 半尺寸（米）。 */
  halfExtents: [number, number, number];
}

/** 占位：M3 用 Rapier 的 RigidBodyDesc.dynamic() 实现。 */
export interface PropHandle {
  readonly id: string;
  applyImpulse(x: number, y: number, z: number): void;
}
