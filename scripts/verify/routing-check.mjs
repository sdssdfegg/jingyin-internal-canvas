// 渠道 / 模型目录静态 + 接口输出检查（不调用任何付费生图接口）。
//
// 覆盖验收项：
//   1. 接口和 DOM 中旧渠道 ID / 旧渠道名称数量为 0
//   2. 香蕉 2 只有 Subdirect 和云枢
//   3. 香蕉 Pro 只有 Subdirect 和 Origin
//   4. 旧 nano-banana2 存档最终发出 banana-2
//   5. 非法 channelId 被服务端拒绝
//   6. 模型切换后图片数量 / 文件大小 / 提示词长度 / 比例正确收敛
//
// 用法：node scripts/verify/routing-check.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
let failures = 0;
const lines = [];

function check(name, ok, detail = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

const FORBIDDEN_TOKENS = [
  "WD-banana pro-特价",
  "MC-限时特惠",
  "XBS-default",
  // 2026-09-25：TT Image 2（2.0）的 WD-image特价 下线
  "WD-image特价"
];
const FORBIDDEN_IDS = [
  "silent-pro-line-03",
  "silent-banana-line-01",
  "silent-tt2-line-08",
  "silent-tt2-line-04"
];

// ---------------------------------------------------------------- 静态扫描
const scanned = [
  "src/main.jsx",
  "src/outfit-workflow.jsx",
  "src/shared/routing.js",
  "src/shared/models.js",
  "src/shared/quickgen-prompt-rules.js",
  "server/channel-config.js",
  "server/channel.js",
  "server/index.js"
];

const DENY_LIST_FILES = {
  "server/channel-config.js": "export const FORBIDDEN_CHANNEL_IDS",
  "src/shared/routing.js": "export const FORBIDDEN_CHANNEL_IDS"
};

for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  for (const file of scanned) {
    const text = read(file);
    const count = text.split(token).length - 1;
    if (count === 0) continue;
    const denyMarker = DENY_LIST_FILES[file];
    if (denyMarker) {
      // 前后端都必须保留拒绝名单，但只允许出现在 FORBIDDEN_CHANNEL_IDS 声明块里。
      const listStart = text.indexOf(denyMarker);
      const listEnd = text.indexOf("]);", listStart);
      const outside = text.slice(0, listStart) + text.slice(listEnd);
      check(`旧渠道 token 只出现在拒绝名单 ${file} ${token}`, !outside.includes(token));
      continue;
    }
    check(`旧渠道 token 不得出现在 ${file} :: ${token}`, false, `出现 ${count} 次`);
  }
}

// 目录里绝不能有旧线路
const channelConfig = read("server/channel-config.js");
const routingChannelsBlock = channelConfig.slice(
  channelConfig.indexOf("const ROUTING_CHANNELS"),
  channelConfig.indexOf("export const ROUTING_MODELS")
);
for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  check(`ROUTING_CHANNELS 目录里没有 ${token}`, !routingChannelsBlock.includes(token));
}

// ---------------------------------------------------------------- 接口输出
const channelConfigModule = await import(new URL("../../server/channel-config.js", import.meta.url));
const channelModule = await import(new URL("../../server/channel.js", import.meta.url));
const routingModule = await import(new URL("../../src/shared/routing.js", import.meta.url));

const catalog = channelConfigModule.publicRoutingCatalog();
const catalogJson = JSON.stringify(catalog);
for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  check(`/api/routing 输出不含旧渠道 ${token}`, !catalogJson.includes(token));
}

const publicModels = channelConfigModule.publicChannelModels();
const publicModelsJson = JSON.stringify(publicModels);
for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  check(`/api/config models 输出不含旧渠道 ${token}`, !publicModelsJson.includes(token));
}

