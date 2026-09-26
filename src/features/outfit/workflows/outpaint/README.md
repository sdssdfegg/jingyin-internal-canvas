# 批量扩图 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量扩图 |
| workflowMode | `outpaint` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_OUTPAINT_PAGE_NAME`、`OUTPAINT_DEFAULT_PROMPT`、`isOutpaintWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

这个分区主要处理向下扩图/补全画布，通常不需要图2服装。改尺寸比例和扩图方向时优先只动本分区。
