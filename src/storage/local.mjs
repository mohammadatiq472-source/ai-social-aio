// 本地磁盘存储驱动（默认）。
// 接口刻意做得像对象存储：put / putFromFile / stat / createReadStream / delete / tmpFile。
// 以后接 COS / R2 时，实现同样的方法即可，业务代码（media.mjs）不用改。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function createLocalStorage({ root }) {
  const base = path.resolve(root);

  /** 防目录穿越：key 必须是 base 下的相对路径 */
  function resolveKey(key) {
    const abs = path.resolve(base, String(key));
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new Error(`storage key escapes root: ${key}`);
    }
    return abs;
  }

  return {
    kind: 'local',
    root: base,

    /** 临时目录（上传时先写这里，原子改名进正式位置） */
    async ensureTmpDir() {
      const dir = path.join(base, 'tmp');
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    },

    /** 生成一个临时文件绝对路径（不创建文件） */
    async tmpFile(prefix = 'incoming') {
      const dir = await this.ensureTmpDir();
      return path.join(dir, `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`);
    },

    /** 小文件：整块写入（先写临时文件再 rename，避免读到半个文件） */
    async put(key, buffer) {
      const abs = resolveKey(key);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      await fsp.writeFile(tmp, buffer, { mode: 0o644 });
      await fsp.rename(tmp, abs);
    },

    /** 大文件：把已写好的临时文件原子移动到正式路径；目标已存在时删临时文件 */
    async putFromFile(tmpPath, key) {
      const abs = resolveKey(key);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      try {
        await fsp.rename(tmpPath, abs);
      } catch (err) {
        if (err.code === 'EEXIST' || err.code === 'EPERM') {
          await fsp.unlink(tmpPath).catch(() => {});
        } else {
          throw err;
        }
      }
      await fsp.chmod(abs, 0o644).catch(() => {});
    },

    /** 元数据：没有文件返回 null */
    async stat(key) {
      try {
        const st = await fsp.stat(resolveKey(key));
        if (!st.isFile()) return null;
        return { bytes: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },

    /** 可读流（支持单段 Range） */
    createReadStream(key, range) {
      return fs.createReadStream(resolveKey(key), range ? { start: range.start, end: range.end } : undefined);
    },

    async delete(key) {
      await fsp.unlink(resolveKey(key)).catch(() => {});
    },

    /** 清掉空的分片目录（本地盘特有；对象存储没有这个概念） */
    async cleanEmptyDirs() {
      try {
        for (const d1 of await fsp.readdir(base)) {
          const p1 = path.join(base, d1);
          const st1 = await fsp.stat(p1).catch(() => null);
          if (!st1?.isDirectory() || d1 === 'tmp') continue;
          for (const d2 of await fsp.readdir(p1)) {
            const p2 = path.join(p1, d2);
            const st2 = await fsp.stat(p2).catch(() => null);
            if (st2?.isDirectory() && (await fsp.readdir(p2)).length === 0) await fsp.rmdir(p2).catch(() => {});
          }
          if ((await fsp.readdir(p1)).length === 0) await fsp.rmdir(p1).catch(() => {});
        }
      } catch {
        /* 清理失败不影响主流程 */
      }
    },
  };
}