// DOM 侧：快捷悬浮框线路菜单的数据源 = channelsForModel(model, catalog)
const domChannelSources = JSON.parse(JSON.stringify({
  "banana-2": routingModule.channelsForModel("banana-2", catalog),
  "nano-banana-pro": routingModule.channelsForModel("nano-banana-pro", catalog),
  "tt-image-2": routingModule.channelsForModel("tt-image-2", catalog),
  "tt-image-2.5": routingModule.channelsForModel("tt-image-2.5", catalog)
}));
const domJson = JSON.stringify(domChannelSources);
for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  check(`前端线路菜单数据源不含旧渠道 ${token}`, !domJson.includes(token));
}

// JSX 硬编码：快捷生成线路菜单只渲染 channelsForModel 的结果，不该写死渠道名
const mainJsx = read("src/main.jsx");
const quickCluster = mainJsx.slice(
  mainJsx.indexOf("quickToolCluster"),
  mainJsx.indexOf("skillToggleButton")
);
for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  check(`快捷悬浮框 JSX 不含旧渠道 ${token}`, !quickCluster.includes(token));
}

// ---------------------------------------------------------------- 线路白名单
const bananaChannels = routingModule.channelsForModel("banana-2", catalog);
check(
  "香蕉 2 只有 Subdirect 和云枢",
  bananaChannels.length === 2
    && bananaChannels[0].id === "silent-banana-line-08"
    && bananaChannels[0].label === "Subdirect"
    && bananaChannels[1].id === "silent-banana-line-07"
    && bananaChannels[1].label === "云枢",
  JSON.stringify(bananaChannels.map((item) => [item.id, item.label, item.price]))
);

const proChannels = routingModule.channelsForModel("nano-banana-pro", catalog);
check(
  "香蕉 Pro 只有 Subdirect 和 Origin",
  proChannels.length === 2
    && proChannels[0].id === "silent-pro-line-10"
    && proChannels[0].label === "Subdirect"
    && proChannels[1].id === "silent-pro-line-09"
    && proChannels[1].label === "Origin",
  JSON.stringify(proChannels.map((item) => [item.id, item.label, item.price]))
);

// ---------------------------------------------------------------- 旧存档模型映射
const legacyNormalized = channelModule.normalizeImageRequest({ model: "nano-banana2", prompt: "x" });
check("旧存档 nano-banana2 归一化为 banana-2（服务端）", legacyNormalized.model === "banana-2", legacyNormalized.model);
check("旧存档 nano-banana2 归一化为 banana-2（前端）", routingModule.canonicalModel("nano-banana2") === "banana-2");
check("旧存档 gpt-image 归一化为 tt-image-2", routingModule.canonicalModel("gpt-image") === "tt-image-2");

// 旧存档线路归一化：即使存档里带旧 channelId，routingFields 也不会把它发出去
const routedLegacy = routingModule.routingFields("nano-banana2", "XBS-default", catalog);
check(
  "旧 channelId 不会进入新请求",
  routedLegacy.model === "banana-2"
    && routedLegacy.channelId === "silent-banana-line-08"
    && routedLegacy.dispatchMode === "manual",
  JSON.stringify(routedLegacy)
);

// ---------------------------------------------------------------- 服务端拒绝非法 channelId
const BAD_CHANNEL_CASES = [
  ...FORBIDDEN_TOKENS,
  ...FORBIDDEN_IDS,
  "not-a-real-line",
  ""
];
for (const bad of BAD_CHANNEL_CASES) {
  const params = channelModule.normalizeImageRequest({
    model: "banana-2",
    channelId: bad,
    prompt: "x",
    imageSize: "2K",
    aspectRatio: "3:4"
  });
  const result = channelModule.validateImageRouting(params);
  check(`服务端拒绝非法 channelId “${bad || "(空)"}”`, result.ok === false, result.code);
}

// 跨模型 channelId 也要拒绝
const crossModel = channelModule.normalizeImageRequest({
  model: "banana-2",
  channelId: "silent-pro-line-10",
  prompt: "x"
});
check("服务端拒绝跨模型 channelId", channelModule.validateImageRouting(crossModel).ok === false);

