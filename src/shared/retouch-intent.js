// 服装精修（原「批量白底图精修」）的结构化意图 + **唯一**精简提示词编译器。
//
// 和批量换装（src/shared/outfit-intent.js）同一套做法：
//   界面选择 → retouchIntent（批次冻结）→ API（payload.retouchIntent）→ 服务端权威校验（非法 400）
//   → 本文件的 compileRetouchPrompt() 编译 → 实际发送。
// 前端预览与服务端发送**调用同一个函数**，所以页面看到的提示词就是真正发出去的那份。
//
// 三条硬口径：
//   1. 只有用户明确选了「平直 / 自然波浪 / 直筒 / 收腰 / 宽松」才写对应改变指令；
//      选「跟随原图」时只写"跟随原图"，不偷偷改版型、长度、尺寸。
//   2. 关闭对称时必须明确禁止强行对称（保留原图真实的不对称细节）。
//   3. 横平竖直只修正明显的拍摄摆放或线条歪扭，不把原本有意的褶裥、弧线、波浪边、不对称设计强行拉直。

export const RETOUCH_INTENT_VERSION = 1;

/** 对称：默认关闭（关闭 = 最大限度保留原图真实的左右不对称细节）。 */
export const RETOUCH_SYMMETRY_OPTIONS = Object.freeze([
  { value: "off", label: "关闭对称" },
  { value: "on", label: "开启服装对称" }
]);
export const RETOUCH_SYMMETRY_VALUES = Object.freeze(RETOUCH_SYMMETRY_OPTIONS.map((item) => item.value));
export const DEFAULT_RETOUCH_SYMMETRY = "off";

/** 衣摆或裙摆：默认跟随原图。 */
export const RETOUCH_HEM_OPTIONS = Object.freeze([
  { value: "follow_original", label: "跟随原图" },
  { value: "straight", label: "平直" },
  { value: "natural_wave", label: "自然波浪" }
]);
export const RETOUCH_HEM_VALUES = Object.freeze(RETOUCH_HEM_OPTIONS.map((item) => item.value));
export const DEFAULT_RETOUCH_HEM = "follow_original";

/** 版型：默认跟随原图。 */
export const RETOUCH_FIT_OPTIONS = Object.freeze([
  { value: "follow_original", label: "跟随原图" },
  { value: "straight", label: "直筒" },
  { value: "waisted", label: "收腰" },
  { value: "loose", label: "宽松" }
]);
export const RETOUCH_FIT_VALUES = Object.freeze(RETOUCH_FIT_OPTIONS.map((item) => item.value));
export const DEFAULT_RETOUCH_FIT = "follow_original";

/** 自动生成部分（不含用户补充）的建议上限。 */
export const RETOUCH_AUTO_PROMPT_CHAR_LIMIT = 600;

/** 用户补充的长度上限（界面提示用）。 */
export const RETOUCH_CUSTOM_PROMPT_LIMIT = 1000;

/** 固定的精修目标（需求第一条里的八项，全部落在这两段里，只出现一次）。 */
export const RETOUCH_GOAL_TEXT = [
  "生成干净的服装白底精修图。去除明显褶皱，在不改变原服装结构的前提下，",
  "修正明显歪扭的门襟、缝线、袋口和边缘，使可拉直的细节横平竖直",
  "（只修正明显的拍摄摆放或线条歪扭，不把原本有意的褶裥、弧线、波浪边和不对称设计强行拉直）；",
  "保持服装原有款式、颜色、面料、纹理、缝线、扣子、口袋和其他细节不变，不创新、不凭空增加细节、不改变服装设计、不偏色。"
].join("");

export const RETOUCH_CLEANUP_TEXT = "去掉衣架、夹子、大头针和固定服装的其他物品，只保留干净的服装主体；修正服装外轮廓，使轮廓平滑、连续、自然。";

