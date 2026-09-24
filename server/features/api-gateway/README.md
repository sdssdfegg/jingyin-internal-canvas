# API 网关与中转站链路

这个分区用于记录“本地软件如何调用静音中转站”。当前代码还没有把路由从 `server/index.js` 全部搬进来，本文件先作为故障定位地图。

## 调用链路

```text
前端页面
  -> src/api/*.js
  -> 本地 /api/*
  -> server/index.js resolveApiKey()
  -> server/billing-gateway.js 向中转站准备计费/签发
  -> server/channel.js 组装 OpenAI 风格图片参数
  -> https://api.jingyin.online/v1
  -> 中转站后台选择渠道商/账号/价格/限流
  -> 本地缓存结果图到 data/results
```

## 关键文件

| 文件 | 用途 |
| --- | --- |
| `src/api/client.js` | 前端请求底座 |
| `src/api/images.js` | 普通图片接口 |
| `src/api/outfit.js` | 批量工作流接口 |
| `server/index.js` | 当前后端路由汇总、上传落盘、结果缓存、健康检查 |
| `server/channel-config.js` | 锁定本地只走静音中转站 |
| `server/features/api-gateway/gateway-registry.js` | 本地已接入中转站列表和优先级 |
| `server/features/api-gateway/gateways/*.js` | 一个中转站一个独立模块 |
| `server/channel.js` | 请求格式、模型参数、返回图解析 |
| `server/billing-gateway.js` | 中转站计费/签发任务 |

## 当前本地中转站优先级

| 优先级 | 模块 | baseUrl | 说明 |
| --- | --- | --- | --- |
| 1 | `gateways/jingyin-online.js` | `https://api.jingyin.online/v1` | 当前唯一启用的图片中转站 |

如果只是 `api.jingyin.online` 后台里的多个渠道商，它们不算多个本地中转站；它们的优先级由中转站后台决定，本地源码只看到 `api.jingyin.online` 这个统一入口。

## 本地诊断接口

```text
http://127.0.0.1:8787/api/gateways
http://127.0.0.1:8787/api/gateways/status
```

`/api/gateways` 查看当前接了几个中转站和优先级。  
`/api/gateways/status` 做不带 KEY、不出图、不扣费的连通检查。

注意：无 KEY 检查只能证明域名和服务可达，不能证明某个用户 KEY 有余额、模型权限或渠道商可用。

## 出图慢的定位顺序

1. 看 `http://127.0.0.1:8787/api/health`：本机并发、排队、内存是否异常。
2. 看 `logs/generation.jsonl`：`timing.channelWaitMs` 是中转站/上游等待时间，`timing.totalMs` 是本机全链路时间。
3. 如果本机排队很短但 `channelWaitMs` 很长，优先查中转站渠道队列、限流或上游速度。
4. 如果本机内存持续上涨，优先查上传文件大小、结果图缓存、浏览器页面是否堆积过多任务。
5. 如果大量 401/余额不足，先查用户 KEY、账号余额和中转站授权。
6. 如果看到 `status=404`、`failureReason=channel_route_not_found` 或上游摘要 `openai_error`，优先查中转站里该模型是否支持当前 `/v1/images/edits` 图片编辑路由，以及该工作流的请求格式；这不是本地电脑卡顿。

随机背景的 `nano-banana*` 图生图请求会先走稳定格式 `image_size=2K + aspect_ratio=3:4`。如果中转站快速返回疑似路由/格式 404，本地只会继续尝试 `image_size=1728x2304 + aspect_ratio=3:4` 和 `size=1728x2304` 两个兼容格式；日志会记录 `requestVariant`、`requestFormat`、`promptChars`、`promptBytes`，不记录 KEY、完整提示词或图片内容。

## 未来拆分目标

```text
server/features/api-gateway/
  gateway-registry.js
  gateways/
    jingyin-online.js
    <第二个中转站>.js
  image-routes.js
  video-routes.js
  billing-service.js
  result-cache.js
  upload-storage.js
  generation-log.js
```

拆分时保持接口路径不变，外部页面仍然只调用 `/api/images`、`/api/generate-outfit` 等本地接口。