// 合法 channelId 必须通过
const goodParams = channelModule.normalizeImageRequest({
  model: "nano-banana-pro",
  channelId: "silent-pro-line-09",
  prompt: "x",
  imageSize: "4K",
  aspectRatio: "16:9"
});
check("合法 channelId 通过校验", channelModule.validateImageRouting(goodParams).ok === true);

// ---------------------------------------------------------------- 2.0 / 2.5 渠道可用性（2026-09-25）
// 2.0（TT Image 2）：WD-image特价 下线 → 目录里没有，服务端也拒绝
const tt2Channels = routingModule.channelsForModel("tt-image-2", catalog);
check("2.0 目录里已无 WD-image特价",
  !tt2Channels.some((item) => item.id === "silent-tt2-line-04")
    && !tt2Channels.some((item) => item.label === "WD-image特价"),
  JSON.stringify(tt2Channels.map((item) => item.label)));
const tt2RemovedParams = channelModule.normalizeImageRequest({
  model: "tt-image-2", channelId: "silent-tt2-line-04", prompt: "x", imageSize: "2K", aspectRatio: "3:4"
});
const tt2RemovedResult = channelModule.validateImageRouting(tt2RemovedParams);
check("2.0 用已下线的 WD-image特价 请求被服务端拒绝",
  tt2RemovedResult.ok === false, tt2RemovedResult.code);

// 2.5（TT Image 2.5）：XT-image2-s 与 XT-特殊分组 要能显示、也能通过服务端校验
const tt25Channels = routingModule.channelsForModel("tt-image-2.5", catalog);
for (const [id, label] of [["silent-tt25-line-01", "XT-image2-s"], ["silent-tt25-line-02", "XT-特殊分组"]]) {
  const found = tt25Channels.find((item) => item.id === id);
  check(`2.5 目录里显示 ${label}`,
    Boolean(found) && found.label === label,
    JSON.stringify(found || null));
  const params = channelModule.normalizeImageRequest({
    model: "tt-image-2.5", channelId: id, prompt: "x", imageSize: "2K", aspectRatio: "3:4"
  });
  const result2 = channelModule.validateImageRouting(params);
  check(`2.5 的 ${label} 通过服务端路由校验`, result2.ok === true, result2.code);
}

// 老存档里选着已下线渠道时，必须能自动收敛到合法线路
const legacyTt2 = routingModule.convergeSettingsForModel({ model: "tt-image-2", channelId: "silent-tt2-line-04" }, catalog);
check("老存档选了已下线渠道 → 自动收敛到合法线路",
  legacyTt2.channelId !== "silent-tt2-line-04"
    && routingModule.channelsForModel("tt-image-2", catalog).some((item) => item.id === legacyTt2.channelId),
  `channelId=${legacyTt2.channelId}`);

// ---------------------------------------------------------------- 能力收敛
const fakeCatalog = {
  models: catalog.models,
  channels: catalog.channels
};

const fromPro = routingModule.convergeSettingsForModel({
  model: "nano-banana-pro",
  aspectRatio: "21:9",
  imageSize: "4K",
  n: 14,
  channelId: "silent-pro-line-09",
  quality: "high"
}, fakeCatalog);
check(
  "Pro 能力：14 张 / 4K / 21:9 保留",
  fromPro.n === 14 && fromPro.imageSize === "4K" && fromPro.aspectRatio === "21:9",
  JSON.stringify(fromPro)
);

// 切到 tt-image-2.5：21:9 保留（它在 2.5 的比例表里），4K 保留，但数量上限收敛到 8，
// quality=high 保留；渠道必须收敛到 2.5 的合法线路。
const toTt25 = routingModule.convergeSettingsForModel({
  ...fromPro,
  model: "tt-image-2.5"
}, fakeCatalog);
check(
  "切到 tt-image-2.5：数量收敛到 8 且渠道换到合法线路",
  toTt25.n === 8
    && toTt25.channelId === "silent-tt25-line-01"
    && routingModule.channelsForModel("tt-image-2.5", fakeCatalog).some((item) => item.id === toTt25.channelId),
  JSON.stringify(toTt25)
);

