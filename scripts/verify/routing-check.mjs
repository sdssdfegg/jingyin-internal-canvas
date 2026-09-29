// 渠道 / 模型目录静态 + 接口输出检查（不调用任何付费生图接口）。
//
// 覆盖验收项：
//   1. 接口和 DOM 中旧渠道 ID / 旧渠道名称数量为 0
//   2. 香蕉 2 只有 Subdirect / 云枢 / Origin 三条线路，顺序固定，均 ¥0.12
//   3. 香蕉 Pro 只有 Subdirect 和 Origin
//   4. 旧 nano-banana2 存档最终发出 banana-2
//   5. 非法 channelId / 非法模型+线路组合被服务端拒绝
//   6. 模型切换后图片数量 / 文件大小 / 提示词长度 / 比例正确收敛
//
// 用法：node scripts/verify/routing-check.mjs
import { readFileSync, readdirSync } from "node:fs";
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
const quickClusterStart = mainJsx.indexOf("quickToolCluster");
// 结束边界用「生成按钮」这一段（2026-09-26 SKILL/换装开关删除后，原边界 skillToggleButton 已不存在）。
const quickClusterEnd = mainJsx.indexOf("generateButton", quickClusterStart);
const quickCluster = mainJsx.slice(quickClusterStart, quickClusterEnd > quickClusterStart ? quickClusterEnd : quickClusterStart + 4000);
check("成功切出快捷悬浮框功能组（用于渠道硬编码检查）", quickClusterStart > 0 && quickCluster.length > 200, `len=${quickCluster.length}`);
for (const token of [...FORBIDDEN_TOKENS, ...FORBIDDEN_IDS]) {
  check(`快捷悬浮框 JSX 不含旧渠道 ${token}`, !quickCluster.includes(token));
}

// ---------------------------------------------------------------- 线路白名单
// 2026-09-26（按用户要求）三件事：
//   1. 模型顺序固定 2.0 → 2.5 → 香蕉 2 → 香蕉 Pro；
//   2. 2.0 / 2.5 的 Origin 线路排第一位（也是这两条模型的默认线路）；
//   3. 香蕉 2 的「云枢」只在前端隐藏（中转站线路照旧 ACTIVE，服务端目录/校验照旧认）。
// 香蕉 2 白名单仍是三条 Subdirect → 云枢 → Origin，统一 ¥0.12/张；前端实际显示 Subdirect → Origin。
const MODEL_ORDER = ["tt-image-2", "tt-image-2.5", "banana-2", "nano-banana-pro"];
check(
  "模型顺序 = 2.0 → 2.5 → 香蕉 2 → 香蕉 Pro",
  JSON.stringify((catalog.models || []).map((model) => model.id)) === JSON.stringify(MODEL_ORDER),
  JSON.stringify((catalog.models || []).map((model) => model.id))
);
for (const [modelId, originId] of [["tt-image-2", "silent-tt2-line-11"], ["tt-image-2.5", "silent-tt25-line-06"]]) {
  const rows = routingModule.channelsForModel(modelId, catalog);
  check(
    `${modelId} 的第一条线路是 Origin`,
    rows[0]?.id === originId && rows[0]?.label === "Origin",
    JSON.stringify(rows.slice(0, 3).map((item) => `${item.label}/${item.price}`))
  );
  check(
    `${modelId} 的默认线路就是 Origin`,
    routingModule.defaultChannelForModel(modelId, catalog) === originId,
    routingModule.defaultChannelForModel(modelId, catalog)
  );
}
check(
  "2.0 / 2.5 的 Origin 价格仍是各自原来的 0.10（只改顺序，不改价）",
  routingModule.channelsForModel("tt-image-2", catalog)[0]?.price === 0.1
    && routingModule.channelsForModel("tt-image-2.5", catalog)[0]?.price === 0.1,
  JSON.stringify([
    routingModule.channelsForModel("tt-image-2", catalog)[0]?.price,
    routingModule.channelsForModel("tt-image-2.5", catalog)[0]?.price
  ])
);

