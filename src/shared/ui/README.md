# shared/ui 目录

这里放多个页面共用的 UI 组件。目标是避免同类 UI 在不同功能里各写一套，导致只改一个页面、另一个页面不同步。

## 必须优先共用的 UI

| UI 类型 | 当前重复风险 | 以后组件名建议 |
| --- | --- | --- |
| 普通按钮、图标按钮、危险按钮 | `main.jsx` 和 `outfit-workflow.jsx` 都有 | `Button.jsx`、`IconButton.jsx` |
| 设置弹窗 | 主画板和批量页都有 KEY/皮肤设置 | `SettingsModal.jsx` |
| 上传区 | 快捷/参考/详情/批量都有上传预览 | `UploadZone.jsx` |
| 结果图库卡片 | 快捷结果、参考结果、批量结果都有 | `ResultCard.jsx`、`ResultGrid.jsx` |
| 参考图缩略条 | 快捷、批量、详情结果都可能用 | `ReferenceThumbTray.jsx` |
| 顶部工具栏 | 主画板和批量页都有刷新、下载、清空、打开目录 | `TopToolbar.jsx` |
| 状态徽标 | running/success/failed/queued 多处重复 | `TaskBadge.jsx` |
| 弹窗底层 | 设置、预览、提示词、裁剪都用 | `Modal.jsx` |
| 局部编辑/裁剪控件 | 快捷和批量都有 | 后续放 `src/features/local-edit/`，公共底层放 `src/shared/` |

## 修改规则

1. 如果两个以上页面长得一样或行为一样，先抽到 `src/shared/ui/`。
2. 功能页面只传参数，不复制 CSS 和 JSX。
3. 共享组件必须支持必要的变体，例如 `variant="danger"`、`size="small"`、`active`、`disabled`。
4. 共享组件样式只维护一份，功能页不要重新覆盖同名样式。
5. 如果暂时不能抽组件，必须在 `V11维护文档/02-重复功能同步登记表.md` 记录“改 A 要同步看 B”。

## CSS 规则

长期目标：

```text
src/shared/ui/ui.css        通用按钮、弹窗、上传、图库、状态
src/features/<name>/*.css   功能私有布局和少量特殊样式
```

不要让同一个概念同时存在 `.toolbarButton`、`.smallButton`、`.legacyAction`、`.referenceToolButton` 等多套样式却长得相似。后续要逐步合并为统一组件变体。