// 切到 nano-banana-pro：21:9 允许；再切回 banana-2 时 21:9 / 4K 必须收敛掉
const toPro = routingModule.convergeSettingsForModel({ ...toTt25, model: "nano-banana-pro" }, fakeCatalog);
const backToBanana = routingModule.convergeSettingsForModel({
  ...toPro,
  model: "nano-banana2",
  aspectRatio: "21:9",
  imageSize: "4K",
  n: 14
}, fakeCatalog);
check(
  "切到香蕉 2：比例/尺寸收敛到目录允许值",
  backToBanana.model === "banana-2"
    && backToBanana.aspectRatio === "1:1"
    && backToBanana.imageSize === "2K",
  JSON.stringify({
    model: backToBanana.model,
    aspectRatio: backToBanana.aspectRatio,
    imageSize: backToBanana.imageSize,
    channelId: backToBanana.channelId
  })
);
check(
  "切到香蕉 2：图片数量上限收敛到 14",
  backToBanana.n === 14 && routingModule.modelCapabilities("banana-2", fakeCatalog).maxInputImages === 14
);
check(
  "tt-image-2.5 图片数量上限是 8",
  routingModule.modelCapabilities("tt-image-2.5", fakeCatalog).maxInputImages === 8
);
check(
  "提示词长度来自 capabilities",
  routingModule.modelCapabilities("banana-2", fakeCatalog).maxPromptLength === 20000
    && routingModule.modelCapabilities("banana-2", fakeCatalog).maxImageBytes > 0
);

// 提示词截断
const longPrompt = "甲".repeat(20050);
const clamped = routingModule.clampPromptForModel(longPrompt, "banana-2", fakeCatalog);
check(
  "超长提示词按 capabilities 截断",
  clamped.truncated === true && clamped.prompt.length === 20000,
  `len=${clamped.prompt.length}`
);

// 服务端能力校验：图片数量 / 单张大小 / 提示词长度 / 比例 / 尺寸 / 质量 / 背景
const capacityChecks = [
  ["too_many_images", { model: "tt-image-2.5", imageCount: 9 }],
  ["image_too_large", { model: "banana-2", files: [{ originalname: "big.png", size: 20 * 1024 * 1024 }] }],
  ["prompt_too_long", { model: "banana-2", prompt: "甲".repeat(20001) }],
  ["unsupported_aspect_ratio", { model: "banana-2", aspectRatio: "21:9" }],
  ["unsupported_image_size", { model: "banana-2", imageSize: "4K" }],
  ["unsupported_background", { model: "banana-2", background: "transparent" }],
  ["unsupported_quality", { model: "banana-2", quality: "xhigh" }]
];
for (const [expectedCode, input] of capacityChecks) {
  const result = channelConfigModule.validateModelCapabilities(input.model, input);
  check(`服务端能力校验拒绝 ${expectedCode}`, result.ok === false && result.code === expectedCode, result.code || "ok");
}
check(
  "服务端能力校验放行合法参数",
  channelConfigModule.validateModelCapabilities("banana-2", {
    imageSize: "2K",
    aspectRatio: "3:4",
    quality: "high",
    prompt: "正常长度",
    imageCount: 2,
    files: [{ size: 1024 }]
  }).ok === true
);

// 请求字段：与 3.0 一致，只有 tt-image-2.5 默认带 version/quality/background
const tt25Body = channelModule.buildTextImageBody(
  channelModule.normalizeImageRequest({ model: "tt-image-2.5", channelId: "silent-tt25-line-01", prompt: "x", imageSize: "2K", aspectRatio: "3:4" }),
  "legacy"
);
check(
  "tt-image-2.5 请求带 version/quality/background",
  tt25Body.version === "flare" && tt25Body.quality === "auto" && tt25Body.background === "opaque",
  JSON.stringify({ version: tt25Body.version, quality: tt25Body.quality, background: tt25Body.background })
);

