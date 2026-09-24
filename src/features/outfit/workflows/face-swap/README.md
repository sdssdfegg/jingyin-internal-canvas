# 批量换脸 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量换脸 |
| workflowMode | `face-swap` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_FACE_SWAP_PAGE_NAME`、`FACE_SWAP_DEFAULT_PROMPT`、`isFaceSwapWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端 SKILL | `prompts/server/outfit-skill.js` |

图1是目标人物图，图2是人脸参考图。改人脸锁定、肤色、头发保留等规则时，先改本分区默认词和后端 SKILL 边界。
