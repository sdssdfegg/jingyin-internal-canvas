# 固定背景 workflow

| 项 | 内容 |
| --- | --- |
| tab | 固定背景 |
| workflowMode | `background-change` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_BACKGROUND_CHANGE_PAGE_NAME`、`BACKGROUND_CHANGE_DEFAULT_PROMPT`、`isBackgroundChangeWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

图1是人物/商品图，图2是固定场景或背景参考。这个分区重点是背景替换，不应顺手改换装迁移规则。
