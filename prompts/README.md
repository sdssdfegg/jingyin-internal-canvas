# 提示词与 SKILL 中心

这里是 V11 后续统一维护默认提示词、SKILL 和工作流规则的地方。

> **2026-09-26 重大变更：批量生成的 SKILL / 图1图2 规则已整体删除**（用户实测"不加 SKILL 和
> 图1/图2 的规则效果更好"）。批量侧服务端现在**只发用户自己写的文字**：
> 原始提示词 + 姿态锚点智能文本 + 场景补充，逐字不改；"换装规则"开关、快捷生成"换装"开关
> 也一起删掉了。`prompts/server/outfit-skill.js` 只剩提示词出口与错误摘要归一。
> 一键详情/主图的 `detail-skills.js` **不受影响**，仍是各自独立的规则集。

原则：改出图规则时，只改 `prompts/` 里的文件；不要顺手改 UI、上传、保存、并发、历史记录。

## 当前目录

```text
prompts/
  README.md
  server/
    outfit-skill.js       批量生成最终提示词出口（2026-09-26 起 = 只发用户原话，规则已删除）
    detail-skills.js      一键详情/主图的行业、平台、质检规则（仍然生效）
  frontend/
    README.md             前端默认提示词归档计划
```

## 现在已集中管理的规则

| 规则 | 维护文件 | 旧兼容入口 |
| --- | --- | --- |
| 批量生成（换装/姿态/固定背景/随机背景/扩图/改色/白底精修/换脸/设计稿/局部回贴）最终提示词出口 | `prompts/server/outfit-skill.js`（**只发用户原话，不追加规则**） | `server/outfit-skill.js` |
| 一键详情/主图行业规则、平台规则、质量检查规则 | `prompts/server/detail-skills.js` | `server/detail-skills.js` |

旧兼容入口只负责转发，方便现有代码继续运行；以后真实修改请进 `prompts/`。

## 仍待逐步迁移的前端默认提示词

这些目前还在大前端文件里，建议后续按功能逐块迁入 `prompts/frontend/`：

| 类型 | 当前位置 | 建议目标 |
| --- | --- | --- |
| 快捷生成提示词出口 | `src/shared/quickgen-prompt-rules.js`（只 trim，无追加规则） | 已独立成模块，可原样搬 |
| 参考生图默认组合提示词 | `src/main.jsx` 的 `buildReferenceRemixPrompt`、`buildSmartReferencePrompt` | `prompts/frontend/reference-prompts.js` |
| 批量换装页面默认提示词 | `src/outfit-workflow.jsx` 的 `OUTFIT_DEFAULT_PROMPT` 等 | `prompts/frontend/outfit-default-prompts.js` |
| 批量姿态/固定背景/随机背景/扩图/改色/白底/换脸/设计稿默认提示词 | `src/outfit-workflow.jsx` 的各 `*_DEFAULT_PROMPT` | `prompts/frontend/outfit-workflow-defaults.js` |
| 提示词助手内置预设 | `src/outfit-workflow.jsx` 的 `PROMPT_BUILTIN_PRESETS`、`BUILTIN_PROMPT_LIBRARY` | `prompts/frontend/prompt-library-presets.js` |
| 视频提示词占位文字 | `server/video-config.js` | 后续可迁到 `prompts/server/video-prompts.js` |

## 修改规则

1. 批量生成**不再有**"模型最终吃到的规则"这一层：要影响出图，就改默认提示词（前端）或让用户自己写。
   如果将来要重新引入规则，请先单独确认，不要用旧字段偷偷接回来。
2. 如果要改"用户一打开页面看到的默认提示词"，改 `prompts/frontend/` 中对应文件；尚未迁移的先按上表到当前位置修改。
3. 一键详情/主图仍然有后端规则集（`prompts/server/detail-skills.js`），改它时注意前后端同步检查。
4. 前端默认提示词负责让用户看得懂、可编辑；批量侧不再有"后端硬规则"配合。
5. 不要把 API Key、渠道商地址、价格、账号信息写进任何提示词文件。

## 修改后必跑

```powershell
npm run check
npm run build
```

