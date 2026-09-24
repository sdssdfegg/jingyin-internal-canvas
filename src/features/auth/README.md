# 前端登录/KEY 授权分区

V11 当前没有做本地账号密码登录；真正的账号、渠道商、余额、上游 KEY 都在静音中转站。本地软件只保存和提交“用户自己的静音中转站 KEY”。

## 当前文件

| 文件 | 作用 |
| --- | --- |
| `api-key.js` | 清洗用户输入的 KEY，识别 401/KEY 无效类错误 |
| `src/main.jsx` | 主画板设置弹窗，目前仍渲染 KEY 输入和皮肤设置 |
| `src/outfit-workflow.jsx` | 批量画板独立运行时的设置弹窗；嵌入主画板时用主画板 KEY |
| `src/shared/ui/README.md` | 后续 `SettingsModal.jsx` 的共享组件规划 |

## 边界

1. 这里放“本地 KEY 输入、清洗、鉴权错误识别、设置弹窗逻辑”。
2. 不在这里放渠道商 KEY、上游地址、价格或账号密码。
3. 中转站登录后台由 `https://api.jingyin.online/` 管，不进入本地源码。
4. 如果后续真的要做账号密码登录，应新建登录接口和会话，不要混进图片生成接口。

## 后续目标

```text
src/features/auth/
  api-key.js
  auth-state.js
  AuthSettingsModal.jsx

src/shared/ui/
  SettingsModal.jsx
```

主画板和批量画板共用同一个设置弹窗，避免保存 KEY、显示/隐藏、错误提示出现两套逻辑。

## KEY 问题时发给 Codex

```text
V11维护文档/04-API调用与登录系统地图.md
src/features/auth/api-key.js
src/features/auth/README.md
src/main.jsx 里设置弹窗附近代码
src/outfit-workflow.jsx 里设置弹窗附近代码
```
