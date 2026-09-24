# 批量姿态 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量姿态 |
| workflowMode | `pose-remix` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_POSE_REMIX_PAGE_NAME`、`POSE_REMIX_DEFAULT_PROMPT`、`isPoseRemixWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 辅助后端 | `server/outfit-pose-ai.js` |

图1是姿态参考，图2是固定母版/人物。这个分区不应单独复制换装接口，只改变任务构建和提示词规则。
