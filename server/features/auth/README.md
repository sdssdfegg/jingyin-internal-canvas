# 后端 KEY 授权分区

这里放本地服务端和用户 KEY 相关的轻量工具。V11 的后端不保存渠道商 KEY，不内置上游私钥。

## 当前文件

| 文件 | 作用 |
| --- | --- |
| `api-key.js` | 清洗请求体里的 `apiKey`，去掉 `Bearer`、引号、空格和不可见字符 |
| `server/index.js` | `resolveApiKey()` 统一调用这里的清洗函数 |
| `server/channel-config.js` | 把用户 KEY 变成 `Authorization: Bearer ...`，不写死上游 KEY |

## 规则

1. 前端传来的 KEY 只作为用户中转站 KEY 使用。
2. 渠道商账号、渠道优先级、备用渠道和真实上游 KEY 留在中转站后台。
3. 不在 `.js` 源码里写真实 KEY，也不写到日志。
4. 401/余额/限流类问题优先看中转站后台和 `logs/generation.jsonl` 的 requestId。