/**
 * 结构事实：对称 / 衣摆或裙摆 / 版型三行。
 * 选「跟随原图」时只写"跟随原图"，不加任何改变指令。
 */
export function retouchStructureLines(intent) {
  const normalized = normalizeRetouchIntent(intent);
  const lines = [];
  lines.push(normalized.symmetry === "on"
    ? "对称：开启服装对称，只调整服装左右结构让版型左右对称，不改变人物身体、脸、姿势和服装款式，不新增设计。"
    : "对称：关闭对称，保留原图中真实的左右不对称细节，不要强行把服装做成对称。");
  const hem = RETOUCH_HEM_OPTIONS.find((item) => item.value === normalized.hemTreatment);
  if (normalized.hemTreatment === "follow_original") {
    lines.push("衣摆或裙摆：跟随原图。");
  } else if (normalized.hemTreatment === "straight") {
    lines.push("衣摆或裙摆：平直，把明显歪扭或摆放造成的波浪拉平直，但不要抹掉原有的开衩、褶裥和设计线。");
  } else {
    lines.push("衣摆或裙摆：自然波浪，呈现自然垂落的波浪，但不要凭空制造夸张褶皱。");
  }
  void hem;
  if (normalized.fit === "follow_original") {
    lines.push("版型：跟随原图。");
  } else if (normalized.fit === "straight") {
    lines.push("版型：直筒，把服装修成直筒轮廓，不改变款式、长度和细节设计。");
  } else if (normalized.fit === "waisted") {
    lines.push("版型：收腰，把服装修成收腰轮廓，不改变款式、长度和细节设计。");
  } else {
    lines.push("版型：宽松，把服装修成宽松轮廓，不改变款式、长度和细节设计。");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 归一化（旧存档 / 旧请求都必须安全：绝不抛错，绝不把对象拼成 [object Object]）
// ---------------------------------------------------------------------------

function asText(value, limit = 240) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function pickEnum(value, allowed, fallback) {
  const text = asText(value, 60);
  return allowed.includes(text) ? text : fallback;
}

/** 用户补充：保留原始换行，但去掉首尾空白；对象/数组一律当空（防止 [object Object]）。 */
function asCustomPrompt(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value).replace(/\r\n/g, "\n").trim().slice(0, RETOUCH_CUSTOM_PROMPT_LIMIT + 200);
}

export function normalizeRetouchIntent(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: RETOUCH_INTENT_VERSION,
    symmetry: pickEnum(source.symmetry, RETOUCH_SYMMETRY_VALUES, DEFAULT_RETOUCH_SYMMETRY),
    hemTreatment: pickEnum(source.hemTreatment, RETOUCH_HEM_VALUES, DEFAULT_RETOUCH_HEM),
    fit: pickEnum(source.fit, RETOUCH_FIT_VALUES, DEFAULT_RETOUCH_FIT),
    customPrompt: asCustomPrompt(source.customPrompt)
  };
}

export function defaultRetouchIntent() {
  return normalizeRetouchIntent({});
}

// ---------------------------------------------------------------------------
// 校验（服务端权威：非法枚举 / 版本不对 → 明确 400；前端也用它做提交前检查）
// ---------------------------------------------------------------------------

/**
 * @returns {{ok: boolean, errors: string[], intent: object}}
 */
