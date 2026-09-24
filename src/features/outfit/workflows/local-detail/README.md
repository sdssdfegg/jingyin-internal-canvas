# 局部回贴 workflow

| 项 | 内容 |
| --- | --- |
| tab | 局部回贴 |
| workflowMode | `local-detail` |
| 当前代码 | `src/outfit-workflow.jsx`、`src/shared/local-edit-mask.js` |
| 搜索词 | `DEFAULT_LOCAL_DETAIL_PAGE_NAME`、`LOCAL_DETAIL_DEFAULT_PROMPT`、`isLocalDetailWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端 SKILL | `prompts/server/outfit-skill.js` |

局部回贴依赖蒙版和裁剪框，底层蒙版规则已经在 `src/shared/local-edit-mask.js`。改蒙版算法时要同步检查快捷生成的局部编辑。
