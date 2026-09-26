# 批量换脸 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量换脸 |
| workflowMode | `face-swap` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_FACE_SWAP_PAGE_NAME`、`FACE_SWAP_DEFAULT_PROMPT`、`isFaceSwapWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

图1是目标人物图，图2是人脸参考图。2026-09-26 起后端不再追加任何 SKILL / 规则（只发用户原话），
人脸锁定、肤色、头发保留这些要求要靠本分区默认词或用户自己写进提示词。