const BANANA_LINE_IDS = ["silent-banana-line-08", "silent-banana-line-07", "silent-banana-line-09"];
const BANANA_LINE_LABELS = ["Subdirect", "云枢", "Origin"];
const BANANA_LINE_PRICE = 0.12;
const BANANA_HIDDEN_ID = "silent-banana-line-07";
const bananaAllowlist = routingModule.MODEL_CHANNEL_ALLOWLIST["banana-2"];
const bananaChannels = routingModule.channelsForModel("banana-2", catalog);
check(
  "香蕉 2 白名单是 Subdirect + 云枢 + Origin（三条，顺序固定）",
  bananaAllowlist.length === 3
    && bananaAllowlist.every((item, index) => item.id === BANANA_LINE_IDS[index] && item.label === BANANA_LINE_LABELS[index]),
  JSON.stringify(bananaAllowlist.map((item) => [item.id, item.label, item.price]))
);
check(
  "香蕉 2 三条白名单线路价格都是 0.12",
  bananaAllowlist.length === 3 && bananaAllowlist.every((item) => Number(item.price) === BANANA_LINE_PRICE),
  JSON.stringify(bananaAllowlist.map((item) => [item.label, item.price]))
);
check(
  "香蕉 2 前端菜单 = Subdirect → Origin（云枢已隐藏，Origin 紧随其后）",
  bananaChannels.length === 2
    && bananaChannels[0].id === "silent-banana-line-08"
    && bananaChannels[0].label === "Subdirect"
    && bananaChannels[1].id === "silent-banana-line-09"
    && bananaChannels[1].label === "Origin",
  JSON.stringify(bananaChannels.map((item) => [item.id, item.label, item.price]))
);
check(
  "香蕉 2 前端两条线路价格都是 0.12",
  bananaChannels.length === 2 && bananaChannels.every((item) => Number(item.price) === BANANA_LINE_PRICE),
  JSON.stringify(bananaChannels.map((item) => [item.label, item.price]))
);
check(
  "香蕉 2 的云枢是「前端隐藏」而不是「下架」",
  routingModule.isHiddenChannelId(BANANA_HIDDEN_ID)
    && !routingModule.isForbiddenChannelId(BANANA_HIDDEN_ID)
    && (catalog.channels || []).some((channel) => channel.id === BANANA_HIDDEN_ID),
  `hidden=${routingModule.isHiddenChannelId(BANANA_HIDDEN_ID)} forbidden=${routingModule.isForbiddenChannelId(BANANA_HIDDEN_ID)}`
);
check(
  "香蕉 2 的 Origin channelId 与 Pro / Subdirect / 云枢都不冲突",
  new Set([...BANANA_LINE_IDS, "silent-pro-line-09", "silent-pro-line-10"]).size === BANANA_LINE_IDS.length + 2,
  BANANA_LINE_IDS.join(",")
);