export function validateRetouchIntent(value) {
  const errors = [];
  const source = value && typeof value === "object" ? value : null;
  if (!source) {
    return { ok: false, errors: ["缺少精修意图"], intent: normalizeRetouchIntent(null) };
  }
  if (source.version !== undefined && Number(source.version) !== RETOUCH_INTENT_VERSION) {
    errors.push(`精修意图版本不支持：${String(source.version)}`);
  }
  if (source.symmetry !== undefined && !RETOUCH_SYMMETRY_VALUES.includes(asText(source.symmetry, 60))) {
    errors.push(`非法的对称选项：${String(source.symmetry)}`);
  }
  if (source.hemTreatment !== undefined && !RETOUCH_HEM_VALUES.includes(asText(source.hemTreatment, 60))) {
    errors.push(`非法的衣摆/裙摆选项：${String(source.hemTreatment)}`);
  }
  if (source.fit !== undefined && !RETOUCH_FIT_VALUES.includes(asText(source.fit, 60))) {
    errors.push(`非法的版型选项：${String(source.fit)}`);
  }
  if (source.customPrompt !== undefined && typeof source.customPrompt !== "string") {
    errors.push("用户补充必须是文本");
  }
  return { ok: errors.length === 0, errors, intent: normalizeRetouchIntent(source) };
}

// ---------------------------------------------------------------------------
// 唯一的精简提示词编译器
// ---------------------------------------------------------------------------

/**
 * 精修最终提示词。
 *
 * @param {object} options
 * @param {object} options.intent        结构化精修意图（对称 / 衣摆 / 版型 / 用户补充）
 * @param {string} [options.userPrompt]  页面上「通用白底精修提示词」里用户自己写的内容（系统默认词会被忽略）
 * @param {string} [options.productNote] 页面上的「本次需求 / 商品补充信息」
 * @returns {{prompt, sections, autoChars, chars, userChars, warnings, structure}}
 */
export function compileRetouchPrompt(options = {}) {
  const intent = normalizeRetouchIntent(options.intent);
  const warnings = [];

  // 用户补充：用户自己的文字只出现一次，合成一段。
  // - 页面「通用白底精修提示词」如果还是系统默认词，就不重复塞进来（固定段已经覆盖这些内容）；
  // - 内置的「用户补充」输入框（intent.customPrompt）永远算用户内容。
  const userBlocks = [];
  // 注意：内置默认词的判断必须用**保留换行**的原文，asText 会把换行压成空格、导致比不中。
  const pagePromptRaw = options.userPrompt === null || options.userPrompt === undefined || typeof options.userPrompt === "object"
    ? ""
    : String(options.userPrompt).replace(/\r\n/g, "\n").trim();
  const pagePrompt = pagePromptRaw ? asText(pagePromptRaw, 20000) : "";
  if (pagePrompt && !isBuiltinRetouchPrompt(pagePromptRaw)) userBlocks.push(pagePrompt);
  const productNote = asText(options.productNote, 4000);
  if (productNote) userBlocks.push(productNote);
  if (intent.customPrompt) userBlocks.push(intent.customPrompt);

  const structure = retouchStructureLines(intent).join("\n");
  const sections = [];
  if (userBlocks.length) sections.push({ id: "user", title: "【用户补充】", body: userBlocks.join("\n") });
  sections.push({ id: "goal", title: "【服装精修目标】", body: RETOUCH_GOAL_TEXT });
  sections.push({ id: "cleanup", title: "【清理与轮廓】", body: RETOUCH_CLEANUP_TEXT });
  sections.push({ id: "structure", title: "【结构事实】", body: structure });

  const prompt = sections.map((section) => `${section.title}\n${section.body}`).join("\n\n");
  const autoChars = RETOUCH_GOAL_TEXT.length + RETOUCH_CLEANUP_TEXT.length + structure.length + 3 * 8;
  if (autoChars > RETOUCH_AUTO_PROMPT_CHAR_LIMIT) {
    warnings.push(`自动内容约 ${autoChars} 字，超过建议上限 ${RETOUCH_AUTO_PROMPT_CHAR_LIMIT} 字`);
  }
  const userChars = userBlocks.join("\n").length;
  if (intent.customPrompt.length > RETOUCH_CUSTOM_PROMPT_LIMIT) {
    warnings.push(`用户补充超过 ${RETOUCH_CUSTOM_PROMPT_LIMIT} 字，建议精简`);
  }
  return { prompt, sections, autoChars, chars: prompt.length, userChars, warnings, structure };
}

