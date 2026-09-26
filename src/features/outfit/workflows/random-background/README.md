# 随机背景 workflow

| 项 | 内容 |
| --- | --- |
| tab | 随机背景 |
| workflowMode | `random-background` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_RANDOM_BACKGROUND_PAGE_NAME`、`RANDOM_BACKGROUND_DEFAULT_PROMPT`、`isRandomBackgroundWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

这个分区通常只上传图1，并依赖“场景补充”。改场景随机规则时不要改固定背景的图2配对逻辑。

## 当前优化重点

- 目标场景光照优先：先固定同一时间段、同一亮度层级、同一中性日光白平衡，再让人物自然融入。
- 校正图1室内暖光：图1模特身上的偏黄、偏橙、暗沉属于旧光源污染，不作为新背景的色温标准。
- 禁止硬抠贴图：人物边缘、发丝、衣服边缘、脚底接触阴影必须像真实拍摄，不能有白边、黑边、锯齿边、旧背景残边或贴纸感。
- 整批统一：禁止一张暖黄、一张背光阴天、一张地面大太阳斑；随机的是机位和背景细节，不是亮度体系。

上面这些约束以前由后端 SKILL（`buildRandomBackgroundPrompt()`）追加；**2026-09-26 起后端只发用户原话**，
所以它们现在只作为"默认提示词"的内容存在：改默认词看 `src/outfit-workflow.jsx` 的 `RANDOM_BACKGROUND_DEFAULT_PROMPT`，
或在提示词里自己写清楚。
