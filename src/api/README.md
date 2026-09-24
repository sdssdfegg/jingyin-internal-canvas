# src/api API 调用层

这个目录是前端唯一 API 调用层。页面组件不要直接散写 `fetch("/api/...")`，应该先在这里建一个薄封装，再由页面调用。

## 文件分工

| 文件 | 负责接口 | 说明 |
| --- | --- | --- |
| `client.js` | 所有请求底座 | `ApiError`、`apiJson`、`postJson`、`postForm`，统一 JSON/FormData 提交、错误读取和本机 requestId |
| `config.js` | `/api/config` | 读取模型、渠道策略、是否已有服务器 KEY |
| `images.js` | `/api/images` | 快捷生成、参考生图、详情分段、批量页内快捷生图共用 |
| `outfit.js` | `/api/generate-outfit`、`/api/outfit-master-fit-analysis`、`/api/outfit-quality-check` | 批量换装/姿态/背景/改色/白底/换脸/设计稿主链路 |
| `videos.js` | `/api/videos/generations`、`/api/videos/status` | 视频提交和轮询 |
| `prompts.js` | `/api/quick-prompt-rewrite`、`/api/reference-prompt-rewrite`、`/api/detail-prompts` | 提示词重写和详情提示词生成 |
| `save.js` | 保存目录相关接口 | 读取、设置、选择、打开保存目录 |
| `history.js` | `/api/history` | 历史记录读取、保存、删除、清空 |
| `assets.js` | `/api/image-proxy`、`/api/canvas-assets` | 图片代理读取和画布素材上传 |
| `debug.js` | `/api/debug/image-request-params` | 传参自检，不调用上游、不扣费 |

## 维护规则

1. 新增接口先改 `client.js` 或对应业务文件，不要在页面里直接写请求细节。
2. JSON 请求用 `postJson()`，图片/文件上传用 `postForm()`。
3. `ApiError` 会带 `status`、`payload`、`url`、`method`、`requestId`，排查接口时优先看这些字段。
4. API Key 不在这里硬编码；页面只把用户 KEY 放进请求体，本地服务再交给中转站。
5. 错误文案需要统一时，先看 `client.js` 和调用方的错误归一函数。
6. API 返回结构一旦变更，要同步检查 `server/index.js` 对应路由。

## API 出问题时发给 Codex

优先发这些小文件：

```text
V11维护文档/04-API调用与登录系统地图.md
src/api/README.md
src/api/client.js
src/api/<出问题的接口文件>.js
server/features/api-gateway/README.md
```

如果是具体生成慢或失败，再附：

```text
logs/generation.jsonl 里本次 requestId 对应的 5-20 行
http://127.0.0.1:8787/api/health 的返回
```
