# API 调用与登录系统地图

这份文档专门用于 API、KEY、登录授权、生成慢、401、413、接口错误排查。

## 当前架构结论

1. API 调用应该集中在 `src/api/`，页面只调用业务封装。
2. 登录系统当前是“用户 KEY 授权层”，不是本地账号密码系统。
3. 本地只走静音中转站：`https://api.jingyin.online/v1`。
4. 渠道商账号、上游 KEY、渠道优先级、价格、限流和备用渠道不进入本地源码。

## 前端 API 文件

```text
src/api/client.js      请求底座
src/api/images.js      /api/images
src/api/outfit.js      /api/generate-outfit 和批量辅助接口
src/api/videos.js      视频提交/轮询
src/api/prompts.js     提示词重写/详情提示词
src/api/config.js      配置读取
src/api/save.js        保存目录
src/api/history.js     历史记录
src/api/assets.js      图片代理/画布素材
src/api/debug.js       传参自检
```

## 登录/KEY 文件

```text
src/features/auth/api-key.js       前端 KEY 清洗、鉴权错误识别
server/features/auth/api-key.js    后端 KEY 清洗
src/features/auth/README.md        前端授权分区说明
server/features/auth/README.md     后端授权分区说明
```

当前设置弹窗还在：

```text
src/main.jsx
src/outfit-workflow.jsx
```

后续目标是抽到共享设置弹窗，避免主画板和批量画板两套 KEY UI 不同步。

## 中转站链路

```text
src/api/*.js
  -> 本地 /api/*
  -> server/index.js
  -> server/billing-gateway.js
  -> server/channel.js
  -> https://api.jingyin.online/v1
```

详细看：

```text
server/features/api-gateway/README.md
server/features/api-gateway/gateways/README.md
```

## 当前本地中转站优先级

当前 V11 源码只接入 1 个本地 API 中转站：

```text
1. jingyin-gateway -> https://api.jingyin.online/v1
```

如果中转站后台里配置了多个渠道商，本地源码看不到这些渠道商的内部优先级；那部分要在 `https://api.jingyin.online/` 后台或后台日志里看。

本地可看：

```text
http://127.0.0.1:8787/api/gateways
http://127.0.0.1:8787/api/gateways/status
```

## 不同问题发哪些文件

| 问题 | 优先发 |
| --- | --- |
| 401、KEY 无效、保存 KEY 后仍失败 | 本文件、`src/features/auth/api-key.js`、`server/features/auth/api-key.js`、相关错误截图 |
| 某个接口报错 | 本文件、`src/api/client.js`、`src/api/<接口>.js`、`server/features/api-gateway/README.md` |
| 生图慢、多人同时慢 | 本文件、`README.md` 健康检查说明、`logs/generation.jsonl` 对应 requestId、`/api/health` 返回 |
| 查当前中转站优先级/是否可达 | 本文件、`/api/gateways`、`/api/gateways/status` |
| 413 或上传太大 | 本文件、`src/api/images.js` 或 `src/api/outfit.js`、`server/index.js` 上传路由附近日志 |
| 传参怀疑不对 | 本文件、`src/api/debug.js`、传参自检报告 |

不要一次性发 `server/index.js` 全文、`src/outfit-workflow.jsx` 全文或整份日志。
