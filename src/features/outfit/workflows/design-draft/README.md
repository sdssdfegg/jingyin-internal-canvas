# 设计稿 workflow

| 项 | 内容 |
| --- | --- |
| tab | 设计稿 |
| workflowMode | `design-draft` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_DESIGN_DRAFT_PAGE_NAME`、`DESIGN_DRAFT_DEFAULT_PROMPT`、`isDesignDraftWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

设计稿通常是特殊 SKILL 和单任务生成逻辑。改这里时要单独确认是否仍保持并发/任务数量限制。