// 顺序稳定性：刷新页面 / 切换模型来回切 / 读旧存档都不能改变这些顺序。
const bananaOrderFirst = routingModule.channelsForModel("banana-2", catalog).map((item) => item.id).join(",");
const bananaOrderSecond = routingModule.channelsForModel("banana-2", catalog).map((item) => item.id).join(",");
check(
  "香蕉 2 默认线路固定是排第一的 Subdirect",
  routingModule.defaultChannelForModel("banana-2", catalog) === "silent-banana-line-08",
  routingModule.defaultChannelForModel("banana-2", catalog)
);
check(
  "重复取线路目录结果完全一致（刷新/重渲染不会改顺序）",
  bananaOrderFirst === bananaOrderSecond,
  bananaOrderFirst
);
{
  // 切换到别的模型再切回来，香蕉 2 的可见线路顺序与价格不变。
  const roundTrip = routingModule.convergeSettingsForModel(
    routingModule.convergeSettingsForModel({ model: "banana-2", channelId: "silent-banana-line-09" }, catalog),
    catalog
  );
  const afterSwitch = routingModule.channelsForModel(roundTrip.model, catalog);
  check(
    "切模型来回后香蕉 2 仍是 Subdirect → Origin，且 Origin 这条线路被保留",
    roundTrip.model === "banana-2"
      && roundTrip.channelId === "silent-banana-line-09"
      && afterSwitch.length === 2
      && afterSwitch[1].id === "silent-banana-line-09",
    JSON.stringify(afterSwitch.map((item) => `${item.label}:${item.price}`))
  );
}
{
  // 旧存档：云枢现在只在前端隐藏，所以旧存档里的云枢要收敛到第一条可见线路 Subdirect。
  const legacyCloud = routingModule.convergeSettingsForModel({ model: "banana-2", channelId: BANANA_HIDDEN_ID }, catalog);
  check(
    "旧存档选着香蕉 2 云枢 → 收敛到第一条可见线路 Subdirect（界面与请求一致）",
    legacyCloud.channelId === "silent-banana-line-08",
    `channelId=${legacyCloud.channelId}`
  );
  // 服务端仍然接受云枢（隐藏 ≠ 删除）：请求用旧 channelId 也能通过校验。
  const hiddenParams = channelModule.normalizeImageRequest({
    model: "banana-2", channelId: BANANA_HIDDEN_ID, prompt: "x", imageSize: "2K", aspectRatio: "3:4"
  });
  check("服务端仍然接受香蕉 2 云枢（与「删除」不同）",
    channelModule.validateImageRouting(hiddenParams).ok === true,
    channelModule.validateImageRouting(hiddenParams).code);
  // 旧存档里的未知线路 -> 收敛到第一条（Subdirect），顺序表的第一位。
  const legacyUnknown = routingModule.convergeSettingsForModel({ model: "banana-2", channelId: "silent-banana-line-99" }, catalog);
  check(
    "旧存档里的未知香蕉 2 线路 → 收敛到第一条 Subdirect",
    legacyUnknown.channelId === "silent-banana-line-08",
    `channelId=${legacyUnknown.channelId}`
  );
  // 旧存档里的旧模型 ID 读回来仍旧落进同一套三条线路。
  const legacyModelId = routingModule.convergeSettingsForModel({ model: "nano-banana2", channelId: "silent-banana-line-09" }, catalog);
  check(
    "旧存档模型 ID nano-banana2 + Origin 线路 → 仍是 banana-2 的 Origin（白名单第三条）",
    legacyModelId.model === "banana-2" && legacyModelId.channelId === "silent-banana-line-09",
    JSON.stringify({ model: legacyModelId.model, channelId: legacyModelId.channelId })
  );
}

// 目录侧（/api/config 的 routing.channels）也必须是同样三条、同样顺序、同样价格。
{
  const catalogBanana = (catalog.channels || [])
    .filter((channel) => (channel.supportedModels || []).includes("banana-2"))
    .map((channel) => ({
      id: channel.id,
      label: channel.label,
      price: Number(channel.pricing?.["banana-2"]?.price ?? 0)
    }));
  check(
    "服务端目录里香蕉 2 也是三条（顺序/价格与白名单一致）",
    catalogBanana.length === 3
      && catalogBanana.every((item, index) => item.id === BANANA_LINE_IDS[index] && item.label === BANANA_LINE_LABELS[index])
      && catalogBanana.every((item) => item.price === BANANA_LINE_PRICE),
    JSON.stringify(catalogBanana.map((item) => [item.id, item.label, item.price]))
  );
}

// 前端两条路径（快捷生成 main.jsx / 批量换装 outfit-workflow.jsx）都从同一个目录取线路，
// 这里同时断言"源头一致"，避免以后只改一处。
{
  const mainSrc = read("src/main.jsx");
  const outfitSrc = read("src/outfit-workflow.jsx");
  check(
    "快捷生成与批量换装用同一个线路目录（channelsForModel）",
    mainSrc.includes("channelsForModel(settings.model") && outfitSrc.includes("channelsForModel(settings.model"),
    "main.jsx + outfit-workflow.jsx"
  );
  check(
    "快捷生成与批量换装用同一套路由字段（routingFields）",
    mainSrc.includes("routingFields(") && outfitSrc.includes("routingFields("),
    "main.jsx + outfit-workflow.jsx"
  );
}

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