/** 提交按钮旁的一行摘要：白底精修｜对称：关闭｜衣摆：跟随原图｜版型：直筒。 */
export function summarizeRetouchIntent(intent) {
  const normalized = normalizeRetouchIntent(intent);
  const label = (list, value) => list.find((item) => item.value === value)?.label || value;
  return {
    symmetryText: label(RETOUCH_SYMMETRY_OPTIONS, normalized.symmetry),
    hemText: label(RETOUCH_HEM_OPTIONS, normalized.hemTreatment),
    fitText: label(RETOUCH_FIT_OPTIONS, normalized.fit)
  };
}

// ---------------------------------------------------------------------------
// 系统内置的「通用白底精修提示词」默认词
//
// 放在共享层是为了让前端预览和服务端编译**用同一份判断**：页面上的提示词只要还等于这些
// 内置默认词，就不作为用户补充重复塞进最终提示词（固定段已经覆盖同样的内容）。
// ---------------------------------------------------------------------------

/** 当前默认词：多图生图（图1~图N 一次生成一张白底成品图）。 */
export const WHITE_REFINE_DEFAULT_PROMPT = [
  "白底精修任务（多图生图）：图1、图2……图N 是**同一件服装**的多张素材，可能是正面、背面、侧面、平铺、挂拍或局部细节，一次全部上传即可。",
  "点击生成只输出**一张**白底精修成品图：把这几张素材里的同一件服装综合成一张干净商品图；不要输出多张、不要左右拼贴、不要分格、不要做对比图或说明图。",
  "不同素材之间只做信息互补（背面补正面看不到的结构，细节图补领口/袖口/扣子/面料），不能把某张素材的背景、道具、阴影、模特、衣架或另一件服装的部件拼进成品。",
  "目标是把这件服装处理成干净白底电商商品图：去掉原背景、衣架、挂钩、夹子、图钉、别针、固定针、支撑物、杂乱阴影、脏点和多余道具，让平铺/挂拍形态规整自然。",
  "只允许做白底清理、衣架去除、边缘修净、轻度版面摆正、压痕和杂乱褶皱整理；去掉运输压痕、固定造成的尖锐折痕和多余皱团，但保留服装结构需要的自然垂感、缝线边缘和面料纹理。",
  "这件服装是唯一主事实：颜色深浅、明度、饱和度、灰度、白位黑位、版型、长度、领口、袖口、袖克夫、扣子、拉链、腰带、口袋、刺绣、印花、压线、拼接、面料材质和全部可见细节都不能改变。",
  "颜色校准以素材原服装为准，尤其牛仔、水洗、做旧、针织、皮革、雪纺等面料必须保持原始色阶：不要提蓝、提饱和、加深颜色、提高对比度、增加油润感、高光、锐化、商业滤镜或自动美化。",
  "白底可以变干净，但服装本体不能被重新渲染成新商品图；只能用同一件服装附近纹理补齐被衣架、夹子、图钉、别针遮挡的位置，不能新增口袋、压线、洗水纹、褶皱纹理或改变原本水洗分布。",
  "最终输出一张高清白底服装商品图，无模特、无人台、无衣架、无挂钩、无夹子、无图钉、无别针、无固定针、无文字、水印、标签说明或拼贴对比图。"
].join("\n");

