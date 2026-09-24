# 中转站代码模板说明

> 2026-08-25 修正：这些是早期模板，只保留为参考。新的接入方向以 `..\中转站重构规划-2026-08-25.md` 和 `..\渠道能力表-2026-08-25.md` 为准。LK888 与 7LAI 不应直接套用旧的通用 OpenAI 图片模板。

这些文件是以后你把中转站源码化、二开或重构时参考的结构。

核心目标：

- 画板永远只调用 `https://api.jingyin.online/`。
- 每个上游 API 独立一个文件。
- 每个上游只负责自己的参数转换、鉴权、错误归因。
- 统一路由层只负责选择渠道、重试、熔断、返回标准错误。
- 每次错误都能落到“哪个模型、哪个上游、哪个文件、什么原因”。

推荐结构：

```text
src/
  gateway/
    failover-router.ts
    error-normalizer.ts
    issue-recorder.ts
  upstreams/
    upstream-base.ts
    laoye-openai.ts
    lk888-gpt-image.ts
    code28-gpt-image.ts
    lanlanda-seedance-video.ts
  config/
    upstreams.example.json
```

当前目录中的模板：

- `upstream-base.ts`：统一上游接口定义。
- `failover-router.ts`：按优先级、权重、健康状态选择上游。
- `error-normalizer.ts`：把上游乱七八糟的错误统一成画板能理解的格式。
- `issue-recorder.ts`：把每次故障沉淀成问题记录。
- `upstreams/*.ts`：每个上游一个文件的写法示例。
- `upstreams.example.json`：优先级、权重、模型映射配置示例。
- `lk888-gpt-image-adapter/`：可部署的 LK888 GPT 图片适配器，把 New API 的 OpenAI 图片请求转换成 LK888 `/v1/media/generate` 异步请求。
- `jingyin-lk888-gpt-image-adapter.zip`：上述适配器的压缩包，方便上传到中转站服务器。
