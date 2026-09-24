# 提示词与 SKILL 中心

这里是 V11 后续统一维护默认提示词、SKILL 和工作流规则的地方。

原则：改出图规则时，只改 `prompts/` 里的文件；不要顺手改 UI、上传、保存、并发、历史记录。

## 当前目录

```text
prompts/
  README.md
  server/
    outfit-skill.js       批量生成/换装/扩图/改色/换脸等后端最终生图 SKILL
    detail-skills.js      一键详情/主图的行业、平台、质检规则
  frontend/
    README.md             前端默认提示词归档计划
```

## 现在已集中管理的规则

| 规则 | 维护文件 | 旧兼容入口 |
| --- | --- | --- |
| 批量换装、批量姿态、固定背景、随机背景、批量扩图、批量改色、白底精修、批量换脸、设计稿、局部回贴最终生图 SKILL | `prompts/server/outfit-skill.js` | `server/outfit-skill.js` |
| 一键详情/主图行业规则、平台规则、质量检查规则 | `prompts/server/detail-skills.js` | `server/detail-skills.js` |

旧兼容入口只负责转发，方便现有代码继续运行；以后真实修改请进 `prompts/`。

## 仍待逐步迁移的前端默认提示词

这些目前还在大前端文件里，建议后续按功能逐块迁入 `prompts/frontend/`：

| 类型 | 当前位置 | 建议目标 |
| --- | --- | --- |
| 快捷生成局部编辑默认追加词 | `src/main.jsx` 的 `QUICK_*_PROMPT_SUFFIX` | `prompts/frontend/quickgen-prompts.js` |
| 参考生图默认组合提示词 | `src/main.jsx` 的 `buildReferenceRemixPrompt`、`buildSmartReferencePrompt` | `prompts/frontend/reference-prompts.js` |
| 批量换装页面默认提示词 | `src/outfit-workflow.jsx` 的 `OUTFIT_DEFAULT_PROMPT` 等 | `prompts/frontend/outfit-default-prompts.js` |
| 批量姿态/固定背景/随机背景/扩图/改色/白底/换脸/设计稿默认提示词 | `src/outfit-workflow.jsx` 的各 `*_DEFAULT_PROMPT` | `prompts/frontend/outfit-workflow-defaults.js` |
| 提示词助手内置预设 | `src/outfit-workflow.jsx` 的 `PROMPT_BUILTIN_PRESETS`、`BUILTIN_PROMPT_LIBRARY` | `prompts/frontend/prompt-library-presets.js` |
| 视频提示词占位文字 | `server/video-config.js` | 后续可迁到 `prompts/server/video-prompts.js` |

## 修改规则

1. 如果要改“模型最终吃到的规则”，优先改 `prompts/server/outfit-skill.js`。
2. 如果要改“用户一打开页面看到的默认提示词”，改 `prompts/frontend/` 中对应文件；尚未迁移的先按上表到当前位置修改。
3. 同一个工作流的前端默认提示词和后端 SKILL 要同步检查，但不要写成完全重复的长文本。
4. 前端默认提示词负责让用户看得懂、可编辑；后端 SKILL 负责模型执行边界。
5. 图3规则、局部回贴规则、母版锁版型规则是核心稳定链路，修改前先单独记录原因和回归素材。
6. 不要把 API Key、渠道商地址、价格、账号信息写进任何提示词文件。

## 修改后必跑

```powershell
D:\RJ\node\npm.cmd run check
D:\RJ\node\npm.cmd run build
```
