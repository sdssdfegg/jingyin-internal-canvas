# V3 批量局部回贴稳定基线

日期：2026-08-06

用途：这是当前批量生成里 GPT 和 Nano Banana 2 局部回贴都不明显偏移的稳定基线。后续调整 SKILL、局部回贴、姿态锁定、贴回合成或批量生成后台逻辑，如果效果变差，优先用本目录文件对照或恢复。

重点保护：
- `server/outfit-skill.js`：批量生成 SKILL、图2迁移范围、服装长度、局部回贴、模型适配规则。
- `server/outfit-pose-ai.js`：智能文本/姿态锚点分析。
- `src/outfit-workflow.jsx`：批量生成局部回贴触发、任务参数、贴回合成调用。
- `src/local-edit-mask.js`：局部框选/涂抹蒙版基础处理。
- `server/index.js`：批量生成请求、模型调用、下载/缓存/上传相关后台通道。
- `src/main.jsx`：快捷生成局部回贴参考状态，避免后续排查时混淆。

哈希校验：
- `outfit-skill.js`：`1696EB274C0065364BBB4AAD370A53CDB3E3271EAD721908118E2B5A966CA908`
- `outfit-pose-ai.js`：`16B08D3AF400A12E1983DCA904C90DEC384F857A405A41BE0DC6CC5EC7EE7D9D`
- `outfit-workflow.jsx`：`77B837EFA4E018093E86CC3682AE1481A7B0BFC0CB8A5C7355142B81BFF9BE44`
- `local-edit-mask.js`：`B9809B0471F8296BCB9451E1CE3A1C5088452DC1471D2CEE75731E2E5A776EEF`
- `main.jsx`：`BDB8244166D7B82653A7DC69B28509816D35AC993C7F6835B71C6D393B490A4E`
- `server-index.js`：`DCA6049C40239330D7649F738C8B975A6B378668E7A97BFCFA832E4925B923B0`