// 2026-09-28 新增：TT Image 2.5 Subdirect（¥0.11，只允许手动选线，只在 2.5 显示）
const TT25_SUBDIRECT_ID = "silent-tt25-line-07";
{
  const found = tt25Channels.find((item) => item.id === TT25_SUBDIRECT_ID);
  check("2.5 目录里显示 Subdirect（¥0.11）",
    Boolean(found) && found.label === "Subdirect" && Number(found.price) === 0.11,
    JSON.stringify(found || null));
  check("2.5 的 Subdirect 追加在末尾，默认线路仍是第一条 Origin",
    tt25Channels[0]?.id === "silent-tt25-line-06" && tt25Channels[tt25Channels.length - 1]?.id === TT25_SUBDIRECT_ID,
    JSON.stringify(tt25Channels.map((item) => `${item.label}/${item.price}`)));
  const tt25Params = channelModule.normalizeImageRequest({
    model: "tt-image-2.5", channelId: TT25_SUBDIRECT_ID, prompt: "x", imageSize: "2K", aspectRatio: "3:4"
  });
  const tt25Result = channelModule.validateImageRouting(tt25Params);
  check("2.5 的 Subdirect 通过服务端路由校验", tt25Result.ok === true, tt25Result.code);
  check("2.5 的 Subdirect 请求带 dispatchMode=manual + 正确 model",
    tt25Params.channelId === TT25_SUBDIRECT_ID && tt25Params.model === "tt-image-2.5" && tt25Params.dispatchMode === "manual",
    JSON.stringify({ model: tt25Params.model, channelId: tt25Params.channelId, dispatchMode: tt25Params.dispatchMode }));
  for (const other of ["banana-2", "nano-banana-pro", "tt-image-2"]) {
    const rows = routingModule.channelsForModel(other, catalog);
    check(`2.5 的 Subdirect 不出现在 ${other} 菜单里`,
      !rows.some((item) => item.id === TT25_SUBDIRECT_ID),
      JSON.stringify(rows.map((item) => item.id)));
    const cross = channelModule.normalizeImageRequest({
      model: other, channelId: TT25_SUBDIRECT_ID, prompt: "x", imageSize: "2K", aspectRatio: "3:4"
    });
    const crossResult = channelModule.validateImageRouting(cross);
    check(`${other} 带上 2.5 Subdirect 的 channelId 被服务端拒绝`,
      crossResult.ok === false,
      crossResult.code);
  }
}

// 老存档里选着已下线渠道时，必须能自动收敛到合法线路
const legacyTt2 = routingModule.convergeSettingsForModel({ model: "tt-image-2", channelId: "silent-tt2-line-04" }, catalog);
check("老存档选了已下线渠道 → 自动收敛到合法线路",
  legacyTt2.channelId !== "silent-tt2-line-04"
    && routingModule.channelsForModel("tt-image-2", catalog).some((item) => item.id === legacyTt2.channelId),
  `channelId=${legacyTt2.channelId}`);

// ------------------------------------------- 前端下架（只在菜单里隐藏，服务端照旧认）
// 2.0（TT Image 2）的 ZYG 三条：前端渠道菜单不再显示，但服务端目录与校验保持不变。
const HIDDEN_IDS = ["silent-tt2-line-05", "silent-tt2-line-06", "silent-tt2-line-07"];
check("隐藏名单里的线路都还在服务端目录里（说明是前端隐藏，不是下架）",
  HIDDEN_IDS.every((id) => (catalog.channels || []).some((channel) => channel.id === id)),
  HIDDEN_IDS.join(","));
check("隐藏名单与禁用名单是两套（hidden ≠ forbidden）",
  HIDDEN_IDS.every((id) => routingModule.isHiddenChannelId(id) && !routingModule.isForbiddenChannelId(id)),
  "isHidden=true / isForbidden=false");
const tt2Visible = routingModule.channelsForModel("tt-image-2", catalog);
check("2.0 前端菜单里完全没有 ZYG 三条",
  !tt2Visible.some((item) => HIDDEN_IDS.includes(item.id))
    && !tt2Visible.some((item) => /^ZYG-/.test(String(item.label || ""))),
  JSON.stringify(tt2Visible.map((item) => item.label)));
check("2.0 前端菜单条数正确（10 条里隐藏 3 条 → 7 条）",
  tt2Visible.length === 7, `count=${tt2Visible.length}`);
