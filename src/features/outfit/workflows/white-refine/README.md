# 精修 workflow

| 项 | 内容 |
| --- | --- |
| tab | 精修（2026-09-26 前叫「批量白底图精修」，旧名字仍作为别名识别并自动迁移） |
| workflowMode | `white-refine` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_WHITE_REFINE_PAGE_NAME`、`isWhiteRefineWorkflow`、`retouchIntent`、`compileRetouchPrompt` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` |
| 本地接口 | `/api/generate-outfit` |
| 后端提示词出口 | `prompts/server/outfit-skill.js`（精修 → `buildRetouchPrompt()`，由共享编译器生成） |
| **结构化意图与编译器（唯一来源）** | `src/shared/retouch-intent.js` |
| 样式 | `src/features/outfit/retouch-intent.css`、`src/features/outfit/white-refine-split.css` |
| 验证脚本 | `scripts/verify/retouch-intent-check.mjs`（纯逻辑）、`scripts/verify/retouch-intent-request-check.mjs`（mock 上游，钉住真正发出去的提示词） |

这个分区重点是白底、平铺/挂拍精修、去衣架等，不应引入换装配对逻辑。

## 结构化精修设置（2026-09-26 新增，与换装同一套做法）

界面选择 → `retouchIntent`（批次冻结）→ `POST /api/generate-outfit` 的 `payload.retouchIntent`
→ 服务端 `validateRetouchIntent()` 权威校验（非法枚举/版本 → 400 `invalid_retouch_intent`）
→ `compileRetouchPrompt()` 编译 → 实际发送。前端预览与服务端发送**调用同一个函数**。

```js
{
  version: 1,
  symmetry: "off",                 // off | on
  hemTreatment: "follow_original", // follow_original | straight | natural_wave
  fit: "follow_original",          // follow_original | straight | waisted | loose
  customPrompt: ""
}
```

最终提示词顺序：`【用户补充】`（为空则省略）→`【服装精修目标】`→`【清理与轮廓】`→`【结构事实】`。

口径（写代码前先读这几条）：

1. **默认不强制改动**：`symmetry=off`、`hemTreatment/fit=follow_original` 时，结构段只写"跟随原图"，
   不出现"平直/自然波浪/直筒/收腰/宽松"这些改变词；关闭对称还必须明确禁止强行对称。
2. **只有用户明确选了才写改变指令**：未选的字段一律不加词。
3. **用户补充只出现一次**：页面「通用白底精修提示词」+「本次需求/商品补充信息」+ 内置「用户补充」输入框
   合成**一段**【用户补充】；其中页面提示词如果还是系统内置默认词（`WHITE_REFINE_BUILTIN_PROMPTS`）
   会被忽略，避免与固定段同义重复。
4. **不要新增识别接口**：本页不做服装事实分析，【结构事实】只放用户选的三项。
5. **横平竖直有边界**：只修正明显的拍摄摆放或线条歪扭，不把原本有意的褶裥、弧线、波浪边、不对称设计强行拉直。
6. 自动内容（三段固定文字）实测约 300~370 字，上限 `RETOUCH_AUTO_PROMPT_CHAR_LIMIT = 600`。

## 多图生图（2026-09-26 改）

**图1、图2……图N 是同一件服装的多张素材（正面/背面/侧面/细节/挂拍），一次全部上传，
点一次生成只输出一张白底成品图。**

| 项 | 内容 |
| --- | --- |
| 计划数量 | 这一页恒为 **1 张**（`plannedGenerationCount` 对 `white-refine` 直接返回 1），不再跟"生成数量"走 |
| 送图 | 图1 的**全部**图片按 `model_1_*`、`model_ref_2_*…` 一起发；图2（补充素材）继续按 `white_refine_ref_*` 发 |
| 上传区标题 | 图1 =「多图生图（图1~图N）」；图2 =「补充素材（图N+1…）」；旧标题通过 `LEGACY_WHITE_REFINE_UPLOAD_LABELS` 自动迁移（用户自己改过的标题不动） |
| 默认提示词 | `WHITE_REFINE_DEFAULT_PROMPT`（2026-09-26 按用户描述重写：多图进、一张出；颜色保真/不改结构/去道具等硬约束全部保留） |
| 旧默认词迁移 | 还停在旧默认词（`WHITE_REFINE_BATCH_LEGACY_DEFAULT_PROMPT`）的页面会自动换成新默认词；**用户自己手写过的提示词不会被覆盖** |

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

上面这些约束以前由后端 SKILL（`buildWhiteRefinePrompt()`）追加；那个 SKILL 已经删除，
现在它们只以两种形式存在：
1. **固定段**：`src/shared/retouch-intent.js` 的 `RETOUCH_GOAL_TEXT` / `RETOUCH_CLEANUP_TEXT`
   （结构化精修设置一定会带上的通用目标）；
2. **默认词**：`WHITE_REFINE_DEFAULT_PROMPT`（新页面默认填充的用户输入，用户可改可删）。

要改"每次生成都必须带上的通用要求"→ 改共享模块里的固定段；
要改"页面上默认填什么"→ 改 `WHITE_REFINE_DEFAULT_PROMPT`。
