# 批量工作流分区

这里对应截图里的批量 tab。当前主要代码还在 `src/outfit-workflow.jsx`，本目录先作为拆分地图，后续每次只迁一个 workflow。

## 共用层

这些能力不要按 workflow 复制：

```text
src/api/outfit.js                  批量生成 API 封装
src/features/auth/api-key.js       用户 KEY 清洗
src/shared/models.js               模型和尺寸
src/shared/local-edit-mask.js      局部编辑蒙版
prompts/server/outfit-skill.js     后端最终生图 SKILL
server/features/api-gateway/       中转站链路地图
```

## tab 对应关系

| tab | workflowMode | 当前搜索词 | 目标目录 |
| --- | --- | --- | --- |
| 换装（旧名：批量换装） | `outfit` | `DEFAULT_OUTFIT_PAGE_NAME`、`OUTFIT_DEFAULT_PROMPT`、`isOutfitWorkflow` | `outfit/` |
| 批量姿态 | `pose-remix` | `DEFAULT_POSE_REMIX_PAGE_NAME`、`POSE_REMIX_DEFAULT_PROMPT`、`isPoseRemixWorkflow` | `pose-remix/` |
| 批量换脸 | `face-swap` | `DEFAULT_FACE_SWAP_PAGE_NAME`、`FACE_SWAP_DEFAULT_PROMPT`、`isFaceSwapWorkflow` | `face-swap/` |
| 固定背景 | `background-change` | `DEFAULT_BACKGROUND_CHANGE_PAGE_NAME`、`BACKGROUND_CHANGE_DEFAULT_PROMPT`、`isBackgroundChangeWorkflow` | `background-change/` |
| 随机背景 | `random-background` | `DEFAULT_RANDOM_BACKGROUND_PAGE_NAME`、`RANDOM_BACKGROUND_DEFAULT_PROMPT`、`isRandomBackgroundWorkflow` | `random-background/` |
| 批量改色 | `recolor` | `DEFAULT_RECOLOR_PAGE_NAME`、`RECOLOR_DEFAULT_PROMPT`、`isRecolorWorkflow` | `recolor/` |
| 精修（旧名：批量白底图精修） | `white-refine` | `DEFAULT_WHITE_REFINE_PAGE_NAME`、`WHITE_REFINE_DEFAULT_PROMPT`、`isWhiteRefineWorkflow` | `white-refine/` |
| 设计稿 | `design-draft` | `DEFAULT_DESIGN_DRAFT_PAGE_NAME`、`DESIGN_DRAFT_DEFAULT_PROMPT`、`isDesignDraftWorkflow` | `design-draft/` |
| 批量扩图 | `outpaint` | `DEFAULT_OUTPAINT_PAGE_NAME`、`OUTPAINT_DEFAULT_PROMPT`、`isOutpaintWorkflow` | `outpaint/` |
| 局部回贴 | `local-detail` | `DEFAULT_LOCAL_DETAIL_PAGE_NAME`、`LOCAL_DETAIL_DEFAULT_PROMPT`、`isLocalDetailWorkflow` | `local-detail/` |
| 临时需求 | `custom` | `DEFAULT_CUSTOM_PAGE_NAME`、`isCustomWorkflow` | `custom/` |

`词` tab 请看 `src/features/prompt-library/README.md`。

## 修改规则

1. 改某个 tab 时先看对应子目录 README。
2. 不要复制 API 调用、KEY 设置、上传组件和结果卡片。
3. 默认提示词先看 `prompts/frontend/README.md`，最终 SKILL 先看 `prompts/server/outfit-skill.js`。
4. workflow 的差异只放在页面配置、上传图含义、提示词选择、任务构建规则里。