for (const id of HIDDEN_IDS) {
  const params = channelModule.normalizeImageRequest({
    model: "tt-image-2", channelId: id, prompt: "x", imageSize: "2K", aspectRatio: "3:4"
  });
  const result = channelModule.validateImageRouting(params);
  check(`服务端仍然接受前端隐藏的 ${id}（与"删除"不同）`, result.ok === true, result.code);
}
const legacyZyg = routingModule.convergeSettingsForModel({ model: "tt-image-2", channelId: "silent-tt2-line-06" }, catalog);
check("老存档选着被隐藏的 ZYG → 落到未隐藏的合法线路（界面与请求保持一致）",
  !HIDDEN_IDS.includes(legacyZyg.channelId) && tt2Visible.some((item) => item.id === legacyZyg.channelId),
  `channelId=${legacyZyg.channelId}`);

// 2026-09-26（按用户要求）：香蕉 2 的「云枢」（silent-banana-line-07）改成只在前端隐藏。
// 这里守住"隐藏/下架是两套机制"这条边界：云枢在隐藏名单里，但不在禁用名单里，服务端目录也还在。
{
  const bananaVisible = routingModule.channelsForModel("banana-2", catalog);
  check("香蕉 2 的「云枢」已从前端菜单隐藏",
    !bananaVisible.some((item) => item.id === "silent-banana-line-07")
      && routingModule.isHiddenChannelId("silent-banana-line-07"),
    JSON.stringify(bananaVisible.map((item) => `${item.id}:${item.label}`)));
  check("香蕉 2 云枢没有变成「下架」（不在禁用名单，服务端目录仍在）",
    routingModule.isHiddenChannelId("silent-banana-line-07")
      && !routingModule.isForbiddenChannelId("silent-banana-line-07")
      && (catalog.channels || []).some((channel) => channel.id === "silent-banana-line-07"),
    "isHidden=true / isForbidden=false / 目录仍在");

  // Origin 第三线路：路由字段必须是 model=banana-2 + Origin 自己的 channelId + manual
  const originRoute = routingModule.routingFields("banana-2", "silent-banana-line-09", catalog);
  check("Origin 线路路由字段 = banana-2 + silent-banana-line-09 + manual",
    originRoute.model === "banana-2"
      && originRoute.channelId === "silent-banana-line-09"
      && originRoute.dispatchMode === "manual",
    JSON.stringify(originRoute));
  const originParams = channelModule.normalizeImageRequest({
    model: "banana-2", channelId: "silent-banana-line-09", dispatchMode: "manual",
    prompt: "x", imageSize: "2K", aspectRatio: "3:4"
  });
  check("服务端接受 Origin 香蕉 2 线路（banana-2 + silent-banana-line-09）",
    channelModule.validateImageRouting(originParams).ok === true,
    channelModule.validateImageRouting(originParams).code);

  // 只允许该 Origin channelId 与 banana-2 组合：其它模型带上它就是非法组合。
  for (const otherModel of ["nano-banana-pro", "tt-image-2", "tt-image-2.5"]) {
    const crossParams = channelModule.normalizeImageRequest({
      model: otherModel, channelId: "silent-banana-line-09", dispatchMode: "manual",
      prompt: "x", imageSize: "2K", aspectRatio: "3:4"
    });
    const crossResult = channelModule.validateImageRouting(crossParams);
    check(`Origin 香蕉 2 线路不能给 ${otherModel} 用（channel_model_mismatch）`,
      crossResult.ok === false && crossResult.code === "channel_model_mismatch",
      crossResult.code);
  }
  // 反过来：banana-2 也不能蹭别的模型的 Origin 线路。
  for (const foreignOrigin of ["silent-pro-line-09", "silent-tt2-line-11", "silent-tt25-line-06"]) {
    const params = channelModule.normalizeImageRequest({
      model: "banana-2", channelId: foreignOrigin, dispatchMode: "manual", prompt: "x"
    });
    const result = channelModule.validateImageRouting(params);
    check(`banana-2 不能使用别的模型的 Origin 线路 ${foreignOrigin}`,
      result.ok === false && result.code === "channel_model_mismatch",
      result.code);
  }
}

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
  "切到 tt-image-2.5：数量收敛到 8 且渠道换到合法线路（默认=第一条 Origin）",
  toTt25.n === 8
    && toTt25.channelId === "silent-tt25-line-06"
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
  ["banana-2", "silent-banana-line-09"],
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

