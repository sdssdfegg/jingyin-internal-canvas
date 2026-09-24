# Codex 工作规则

本轮之后只以 `D:\静音AI绘画V11（源码）` 作为当前源码目录。V10、V9、V8、V5、旧 `D:\RJ\ai-canvas` 和各 `静音AI绘画-WIN（V*）` 目录只作为备份、发布包或排查对象，默认不读取、不修改。

## 默认忽略

- `node_modules/`
- `dist/`
- `.secure-build/`
- `.release-temp/`
- `.codex-artifacts/`
- `data/`
- `logs/`
- 发布包目录 `D:\RJ\静音AI绘画-WIN（V*）`
- 旧安装/asar 修补目录 `D:\RJ\ai-canvas`

## 开发流程

1. 先确认本次目标、模块、复现方式和验收标准。
2. 用 `rg` 定位相关代码，避免全目录大范围读取。
3. 只改和本次目标直接相关的文件。
4. UI 或功能逻辑改动先看 `V11维护文档/00-总索引.md` 和 `V11维护文档/02-重复功能同步登记表.md`，确认是否有同类重复点需要同步。
5. API、KEY、登录授权、接口慢、401、413 问题先看 `V11维护文档/04-API调用与登录系统地图.md`、`src/api/README.md`，不要在页面组件里散写 `fetch`。
6. 批量 tab 单独调整先看 `V11维护文档/05-批量分区功能地图.md` 和 `src/features/outfit/workflows/<分区>/README.md`。
7. 默认提示词、SKILL、出图规则先看 `prompts/README.md`；优先改 `prompts/`，不要在 UI 重构时顺手改提示词。
8. 服务端改动至少运行 `D:\RJ\node\npm.cmd run check`。
9. 前端或发布相关改动按风险运行 `D:\RJ\node\npm.cmd run build`。
10. 默认只提交本次相关文件，避免混入已有未提交改动。
