# 批量改色 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量改色 |
| workflowMode | `recolor` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_RECOLOR_PAGE_NAME`、`RECOLOR_DEFAULT_PROMPT`、`isRecolorWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

图1是原图，图2是颜色参考。这个分区会复用服装部位选择控件，改控件时同步检查批量换装。