// ------------------------------------------- 客户端边界（Origin KEY 不允许进浏览器）
// 本轮只把 Origin 香蕉 2 的 channelId 放进客户端目录；Origin 的 KEY 依旧只存在
// 静音中转站的适配器配置里，客户端不出现任何上游域名或密钥字面量。
{
  const clientFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) clientFiles.push(path.relative(root, full));
    }
  };
  walk(path.join(root, "src"));
  const offenders = [];
  for (const file of clientFiles) {
    const text = read(file);
    if (/origingateway/i.test(text)) offenders.push(`${file}:origin-host`);
    if (/\bsk-[A-Za-z0-9_-]{8,}/.test(text)) offenders.push(`${file}:key-literal`);
  }
  check(
    `客户端源码(${clientFiles.length} 个文件)不含 Origin 上游域名与任何密钥字面量`,
    offenders.length === 0,
    offenders.join(",") || "0 命中"
  );

  // 生图接口地址只允许静音中转站（server/channel-config.js 的唯一来源）。
  const allowedBases = channelConfigModule.LOCKED_CHANNEL_API_BASE_URLS || [];
  const gatewayModule = await import(new URL("../../server/features/api-gateway/gateways/jingyin-online.js", import.meta.url));
  const gatewayDefaultBase = String(gatewayModule.JINGYIN_ONLINE_GATEWAY?.defaultBaseUrl || "");
  check(
    "生图上游只有静音中转站一个候选地址",
    allowedBases.length === 1
      && allowedBases[0] === channelConfigModule.PRIMARY_CHANNEL_API_BASE_URL
      && gatewayDefaultBase === "https://api.jingyin.online/v1",
    `locked=${allowedBases.join(",")} default=${gatewayDefaultBase}`
  );
  check(
    "浏览器拿不到任何上游直连兜底（clientDirectFallbackEnabled=false）",
    channelConfigModule.CHANNEL_POLICY.clientDirectFallbackEnabled === false
      && channelConfigModule.CHANNEL_POLICY.exposeUpstreamChannels === false,
    JSON.stringify(channelConfigModule.CHANNEL_POLICY)
  );
}

// ------------------------------------- 响应解析：Origin 线路结果仍走原有图片回传链路
// 中转站对 Origin 线路的返回与其它线路同形状，仍然由 extractImagesFromResponse 解析，
// 再交给前端共用的图片地址判定（image-hosts.js）与结果卡片渲染，链路不做分叉。
{
  const relayPayload = { data: [{ url: "https://api.jingyin.online/v1/images/generated/origin-banana2.png" }] };
  const parsed = channelModule.extractImagesFromResponse(relayPayload);
  check(
    "中转站返回的 Origin 结果能被 extractImagesFromResponse 解析",
    parsed.length === 1 && parsed[0].type === "url",
    JSON.stringify(parsed)
  );
  const b64Payload = { data: [{ b64_json: "aGVsbG8=" }] };
  check(
    "b64_json 形态的结果同样能进入回传链路",
    channelModule.extractImagesFromResponse(b64Payload)[0]?.type === "b64_json"
  );
  const hosts = await import(new URL("../../src/shared/image-hosts.js", import.meta.url));
  check(
    "解析出的结果地址通过前端共用的图片回传判定",
    hosts.classifyImageSource(String(parsed[0]?.value || "")).allowed === true,
    JSON.stringify(hosts.classifyImageSource(String(parsed[0]?.value || "")))
  );
  const relayResponseContract = channelModule.summarizeResponse(relayPayload);
  check(
    "回传链路仍按现有响应形状统计（data 数量 / image 数量）",
    relayResponseContract.dataCount === 1 && relayResponseContract.imageCount === 1,
    JSON.stringify(relayResponseContract)
  );
}

console.log(lines.join("\n"));
console.log(`\n[routing-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