const bananaBody = channelModule.buildTextImageBody(
  channelModule.normalizeImageRequest({ model: "banana-2", channelId: "silent-banana-line-08", prompt: "x", imageSize: "2K", aspectRatio: "3:4" }),
  "legacy"
);
check(
  "banana-2 请求不带不被支持的 version/background",
  bananaBody.version === undefined && bananaBody.background === undefined,
  JSON.stringify(bananaBody)
);

const proBody = channelModule.buildTextImageBody(
  channelModule.normalizeImageRequest({ model: "nano-banana-pro", channelId: "silent-pro-line-09", prompt: "x", imageSize: "4K", aspectRatio: "16:9" }),
  "legacy"
);
check(
  "nano-banana-pro 请求带 canonical model + 允许的比例/尺寸",
  proBody.model === "nano-banana-pro" && proBody.aspect_ratio === "16:9" && proBody.image_size === "4K",
  JSON.stringify({ model: proBody.model, aspect_ratio: proBody.aspect_ratio, image_size: proBody.image_size })
);

// ---------------------------------------------- 上游请求必须带线路路由字段
// 修复背景（logs/generation.jsonl 实测）：V11 原来发往中转站的请求体里没有
// dispatchMode / channelId / manualModel，于是"只有 manual 模式"的 nano-banana-pro
// 稳定返回 400 manual_channel_required；banana-2 / tt-image-2 因为目录里还有
// price_first 才被上游兜底成 200。3.0 的 main.py:13404-13423 对所有模型都会带上这些字段。
const ROUTE_FIELD_CASES = [
  ["nano-banana-pro", "silent-pro-line-10"],
  ["nano-banana-pro", "silent-pro-line-09"],
  ["banana-2", "silent-banana-line-08"],
  ["banana-2", "silent-banana-line-07"],
  ["tt-image-2", "silent-tt2-line-10"],
  ["tt-image-2.5", "silent-tt25-line-01"]
];
for (const [model, channelId] of ROUTE_FIELD_CASES) {
  const routeParams = channelModule.normalizeImageRequest({
    model,
    channelId,
    dispatchMode: "manual",
    prompt: "x",
    imageSize: "2K",
    aspectRatio: "3:4"
  });
  const routeBody = channelModule.buildTextImageBody(routeParams, "legacy");
  check(
    `上游 JSON 体带 dispatchMode/channelId/manualModel :: ${model} / ${channelId}`,
    routeBody.dispatchMode === "manual"
      && routeBody.channelId === channelId
      && routeBody.manualModel === model,
    JSON.stringify({ dispatchMode: routeBody.dispatchMode, channelId: routeBody.channelId, manualModel: routeBody.manualModel })
  );
  const routeForm = await channelModule.buildEditImageForm(routeParams, []);
  check(
    `上游 multipart 带 dispatchMode/channelId/manualModel :: ${model} / ${channelId}`,
    routeForm.get("dispatchMode") === "manual"
      && routeForm.get("channelId") === channelId
      && routeForm.get("manualModel") === model,
    JSON.stringify({ dispatchMode: routeForm.get("dispatchMode"), channelId: routeForm.get("channelId"), manualModel: routeForm.get("manualModel") })
  );
}

// 香蕉 Pro 的两条线路都必须能被路由校验接受（不能被误判为非法）
for (const proLine of ["silent-pro-line-10", "silent-pro-line-09"]) {
  const proParams = channelModule.normalizeImageRequest({
    model: "nano-banana-pro",
    channelId: proLine,
    dispatchMode: "manual",
    prompt: "x"
  });
  check(`香蕉 Pro 线路通过路由校验 :: ${proLine}`, channelModule.validateImageRouting(proParams).ok === true);
}

console.log(lines.join("\n"));
console.log(`\n[routing-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
