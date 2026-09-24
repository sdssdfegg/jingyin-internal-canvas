# 中转站调用模块

这里遵守“一站一文件”的规则：有几个 API 中转站，就建几个独立调用配置文件，不把多个中转站混在一个大配置里。

## 当前已接入

| 文件 | 中转站 | 优先级 | 状态 |
| --- | --- | --- | --- |
| `jingyin-online.js` | `https://api.jingyin.online/v1` | 1 | 当前唯一启用的图片中转站 |

## 新增中转站规则

1. 新建独立文件，例如 `backup-a.js`，不要把地址塞进 `jingyin-online.js`。
2. 在 `gateway-registry.js` 里按优先级加入 `API_GATEWAY_MODULES`。
3. 每个模块写清楚 `id`、`label`、`priority`、`defaultBaseUrl`、环境变量名。
4. 不要在模块里写渠道商 KEY 或用户 KEY。
5. 如果只是 `api.jingyin.online` 后台里的渠道商，不需要在本地新增文件；那属于中转站后台路由。

## 模块模板

```js
export const BACKUP_GATEWAY = Object.freeze({
  id: "backup-gateway",
  label: "备用中转站",
  role: "fallback",
  priority: 2,
  baseUrlEnvNames: ["JINGYIN_BACKUP_GATEWAY_BASE_URL"],
  defaultBaseUrl: "https://example.com/v1",
  public: false,
  billingMode: "gateway",
  billingChannelId: "backup-gateway",
  upstreamApiKey: "",
  modelAliases: {}
});
```

`priority` 数字越小越靠前。第一优先级失败时，本地才会尝试后面的备用中转站。
