# features 目录

这里放前端功能板块。每个功能板块只负责自己的页面 UI、页面状态和页面内部交互。

目标结构示例：

```text
src/features/
  auth/
    api-key.js
    AuthSettingsModal.jsx
  quickgen/
    QuickGenView.jsx
    quickgen-state.js
    quickgen.css
  outfit/
    OutfitWorkflow.jsx
    outfit-state.js
    outfit-task-builder.js
    outfit.css
  reference-remix/
  detail-main/
  image-editor/
  resize-export/
  prompt-library/
  video/
```

## 前后端对应规则

一个功能如果同时有前端和后端，按同名功能目录对应：

```text
src/features/outfit/       前端批量生成 UI、状态、任务组装
server/features/outfit/    后端批量生成接口服务、文件处理、日志
prompts/server/            最终给模型的 SKILL
prompts/frontend/          用户可见默认提示词
```

## 已建立的分区地图

```text
src/features/auth/README.md
src/features/prompt-library/README.md
src/features/outfit/workflows/README.md
```

批量 tab 的每个业务分区都在 `src/features/outfit/workflows/<workflow>/README.md` 里有单独说明。当前实际代码仍在 `src/outfit-workflow.jsx`，后续每次只迁一个 workflow。

## 不应该放在功能目录里的内容

- 多个页面共用的按钮、弹窗、上传区、图库、任务状态样式：放 `src/shared/ui/`。
- 多个页面共用的图片处理、蒙版、模型列表、格式化工具：放 `src/shared/` 或 `src/lib/`。
- 默认提示词和 SKILL：放 `prompts/`。
- API 请求封装：放 `src/api/`。
- 用户 KEY 清洗、授权错误识别：放 `src/features/auth/`。

判断方法：如果改这个东西会影响两个以上页面，它就不是某个功能私有代码，应该进 shared。
