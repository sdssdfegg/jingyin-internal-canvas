# LK888 GPT Image Adapter

这个适配器用于解决：

```text
画板 -> 静音中转站/New API -> LK888
```

链路中 `2K + 比例` 参数没有被转换成 LK888 专用 `params.size`，导致 2K 变 1K 或请求不稳定的问题。

## 它做什么

对 New API 来说，它像一个 OpenAI 图片接口：

```text
POST /v1/images/generations
POST /v1/images/edits
GET  /v1/models
```

对 LK888 来说，它会转换成：

```text
POST /v1/media/generate
GET  /v1/media/status?task_id=...
```

并把画板参数转换成 LK888 需要的结构：

```json
{
  "model": "tt-image-2",
  "prompt": "...",
  "params": {
    "size": "1728x2304",
    "images": []
  }
}
```

## 尺寸规则

当前按画板源码里已经验证通过的规则换算：

| 画板选择 | 比例 | 转给 LK888 |
|---|---:|---:|
| `1K` | `1:1` | `1024x1024` |
| `2K` | `1:1` | `2304x2304` |
| `2K` | `3:4` | `1728x2304` |
| `2K` | `4:3` | `2304x1728` |
| `2K` | `9:16` | `1296x2304` |
| `2K` | `16:9` | `2304x1296` |
| `4K` | `1:1` | `4096x4096` |

如果请求里已经带了精确像素 `size=宽x高`，适配器会优先使用该值。

## 部署

```bash
cd /opt/jingyin-lk888-gpt-image-adapter
PORT=8791 HOST=127.0.0.1 python3 server.py
```

建议用 `systemd` 或宝塔/雨云进程守护运行。

如果服务器已有 Node 20+，也可以用 Node 版入口：

```bash
cd /opt/jingyin-lk888-gpt-image-adapter
npm install
PORT=8791 HOST=127.0.0.1 npm start
```

环境变量：

```text
PORT=8791
HOST=127.0.0.1
LK888_BASE_URL=https://api.lk888.ai
LK888_MODEL=tt-image-2
LK888_API_KEY=
MAX_BODY_BYTES=41943040
MAX_INPUT_IMAGES=4
MAX_N=1
LK888_POLL_TIMEOUT_MS=600000
LK888_POLL_INTERVAL_MS=3000
```

`LK888_API_KEY` 可以不填。为空时，适配器会使用 New API 转发来的 `Authorization: Bearer ...` 作为 LK888 上游 key。这样 New API 渠道密钥仍填 LK888 原 key。

## New API 渠道设置

编辑 `lk888-gpt-image-2` 渠道：

```text
类型：OpenAI
API地址：http://127.0.0.1:8791
模型：gpt-image, gpt-image-2
模型重定向：可以保留 gpt-image -> gpt-image-2
参数覆盖：不更改
透传请求体：开启
默认测试模型：gpt-image-2
```

注意：

- `API地址` 不要带 `/v1`。
- 不要在参数覆盖里写死 `size=1728x2304`，否则用户选择 1K/2K/4K 会失效。
- 如果 New API 在 Docker 容器里，`127.0.0.1` 可能指向容器内部，需要改成同 Docker 网络里的适配器服务名，或宿主机可访问地址。

## 验证方式

先不要点 New API 后台的图片渠道测试，避免误扣费。

推荐让画板发一张你明确允许的 2K 小样，然后只看日志：

```text
画板入参：image_size=2K, aspect_ratio=3:4
适配器转发：params.size=1728x2304
LK888 接口：/v1/media/generate
轮询接口：/v1/media/status
返回格式：OpenAI data[0].url
```

如果返回图片仍是 1K：

```text
入参 2K -> params.size 正确 -> 结果 1K
```

则是 LK888 上游模型本身降采样，需要换 `tt-image-2-token` 或其他稳定高清渠道。

如果适配器日志里 `params.size` 不是预期值：

```text
入参 2K -> params.size 错误
```

则继续查 New API 是否没有开启请求体透传，或画板传参字段被过滤。