/** 旧默认词（颜色锁定版）。 */
export const WHITE_REFINE_COLOR_LOCK_LEGACY_DEFAULT_PROMPT = [
  "批量白底精修服装任务：图1上传区是批量要处理的服装平铺图/挂拍图，图2上传区是可选参考/细节图，本页不使用图3。",
  "目标是把图1处理成干净白底电商商品图：去掉原背景、衣架、挂钩、夹子、支撑物、杂乱阴影、脏点和多余道具，让服装平铺/挂拍形态更规整自然。",
  "只允许做白底清理、衣架去除、边缘修净、轻度版面摆正、压痕和杂乱褶皱整理；保留轻微自然松弛垂感，不要抹平面料原有纹理和针织/皮革/牛仔/雪纺等材质特征。",
  "图1服装是唯一主事实：颜色深浅、饱和度、版型、长度、领口、袖口、袖克夫、扣子、拉链、腰带、口袋、刺绣、印花、压线、拼接、面料材质和全部可见细节都不能改变。",
  "颜色校准以图1原服装为准：不要增加饱和度、对比度、油润感、高光或商业滤镜；牛仔、针织、皮革、雪纺等面料保持原始色阶，不变深、不变艳、不发油、不发灰。",
  "图2如果上传，只作为参考池：可以帮助理解标准平铺形态、袖口/腰带/扣子/面料细节或衣架去除后的自然补齐方式；不能把图2款式、颜色、图案、背景或新结构迁移到图1。",
  "最终输出高清白底服装商品图，无模特、无人台、无衣架、无文字、水印、标签说明或拼贴对比图。"
].join("\n");

/** 旧默认词（"批量…"那一版，2026-09-26 之前的当前默认）。 */
export const WHITE_REFINE_BATCH_LEGACY_DEFAULT_PROMPT = [
  "批量白底精修服装任务：图1上传区是批量要处理的服装平铺图/挂拍图，图2上传区是可选参考/细节图，本页不使用图3。",
  "目标是把图1处理成干净白底电商商品图：去掉原背景、衣架、挂钩、夹子、图钉、别针、固定针、支撑物、杂乱阴影、脏点和多余道具，让服装平铺/挂拍形态更规整自然。",
  "只允许做白底清理、衣架去除、边缘修净、轻度版面摆正、压痕和杂乱褶皱整理；去掉运输压痕、固定造成的尖锐折痕和多余皱团，但保留服装结构需要的自然垂感、缝线边缘和面料纹理。",
  "图1服装是唯一主事实：颜色深浅、明度、饱和度、灰度、白位黑位、版型、长度、领口、袖口、袖克夫、扣子、拉链、腰带、口袋、刺绣、印花、压线、拼接、面料材质和全部可见细节都不能改变。",
  "颜色校准以图1原服装为准，尤其牛仔、水洗、做旧、针织、皮革、雪纺等面料必须保持原始色阶：不要提蓝、提饱和、加深颜色、提高对比度、增加油润感、高光、锐化、商业滤镜或自动美化；右图不能比原图更艳、更深、更蓝、更硬。",
  "白底可以变干净，但服装本体不能被重新渲染成新商品图；只能用同一件服装附近纹理补齐被衣架、夹子、图钉、别针遮挡的位置，不能新增口袋、压线、洗水纹、褶皱纹理或改变原本水洗分布。",
  "图2如果上传，只作为参考池：可以帮助理解标准平铺形态、袖口/腰带/扣子等局部细节或衣架去除后的自然补齐方式；不能把图2款式、颜色、图案、背景或新结构迁移到图1。",
  "最终输出高清白底服装商品图，无模特、无人台、无衣架、无挂钩、无夹子、无图钉、无别针、无固定针、无文字、水印、标签说明或拼贴对比图。"
].join("\n");

export const WHITE_REFINE_BUILTIN_PROMPTS = Object.freeze([
  WHITE_REFINE_DEFAULT_PROMPT,
  WHITE_REFINE_COLOR_LOCK_LEGACY_DEFAULT_PROMPT,
  WHITE_REFINE_BATCH_LEGACY_DEFAULT_PROMPT
]);

/** 页面上的提示词是否还是系统内置默认词（是 → 不作为用户补充重复塞进最终提示词）。 */
export function isBuiltinRetouchPrompt(text) {
  const value = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!value) return true;
  return WHITE_REFINE_BUILTIN_PROMPTS.some((item) => item.trim() === value);
}
