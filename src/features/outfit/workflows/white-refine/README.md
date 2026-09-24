# 批量白底精修 workflow

| 项 | 内容 |
| --- | --- |
| tab | 批量白底精修 |
| workflowMode | `white-refine` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_WHITE_REFINE_PAGE_NAME`、`WHITE_REFINE_DEFAULT_PROMPT`、`isWhiteRefineWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端 SKILL | `prompts/server/outfit-skill.js` |

这个分区重点是白底、平铺/挂拍精修、去衣架等，不应引入换装配对逻辑。

## 当前优化重点

- 颜色保真：白底清理不能顺带商业调色、提饱和、提对比、加深颜色或自动锐化。
- 牛仔重点：不提蓝、不提饱和、不把旧水洗修成新牛仔，保留原始靛蓝深浅、水洗分布、灰度、磨白和缝线颜色。
- 道具清理：衣架、挂钩、夹子、图钉、别针、固定针、支撑物都要去掉，并用同一件衣服附近纹理自然补齐。
- 褶皱整理：去运输压痕、固定造成的尖锐折痕和多余皱团，但保留结构褶、自然垂感和面料纹理。

改默认提示词优先看 `src/outfit-workflow.jsx` 的 `WHITE_REFINE_DEFAULT_PROMPT`；改最终发给模型的硬规则看 `prompts/server/outfit-skill.js` 的 `buildWhiteRefinePrompt()`。
