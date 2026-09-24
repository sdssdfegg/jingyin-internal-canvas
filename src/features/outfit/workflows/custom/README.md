# 临时需求 workflow

| 项 | 内容 |
| --- | --- |
| tab | 临时需求/自定义新增页 |
| workflowMode | `custom` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_CUSTOM_PAGE_NAME`、`isCustomWorkflow`、`CUSTOM_UPLOAD_LABELS` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |

这个分区用于临时需求和试验页。稳定后应迁成明确 workflow，不要让长期功能一直留在 custom。
