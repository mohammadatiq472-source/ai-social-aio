// 存储驱动入口：业务代码只认这里导出的 storage()。
// 现在只有 local；以后加 COS / R2 时，在本文件里按 STORAGE_DRIVER 选择实现，
// media.mjs 里的 put / putFromFile / stat / createReadStream / delete / tmpFile 都不用改。
import { config } from '../config.mjs';
import { createLocalStorage } from './local.mjs';

let instance = null;

export function storage() {
  if (instance) return instance;
  const driver = String(config.storageDriver || 'local').toLowerCase();
  switch (driver) {
    case 'local':
      instance = createLocalStorage({ root: config.mediaDir });
      break;
    // 预留：case 'cos': instance = createCosStorage({...}); break;
    // 预留：case 'r2':  instance = createR2Storage({...}); break;
    default:
      throw new Error(`未知的 STORAGE_DRIVER: ${driver}（目前只支持 local）`);
  }
  return instance;
}

/** 测试用：重置单例（切换驱动/配置后调用） */
export function resetStorage() {
  instance = null;
}
