# 精修 workflow

| 项 | 内容 |
| --- | --- |
| tab | 精修（2026-09-26 前叫「批量白底图精修」，旧名字仍作为别名识别并自动迁移） |
| workflowMode | `white-refine` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_WHITE_REFINE_PAGE_NAME`、`WHITE_REFINE_DEFAULT_PROMPT`、`isWhiteRefineWorkflow` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（2026-09-26 起 = 只发用户原话，SKILL/规则已删除） |

这个分区重点是白底、平铺/挂拍精修、去衣架等，不应引入换装配对逻辑。

## 结果图中线剪裁成两张（2026-09-26 新增，参考 3.0）

用户的工作流是「图1+图2 正反两件并列摆放，一次生成」，成品需要再拆成左右两张。

| 项 | 内容 |
| --- | --- |
| 开关位置 | 结果区顶部（`.resultPanel` 第一个子元素），**只在精修页渲染** |
| 开关文案 | 「裁剪」+ 绿色滑块；提示行跟随状态 |
| 默认值 | **打开** |
| 状态存储 | `localStorage["jingyin-white-refine-split-halves-v1"]`（`"1"`/`"0"`，只有明确存过 `"0"` 才算关闭）—— 与 3.0 完全同一个键、同一套语义 |
| 切法 | 纯竖切中线：`middle = clamp(floor(宽/2), 1, 宽-1)`，**不补边、不改比例**（3.0 `white_refine_split_save_result_bytes` 同口径） |
| 触发时机 | 该任务生成成功后（`runSingleTask` 成功分支），按**任务自己的 `workflowMode === "white-refine"`** 判断，生成过程中切页不会误裁别的页面 |
| 保存 | 两张 PNG 直接落进保存目录根目录（和 3.0 一样，不塞子目录），复用 `/api/save-processed-image` |
| 实现位置 | 纯算法/开关在 `src/shared/image-split.js`；接线在 `src/outfit-workflow.jsx`；样式 `src/features/outfit/white-refine-split.css` |
| 验证脚本 | `scripts/verify/white-refine-split-check.mjs`（中线算法 + 开关语义 + 前端接线 + 两张半图真的落盘） |

为什么不在服务端切：V11 服务端不做图像处理（只搬字节，没有 Pillow/sharp 这类依赖），
所以用浏览器 canvas 按同一套口径切好再存，结果与 3.0 一致。

## 当前优化重点

- 颜色保真：白底清理不能顺带商业调色、提饱和、提对比、加深颜色或自动锐化。
- 牛仔重点：不提蓝、不提饱和、不把旧水洗修成新牛仔，保留原始靛蓝深浅、水洗分布、灰度、磨白和缝线颜色。
- 道具清理：衣架、挂钩、夹子、图钉、别针、固定针、支撑物都要去掉，并用同一件衣服附近纹理自然补齐。
- 褶皱整理：去运输压痕、固定造成的尖锐折痕和多余皱团，但保留结构褶、自然垂感和面料纹理。

上面这些约束以前由后端 SKILL（`buildWhiteRefinePrompt()`）追加；**2026-09-26 起后端只发用户原话**，
所以它们现在只作为"默认提示词"的内容存在：改默认词看 `src/outfit-workflow.jsx` 的 `WHITE_REFINE_DEFAULT_PROMPT`，
或在提示词里自己写清楚。
