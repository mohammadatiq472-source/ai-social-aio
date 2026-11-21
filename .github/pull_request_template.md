## 这个 PR 做了什么

<!-- 一句话；然后写为什么（约束/坑），不要只写"优化了性能" -->

Closes #

## 写域（CONTRIBUTING §3）

- [ ] 我只改了任务写域内的文件；跨写域已在 issue 里申请并得到授权
- [ ] 没有改公共脊柱（`world/src/main.ts`、`world/src/render/scene.ts`、`world/index.html`、`world/vite.config.ts`、`world/package.json`、`world/README.md`）

## 验证（CONTRIBUTING §5）

<!-- 贴命令与输出摘要；没跑的项明确写"未验证" -->

- [ ] CI：`verify` + `world` job 绿（`ui` job 有 2 条已知基线红，见 CONTRIBUTING §5；不是我引入的请在下面注明）

- [ ] `cd world && npx tsc --noEmit` → 0 错误
- [ ] `cd world && npx vitest run` → ____/____ 通过
- [ ] 物理/控制器改动：`npm run build && npm run verify` → 12/12
- [ ] 渲染/光照/房间改动：`npm run verify:scene` → 17/17
- [ ] 街区改动：`python scripts/verify/verify-futian-city.py` → 通过
- [ ] 首屏/帧率改动：`verify-perf.mjs --hardware` → 冷启动 ____ms，帧率 ____

## 数据与许可（只在动数据/资产时勾）

- [ ] 没有把原始数据/瓦片/构建产物提交进 git
- [ ] 新素材留了来源、作者、许可、SHA256 与重建脚本
- [ ] 派生数据保留了 ODbL / CC BY 4.0 署名

## 风险与回滚

<!-- 最坏情况是什么；出问题怎么 revert -->
