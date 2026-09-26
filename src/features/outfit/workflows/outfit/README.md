# 批量换装 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量换装 |
| workflowMode | `outfit` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_OUTFIT_PAGE_NAME`、`OUTFIT_DEFAULT_PROMPT`、`isOutfitWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

图1是模特/主体图，图2是服装图，图3是可选参考图。这个 workflow 是其他批量分区的主模板，改通用上传、任务队列、结果卡时要同步检查其他 workflow。
