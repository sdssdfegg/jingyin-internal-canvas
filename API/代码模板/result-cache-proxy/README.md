# 结果图缓存代理

这是给 `api.jingyin.online` 准备的独立旁路服务，用来解决上游结果图临时 URL 被客户网络限流的问题。

它不替代 New API，也不要求画板理解每个上游的图片 URL。中转站或网关拿到上游结果图 URL 后，把 URL 注册到本服务，本服务返回一个稳定的 `/result-cache/{cache_id}` 地址。

## 功能

- 一键开启 / 关闭结果图缓存。
- 开启时后台下载上游结果图并落盘。
- 关闭时直接回传上游原始 URL。
- 支持 HTTP Range，方便大图分片下载和断点续传。
- 磁盘达到 50% 水位时自动删除旧图，建议降到 45% 停止。
- 按保留时间删除旧缓存。
- 只允许白名单域名，避免被滥用成开放代理。

## 部署位置

建议目录：

```text
/opt/jingyin-result-cache
```

缓存目录：

```text
/www/wwwroot/jingyin-result-cache/files
/www/wwwroot/jingyin-result-cache/data
```

## 启动前配置

1. 复制配置：

```bash
cp config.example.json config.json
cp .env.example .env
```

2. 修改 `.env`，填写两个长随机 token：

```bash
RESULT_CACHE_ADMIN_TOKEN=...
RESULT_CACHE_INTERNAL_TOKEN=...
```

3. 根据实际上游结果图域名补充 `config.json` 的 `allowedHostPatterns`。

## 运行

```bash
node /opt/jingyin-result-cache/server.mjs
```

生产建议用 systemd：

```bash
cp systemd/jingyin-result-cache.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jingyin-result-cache
systemctl status jingyin-result-cache
```

## Nginx

把 `nginx/result-cache-location.conf` 里面的内容加入 `api.jingyin.online` 对应的 Nginx server block。

验证：

```bash
nginx -t
systemctl reload nginx
```

## API

注册结果图：

```bash
curl -X POST http://127.0.0.1:8787/cache/register \
  -H "Authorization: Bearer $RESULT_CACHE_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/result.png","task_id":"task1","file_id":"0"}'
```

开启缓存：

```bash
curl -X POST http://127.0.0.1:8787/admin/toggle \
  -H "Authorization: Bearer $RESULT_CACHE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

关闭缓存：

```bash
curl -X POST http://127.0.0.1:8787/admin/toggle \
  -H "Authorization: Bearer $RESULT_CACHE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

状态：

```bash
curl http://127.0.0.1:8787/health
```

## 集成方式

中转站收到上游结果后：

1. 找出 JSON 中的图片 URL。
2. 调用 `/cache/register`。
3. 如果返回 `cache_status=bypassed`，继续使用上游 URL。
4. 如果返回缓存 URL，把缓存 URL 返回给画板。

参考 `gateway-integration.mjs`。

## 注意

- 不要把 `/cache/register` 暴露给普通用户调用。
- `/result-cache/{cache_id}` 可以公开给画板下载。
- 不要默认全量开启，当前服务器更适合应急开启。
- 不做图片压缩，优先保证客户拿到原质量结果图。
