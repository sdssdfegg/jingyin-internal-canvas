# 2026-08-26 LK888 适配器大图请求体 broken pipe

## 基本信息

- 编号：API-2026-08-26-003
- 首次发现时间：2026-08-26 22:15
- 发现人：用户
- 状态：已修复，待画板真实请求复测
- 等级：P1
- 影响范围：封装版画板、GPT 图片编辑、带图生成、LK888 低价渠道

## 现象

画板报错：

```text
上游生图接口错误：
{"error":{"message":"upstream error: do request failed","type":"new_api_error","code":"do_request_failed"}}
```

对应 Request ID：

```text
202608261415232462949238268d9d65y8DpbcZ
```

## 服务器证据

New API 原始日志：

```text
2026-08-26 22:15:23
do request failed:
Post "http://127.0.0.1:8791/v1/images/edits":
write tcp 127.0.0.1:60274->127.0.0.1:8791: write: broken pipe

channel error (channel #5, status code: 500):
upstream error: do request failed
```

判断：

- 请求命中的是 `channel #5 lk888-gpt-image-2`。
- 失败发生在 New API 写入本机 LK888 适配器阶段。
- 不是画板直接连 LK888 失败，也不是速创、老夜上游返回失败。

## 根因判断

LK888 本地适配器原本限制：

```text
MAX_BODY_BYTES = 40MB
```

封装版画板带图生成/图片编辑时，请求体可能超过 40MB。适配器在 New API 还没写完请求体时提前返回并断开连接，New API 侧就记录成：

```text
write: broken pipe
do_request_failed
```

这类错误会表现得像“上游接口错误”，但实际是中转站内部本地适配器提前断开。

## 修复动作

修改文件：

```text
/opt/jingyin-lk888-gpt-image-adapter/server.py
```

修复内容：

- 默认请求体上限从 `40MB` 提高到 `120MB`。
- 如果超过上限，适配器会先读完并丢弃请求体，再返回 `413 request_body_too_large`，避免 New API 再看到 `broken pipe`。
- 新增适配器诊断日志：
  - `/opt/jingyin-lk888-gpt-image-adapter/adapter.log`
  - 只记录请求体大小、路径、Content-Type、错误类型，不记录 API Key 和提示词正文。

验证：

- 适配器语法检查通过。
- `lk888-gpt-image-adapter.service -> active`
- `new-api-custom.service -> active`
- 使用假 key 小请求测试：适配器能正常读取 prompt 和图片，返回上游认证失败，不扣费。
- 使用本机 45MB 假图片、不带 prompt 测试：适配器完整读完请求体，返回 `400 missing_prompt`，没有再出现 `broken pipe`。

## 后续验证方式

用户用封装版画板重新发起同类带图请求后，检查：

1. 如果成功，说明请求体上限问题已解决。
2. 如果仍失败，查看：
   - `/opt/jingyin-lk888-gpt-image-adapter/adapter.log`
   - `/opt/new-api-custom/logs/oneapi-*.log`
3. 如果出现 `missing_prompt`，说明封装版传来的提示词字段名和适配器预期不一致，需要根据 `adapter.log` 的字段形状补兼容。

## 避免再次发生

- 带图生成不要让本地适配器在未读完请求体时提前断开。
- 所有本地上游适配器都应有明确的请求体上限、错误日志和字段形状日志。
- 封装版画板、源码版画板可能上传体积不同，不能只按源码版测试结果判断线上封装版稳定性。

