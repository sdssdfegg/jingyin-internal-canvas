# frontend 默认提示词

这里用于逐步集中前端默认提示词、提示词助手预设和用户可见的默认文案。

当前先建目录和迁移规则，暂不一次性搬空 `src/main.jsx`、`src/outfit-workflow.jsx` 里的长默认词。原因是这些默认词和页面初始化、旧缓存迁移、工作流模式判断绑得比较紧，一次性全搬风险高。

## 后续文件规划

```text
frontend/
  quickgen-prompts.js              快捷生成、局部编辑、整图换装默认补充词
  reference-prompts.js             参考生图默认组合提示词
  outfit-default-prompts.js        批量换装主默认提示词
  outfit-workflow-defaults.js      姿态、背景、扩图、改色、白底、换脸、设计稿等页面默认词
  prompt-library-presets.js        提示词助手内置预设
```

## 迁移要求

1. 每次只迁一个功能的默认提示词。
2. 迁移后页面显示文字必须和迁移前一致，除非本次目标就是改提示词。
3. 如果默认提示词有旧缓存自动迁移逻辑，要同时迁移对应判断。
4. 前端默认词只负责用户可见和可编辑的初始内容，不要塞入渠道、KEY、价格、上游策略。
5. 改完必须跑 `npm run build`，并打开对应页面确认默认词还在。
