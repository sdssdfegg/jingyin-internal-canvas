# server/features 目录

这里放后端功能服务。目标是把现在 `server/index.js` 里的大路由逐步拆出来，但每次只拆一个功能。

目标结构示例：

```text
server/features/
  auth/
    api-key.js
  api-gateway/
    README.md
  quickgen/
    quickgen-routes.js
    quickgen-service.js
  outfit/
    outfit-routes.js
    outfit-service.js
    outfit-upload.js
  reference-remix/
  detail-main/
  image-editor/
  resize-export/
  prompt-library/
  video/
```

## 对应关系

| 前端目录 | 后端目录 | 提示词/SKILL |
| --- | --- | --- |
| `src/features/quickgen/` | `server/features/quickgen/` | `prompts/frontend/quickgen-prompts.js`、`server/quick-prompt-ai.js` |
| `src/features/outfit/` | `server/features/outfit/` | `prompts/server/outfit-skill.js` |
| `src/features/reference-remix/` | `server/features/reference-remix/` | `server/reference-ai.js` |
| `src/features/detail-main/` | `server/features/detail-main/` | `prompts/server/detail-skills.js`、`server/detail-*` |
| `src/features/video/` | `server/features/video/` | `server/video-config.js` |
| `src/features/auth/` | `server/features/auth/` | 不涉及提示词 |
| `src/api/` | `server/features/api-gateway/` | 不涉及提示词 |

## 不应该放在功能目录里的内容

- 网关配置、模型路由、KEY 策略：当前放 `server/channel-config.js`、`server/channel.js`，地图放 `server/features/api-gateway/README.md`。
- 计费/签发：放 `server/billing-gateway.js`。
- 上传临时文件、结果缓存、日志等多接口共用能力：后续放 `server/shared/`。
- 最终生图 SKILL：放 `prompts/server/`。

判断方法：如果一个后端工具被两个以上接口使用，它应进入 `server/shared/`；如果只服务一个功能，才进入 `server/features/<功能名>/`。
