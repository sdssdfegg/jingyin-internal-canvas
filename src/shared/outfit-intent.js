// 批量换装「结构化意图」+ 唯一精简提示词编译器。
//
// 为什么要有这个文件：
//   2026-09-26 的 commit d4127ec 把批量侧的 SKILL / 图1图2 规则整块删了，
//   服务端最终提示词只剩 `buildUserPromptOnly()`（= 用户原话）。
//   结果是：界面上选的「上装 / 下装 / 鞋子 / 上装长度 / 下装长度 / 单件上衣 / 外套+内搭 / 套装」
//   虽然一路传到服务端（`payload.garmentParts` 等），**在最后一步被完全忽略** ——
//   所以以前那些选择对出图没有任何影响。
//
// 本文件就是那一层的唯一实现：
//   - 前端（摘要 + 最终提示词预览）和服务端（真正发给模型的提示词）**调用同一个
//     `compileOutfitPrompt()`**，不允许再各写一套近似模板；
//   - 结构化选择属于"用户明确输入"，即使通用自动规则（智能介入 / 旧 SKILL）关闭也照样进入提示词；
//   - 只做纯函数，不碰 DOM、不请求接口，前后端都能直接 import（与 `image-hosts.js` 同样的用法）。
//
// 最终提示词的顺序（与需求一致）：
//   【用户补充】 → 【本次换装目标】 → 【图2服装事实】 → 【穿法状态】 → 【人物基准】

// ---------------------------------------------------------------------------
// 1. 枚举（服务端校验与前端 UI 共用同一份，禁止在页面里另写一份字符串表）
// ---------------------------------------------------------------------------

/** 更换部位（多选，至少一个）。 */
export const OUTFIT_PART_OPTIONS = Object.freeze([
  { value: "upper", label: "上装", promptLabel: "上装" },
  { value: "lower", label: "下装", promptLabel: "下装" },
  { value: "shoes", label: "鞋子", promptLabel: "鞋子" }
]);
export const OUTFIT_PART_VALUES = Object.freeze(OUTFIT_PART_OPTIONS.map((item) => item.value));
/** 会写进"保持不变"的部位：鞋子不算 —— 批量换装是半身图，画面里没有鞋子。 */
export const OUTFIT_KEEP_PART_VALUES = Object.freeze(["upper", "lower"]);

/** 上装层级（只在选择了上装时使用）。 */
export const UPPER_LAYER_OPTIONS = Object.freeze([
  { value: "auto", label: "自动识别图2", promptLabel: "上装" },
  { value: "single", label: "仅一件上装", promptLabel: "上装" },
  { value: "inner", label: "仅内搭", promptLabel: "内搭" },
  { value: "outer", label: "仅外套", promptLabel: "外套" },
  { value: "inner-outer", label: "内搭+外套", promptLabel: "内搭和外套" }
]);
export const UPPER_LAYER_VALUES = Object.freeze(UPPER_LAYER_OPTIONS.map((item) => item.value));
export const DEFAULT_UPPER_LAYER = "auto";

/**
 * 穿法字段。
 * `parts`   ：哪些部位会出现这个字段（鞋子不出现衣领/袖子；下装只出现腰头/裤脚或裙摆）。
 * `needs`   ：出现条件。
 *              "closure" = 只有图2事实里确实存在扣子/拉链/门襟时才出现（普通无扣上衣不强制出现）；
 *              "outer"   = 只有上装层级是外套或内搭+外套时才出现。
 * 每个选项中 `prompt` 是进入【穿法状态】的原句，禁止在编译器里再写第二份文案。
 */
export const WEARING_FIELDS = Object.freeze([
  {
    key: "closure",
    label: "扣合状态",
    parts: Object.freeze(["upper"]),
    needs: "closure",
    options: Object.freeze([
      { value: "full", label: "全扣", prompt: "门襟全扣" },
      { value: "open", label: "全开", prompt: "门襟全开" },
      { value: "count-one", label: "扣一颗", prompt: "只扣一颗扣子" },
      { value: "count-two", label: "扣两颗", prompt: "只扣两颗扣子" },
      { value: "unbutton-top", label: "指定未扣：上部", prompt: "领口第一颗扣子不扣" },
      { value: "unbutton-middle", label: "指定未扣：中部", prompt: "中间扣子不扣" },
      { value: "unbutton-lower", label: "指定未扣：下部", prompt: "下面扣子不扣" }
    ])
  },
  {
    key: "outerState",
    label: "外套状态",
    parts: Object.freeze(["upper"]),
    needs: "outer",
    options: Object.freeze([
      { value: "open", label: "敞开", prompt: "外套敞开不系扣" },
      { value: "closed", label: "闭合", prompt: "外套闭合" },
      { value: "half", label: "半敞开", prompt: "外套半敞开" }
    ])
  },
  {
    key: "hem",
    label: "衣摆",
    parts: Object.freeze(["upper"]),
    options: Object.freeze([
      { value: "out", label: "自然放出", prompt: "衣摆自然放出" },
      { value: "tucked", label: "全部扎入", prompt: "衣摆全部扎入下装" },
      { value: "front-half", label: "前侧半扎", prompt: "衣摆前侧半扎、后摆放出" }
    ])
  },
  {
    key: "sleeve",
    label: "袖子",
    parts: Object.freeze(["upper"]),
    options: Object.freeze([
      { value: "down", label: "自然放下", prompt: "袖子自然放下" },
      { value: "rolled", label: "卷起", prompt: "袖子卷起" },
      { value: "forearm", label: "推至前臂", prompt: "袖子推至前臂" },
      { value: "elbow", label: "推至手肘", prompt: "袖子推至手肘" },
      { value: "wrist", label: "袖口到手腕", prompt: "袖口落在手腕" }
    ])
  },
  {
    key: "collar",
    label: "衣领",
    parts: Object.freeze(["upper"]),
    options: Object.freeze([
      { value: "flat", label: "自然平放", prompt: "衣领自然平放" },
      { value: "stand", label: "立领", prompt: "衣领立起" },
      { value: "open", label: "敞领", prompt: "衣领敞开" },
      { value: "buttoned-top", label: "扣到顶部", prompt: "衣领扣到顶部" }
    ])
  },
  {
    key: "fit",
    label: "版型",
    parts: Object.freeze(["upper"]),
    options: Object.freeze([
      { value: "follow", label: "跟随图2", prompt: "版型跟随图2" },
      { value: "loose", label: "宽松", prompt: "版型宽松" },
      { value: "regular", label: "合体", prompt: "版型合体" },
      { value: "slim", label: "修身", prompt: "版型修身" }
    ])
  },
  {
    key: "waistband",
    label: "腰头",
    parts: Object.freeze(["lower"]),
    options: Object.freeze([
      { value: "follow", label: "跟随图2", prompt: "腰头位置跟随图2" },
      { value: "high", label: "高腰", prompt: "下装为高腰" },
      { value: "mid", label: "中腰", prompt: "下装为中腰" },
      { value: "low", label: "低腰", prompt: "下装为低腰" }
    ])
  },
  {
    key: "lowerHem",
    label: "裤脚/裙摆",
    parts: Object.freeze(["lower"]),
    options: Object.freeze([
      { value: "follow", label: "跟随图2", prompt: "裤脚或裙摆跟随图2" },
      { value: "straight", label: "直筒", prompt: "裤脚直筒" },
      { value: "wide", label: "阔腿/大摆", prompt: "裤脚或裙摆放宽" },
      { value: "narrow", label: "收口/包身", prompt: "裤脚或裙摆收窄" },
      { value: "cuffed", label: "挽边", prompt: "裤脚挽边" }
    ])
  }
]);

/** 穿法模式。 */
export const WEARING_MODE_OPTIONS = Object.freeze([
  { value: "follow", label: "跟随图2穿法" },
  { value: "natural", label: "常规自然穿着" },
  { value: "custom", label: "自定义锁定" }
]);
export const WEARING_MODE_VALUES = Object.freeze(WEARING_MODE_OPTIONS.map((item) => item.value));
export const DEFAULT_WEARING_MODE = "follow";

/**
 * 图2结构化服装事实字段（分析结果只保留这些）。
 * `parts` 用来过滤：只把本次选中部位相关的事实插进最终提示词。
 * 人物身份、人脸发型肤色、背景光线、人体姿态、空泛套话在服务端分析阶段就被丢弃
 * （见 server/outfit-master-fit-ai.js 的 outputSchema 与 normalize 逻辑），这里不再接受这些字段。
 */
export const OUTFIT_FACT_FIELDS = Object.freeze([
  { key: "category", label: "类别与内外层", parts: Object.freeze(["upper"]) },
  { key: "color", label: "颜色", parts: Object.freeze(["upper", "lower", "shoes"]) },
  { key: "material", label: "材质纹理", parts: Object.freeze(["upper", "lower", "shoes"]) },
  { key: "silhouette", label: "版型", parts: Object.freeze(["upper", "lower"]) },
  { key: "length", label: "长度", parts: Object.freeze(["upper", "lower"]) },
  { key: "collarSleeve", label: "领口与袖长", parts: Object.freeze(["upper"]) },
  { key: "sleeveState", label: "袖子状态", parts: Object.freeze(["upper"]) },
  { key: "closure", label: "扣子/拉链", parts: Object.freeze(["upper"]) },
  { key: "hem", label: "衣摆扎入", parts: Object.freeze(["upper"]) },
  { key: "lowerType", label: "裤型/裙型", parts: Object.freeze(["lower"]) },
  { key: "shoeType", label: "鞋型", parts: Object.freeze(["shoes"]) },
  { key: "structure", label: "明显结构", parts: Object.freeze(["upper", "lower", "shoes"]) }
]);
export const OUTFIT_FACT_KEYS = Object.freeze(OUTFIT_FACT_FIELDS.map((item) => item.key));

/** 事实里"没识别出来"的统一标记（不允许自行补全）。 */
export const FACT_UNRECOGNIZED = "未识别";

/** 固定的人物基准句（只出现一次，且不进用户输入框）。 */
export const OUTFIT_PERSON_BASELINE = "图1是唯一人物身份、人体结构和姿势基准，不改变图1人物的身份、骨骼和姿势。";

/** 自动内容的建议长度上限（不含【用户补充】）。 */
export const OUTFIT_AUTO_PROMPT_CHAR_LIMIT = 600;

// 自定义穿法字段被用户显式指定后，图2事实里对应的那一条要丢掉，避免同一信息出现两遍。
const WEARING_FIELD_SUPERSEDES_FACT = Object.freeze({
  closure: ["closure"],
  outerState: ["closure"],
  hem: ["hem"],
  sleeve: ["sleeveState"],
  collar: ["collarSleeve"]
});

// ---------------------------------------------------------------------------
// 2. 归一化（读取旧存档 / 旧请求时也必须安全，绝不抛错、绝不让旧字段覆盖新选择）
// ---------------------------------------------------------------------------

function asText(value, limit = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function pickEnum(value, allowed, fallback) {
  const text = String(value ?? "").trim();
  return allowed.includes(text) ? text : fallback;
}

/** 更换部位：只保留合法值，去重，保持"上装→下装→鞋子"的固定顺序。 */
export function normalizeOutfitParts(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s|，、]+/);
  const set = new Set(raw.map((item) => String(item ?? "").trim()));
  return OUTFIT_PART_VALUES.filter((part) => set.has(part));
}

/** 图2事实：只保留白名单字段；未识别的字段原样保留"未识别"，不补全。
 *  非字符串/数字（对象、数组、null）一律视为空，避免把结构化对象拼成 [object Object]。 */
export function normalizeOutfitFacts(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = {};
  OUTFIT_FACT_KEYS.forEach((key) => {
    const raw = source[key];
    next[key] = typeof raw === "string" || typeof raw === "number" ? asText(raw, 200) : "";
  });
  return next;
}

/**
 * 结构化换装意图归一化。
 * 返回值永远是一个形状完整、枚举合法的对象；旧存档里没有 outfitIntent 时返回默认值，
 * 且**不会**去读 garmentComposition / garmentLengths 这些已删除的旧字段。
 */
export function normalizeOutfitIntent(value) {
  const source = value && typeof value === "object" ? value : {};
  const parts = normalizeOutfitParts(source.parts);
  const wearingSource = source.wearing && typeof source.wearing === "object" ? source.wearing : {};
  const wearing = {
    mode: pickEnum(wearingSource.mode, WEARING_MODE_VALUES, DEFAULT_WEARING_MODE),
    values: {}
  };
  WEARING_FIELDS.forEach((field) => {
    const allowed = field.options.map((option) => option.value);
    const picked = String(wearingSource.values?.[field.key] ?? "").trim();
    wearing.values[field.key] = allowed.includes(picked) ? picked : "";
  });
  const sourceInfo = source.factsSource && typeof source.factsSource === "object" ? source.factsSource : {};
  return {
    parts,
    upperLayer: pickEnum(source.upperLayer, UPPER_LAYER_VALUES, DEFAULT_UPPER_LAYER),
    wearing,
    facts: normalizeOutfitFacts(source.facts),
    factsSource: {
      mode: pickEnum(sourceInfo.mode, ["none", "auto", "manual"], "none"),
      sourceId: asText(sourceInfo.sourceId, 120),
      analyzedAt: Number.isFinite(Number(sourceInfo.analyzedAt)) ? Number(sourceInfo.analyzedAt) : 0
    }
  };
}

/** 默认意图：不选任何部位（强制用户先做选择）。 */
export function defaultOutfitIntent() {
  return normalizeOutfitIntent({});
}

/** 事实里已经识别出来的字段（值为空或"未识别"的算未识别）。 */
export function recognizedFactKeys(value) {
  const facts = normalizeOutfitFacts(value);
  return OUTFIT_FACT_KEYS.filter((key) => {
    const text = facts[key];
    return Boolean(text) && text !== FACT_UNRECOGNIZED && !/^未识别/.test(text);
  });
}

// ---------------------------------------------------------------------------
// 3. 校验（服务端拿到非法枚举要能明确 400；前端也用它做提交前检查）
// ---------------------------------------------------------------------------

/**
 * @returns {{ok: boolean, errors: string[], intent: object}}
 *   errors 里每一条都是可直接展示给用户的中文原因。
 */
export function validateOutfitIntent(value) {
  const errors = [];
  const source = value && typeof value === "object" ? value : null;
  if (!source) {
    return { ok: false, errors: ["缺少结构化换装意图"], intent: normalizeOutfitIntent(null) };
  }
  const rawParts = Array.isArray(source.parts) ? source.parts : null;
  if (!rawParts) {
    errors.push("更换部位必须是数组");
  } else {
    const illegal = rawParts.filter((part) => !OUTFIT_PART_VALUES.includes(String(part ?? "").trim()));
    if (illegal.length) errors.push(`非法的更换部位：${illegal.map((item) => String(item)).join("、")}`);
    if (normalizeOutfitParts(rawParts).length === 0) errors.push("请至少选择一个更换部位");
    if (new Set(rawParts.map((item) => String(item ?? "").trim())).size !== rawParts.length) {
      errors.push("更换部位存在重复项");
    }
  }
  if (source.upperLayer !== undefined && !UPPER_LAYER_VALUES.includes(String(source.upperLayer))) {
    errors.push(`非法的上装层级：${String(source.upperLayer)}`);
  }
  const wearing = source.wearing;
  if (wearing !== undefined) {
    if (!wearing || typeof wearing !== "object" || Array.isArray(wearing)) {
      errors.push("穿法设置必须是对象");
    } else {
      if (wearing.mode !== undefined && !WEARING_MODE_VALUES.includes(String(wearing.mode))) {
        errors.push(`非法的穿法模式：${String(wearing.mode)}`);
      }
      const values = wearing.values;
      if (values !== undefined) {
        if (!values || typeof values !== "object" || Array.isArray(values)) {
          errors.push("自定义穿法字段必须是对象");
        } else {
          Object.keys(values).forEach((key) => {
            const field = WEARING_FIELDS.find((item) => item.key === key);
            if (!field) {
              errors.push(`非法的穿法字段：${key}`);
              return;
            }
            const selected = String(values[key] ?? "").trim();
            if (selected && !field.options.some((option) => option.value === selected)) {
              errors.push(`非法的${field.label}取值：${selected}`);
            }
          });
        }
      }
    }
  }
  if (source.facts !== undefined && (!source.facts || typeof source.facts !== "object" || Array.isArray(source.facts))) {
    errors.push("图2服装事实必须是对象");
  }
  const intent = normalizeOutfitIntent(source);
  // 归一化之后仍然没有任何部位 → 同样按"未选择"处理（防止全是不合法值被静默吞掉）
  if (errors.length === 0 && intent.parts.length === 0) errors.push("请至少选择一个更换部位");
  return { ok: errors.length === 0, errors, intent };
}

// ---------------------------------------------------------------------------
// 4. 上装层级解析（自动识别只能由图2事实决定；不确定时标记出来，绝不偷偷猜）
// ---------------------------------------------------------------------------

const INNER_OUTER_PATTERN = /内搭.{0,6}外套|外套.{0,6}内搭|两件|叠穿|里外两层|内层.{0,4}外层|外层.{0,4}内层/;
const OUTER_PATTERN = /外套|大衣|风衣|夹克|开衫|西服|西装|马甲|派克|羽绒/;
const INNER_PATTERN = /内搭|打底|衬衫|衬衣|T恤|t恤|针织|毛衣|卫衣|背心|吊带/;
const SINGLE_PATTERN = /单件|一件|连衣裙|上衣|上装|衬衫裙/;

/**
 * @returns {{value: string, promptLabel: string, resolvedBy: "user"|"facts"|"fallback", uncertain: boolean}}
 */
export function resolveUpperLayer(intent) {
  const normalized = normalizeOutfitIntent(intent);
  const option = UPPER_LAYER_OPTIONS.find((item) => item.value === normalized.upperLayer) || UPPER_LAYER_OPTIONS[0];
  if (normalized.upperLayer !== "auto") {
    return { value: option.value, promptLabel: option.promptLabel, resolvedBy: "user", uncertain: false };
  }
  const factsText = [normalized.facts.category, normalized.facts.structure, normalized.facts.closure]
    .map((item) => asText(item, 200))
    .filter(Boolean)
    .join(" ");
  const recognized = factsText && !/^未识别/.test(factsText);
  if (recognized) {
    if (INNER_OUTER_PATTERN.test(factsText)) return { value: "inner-outer", promptLabel: "内搭和外套", resolvedBy: "facts", uncertain: false };
    if (OUTER_PATTERN.test(factsText)) return { value: "outer", promptLabel: "外套", resolvedBy: "facts", uncertain: false };
    if (INNER_PATTERN.test(factsText)) return { value: "inner", promptLabel: "内搭", resolvedBy: "facts", uncertain: false };
    if (SINGLE_PATTERN.test(factsText)) return { value: "single", promptLabel: "上装", resolvedBy: "facts", uncertain: false };
  }
  // 识别不出来：用中性说法，并把"不确定"交给界面提示用户去选，不在这里瞎猜内搭/外套。
  return { value: "single", promptLabel: "上装", resolvedBy: "fallback", uncertain: true };
}

/**
 * 当前意图下应该出现哪些穿法字段（界面按这个渲染，编译器也按同一函数过滤）。
 */
export function visibleWearingFields(intent) {
  const normalized = normalizeOutfitIntent(intent);
  const parts = normalized.parts;
  const layer = resolveUpperLayer(normalized);
  const facts = normalized.facts;
  const closureRecognized = Boolean(asText(facts.closure)) && !/^未识别/.test(asText(facts.closure));
  // 图2没分析过时不做隐藏（否则用户找不到扣子设置）；分析过且明确没有扣合结构才隐藏。
  const hasAnalyzed = normalized.factsSource.mode !== "none" || recognizedFactKeys(facts).length > 0;
  const closureVisible = !hasAnalyzed || closureRecognized
    || /扣|拉链|门襟|纽扣|系带|腰带/.test([facts.category, facts.structure].map((item) => asText(item)).join(" "));
  return WEARING_FIELDS.filter((field) => {
    if (!field.parts.some((part) => parts.includes(part))) return false;
    if (field.needs === "closure" && !closureVisible) return false;
    if (field.needs === "outer" && !["outer", "inner-outer"].includes(layer.value)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// 5. 唯一编译器
// ---------------------------------------------------------------------------

function partLabel(part) {
  return OUTFIT_PART_OPTIONS.find((item) => item.value === part)?.promptLabel || part;
}

function joinChinese(items, conjunction = "和") {
  const list = items.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join("、")}${conjunction}${list[list.length - 1]}`;
}

/** 本次换装目标里的"换成什么"。 */
export function outfitTargetText(intent) {
  const normalized = normalizeOutfitIntent(intent);
  const layer = resolveUpperLayer(normalized);
  const parts = normalized.parts;
  if (parts.length === 0) return "";
  // 上装是"内搭+外套"且同时换了别的部位时，拆成两项并列，避免"内搭和外套、下装"这种歧义。
  const upperPhrases = [];
  if (parts.includes("upper")) {
    if (layer.value === "inner-outer") {
      if (parts.length === 1) upperPhrases.push("内搭和外套");
      else upperPhrases.push("内搭", "外套");
    } else {
      upperPhrases.push(layer.promptLabel);
    }
  }
  const phrases = [
    ...upperPhrases,
    ...OUTFIT_PART_VALUES.filter((part) => part !== "upper" && parts.includes(part)).map((part) => partLabel(part))
  ];
  return `让图1模特穿着图2的${joinChinese(phrases, "和")}。`;
}

/** 未选部位"保持不变"（三项全选时返回空串，不产生多余句子）。
 *
 * 2026-09-26（按用户要求）：**鞋子不写进"保持不变"**。
 * 批量换装走的是半身图，画面里根本没有鞋子，写"图1的鞋子保持不变"会让模型去补一双鞋。
 * 所以保持句只在上装/下装之间取未选项；只选了鞋子时，保持句只写"图1的上装和下装保持不变。"。
 */
export function outfitKeepText(intent) {
  const normalized = normalizeOutfitIntent(intent);
  if (normalized.parts.length === 0) return "";
  const labels = OUTFIT_KEEP_PART_VALUES
    .filter((part) => !normalized.parts.includes(part))
    .map((part) => partLabel(part));
  if (labels.length === 0) return "";
  return `图1的${joinChinese(labels, "和")}保持不变。`;
}

/** 【穿法状态】：跟随图2 / 常规自然穿着 / 自定义锁定。 */
export function outfitWearingText(intent) {
  const normalized = normalizeOutfitIntent(intent);
  const mode = normalized.wearing.mode;
  if (mode === "natural") return "穿法按常规自然穿着，不刻意复刻图2的穿法细节。";
  if (mode === "custom") {
    const allowed = visibleWearingFields(normalized);
    const lines = allowed
      .map((field) => {
        const value = normalized.wearing.values[field.key];
        const option = field.options.find((item) => item.value === value);
        return option ? option.prompt : "";
      })
      .filter(Boolean);
    return lines.length ? `${lines.join("；")}。` : "";
  }
  return "穿法跟随图2，不自行改变扣合、衣摆、袖子和领口状态。";
}

/** 【图2服装事实】：只保留本次选中部位相关的事实，且去掉已被自定义穿法覆盖的字段。 */
export function outfitFactsText(intent) {
  const normalized = normalizeOutfitIntent(intent);
  if (normalized.parts.length === 0) return "";
  const superseded = new Set();
  if (normalized.wearing.mode === "custom") {
    Object.entries(WEARING_FIELD_SUPERSEDES_FACT).forEach(([fieldKey, factKeys]) => {
      if (normalized.wearing.values[fieldKey]) factKeys.forEach((key) => superseded.add(key));
    });
  }
  const lines = OUTFIT_FACT_FIELDS
    .filter((field) => field.parts.some((part) => normalized.parts.includes(part)))
    .filter((field) => !superseded.has(field.key))
    .map((field) => {
      const value = asText(normalized.facts[field.key], 160);
      if (!value) return "";
      return `${field.label}：${value}`;
    })
    .filter(Boolean);
  return lines.join("；");
}

/**
 * 唯一入口：把结构化意图 + 用户输入编译成最终提示词。
 *
 * @param {object} options
 *   intent           结构化换装意图
 *   userPrompt       用户原始输入（原样保留，不裁剪、不加固定句）
 *   poseAnchorPrompt 智能介入生成的姿态锚点（服务端才有；前端预览为空）
 *   productNote      场景补充
 * @returns {{prompt, sections, autoChars, chars, warnings, targets, keep, wearing, facts}}
 */
export function compileOutfitPrompt(options = {}) {
  const intent = normalizeOutfitIntent(options.intent);
  const warnings = [];
  const layer = resolveUpperLayer(intent);
  const targets = outfitTargetText(intent);
  const keep = outfitKeepText(intent);
  const wearing = outfitWearingText(intent);
  const facts = outfitFactsText(intent);

  if (intent.parts.length === 0) warnings.push("请至少选择一个更换部位");
  if (intent.parts.includes("upper") && layer.uncertain) {
    warnings.push("图2上装层级未识别，请在「上装层级」里手动确认（自动识别不会替你猜内搭/外套）");
  }
  if (intent.parts.includes("upper") && intent.upperLayer === "inner-outer") {
    const factsText = [intent.facts.category, intent.facts.structure].map((item) => asText(item)).join(" ");
    const recognized = factsText && !/^未识别/.test(factsText);
    if (recognized && !INNER_OUTER_PATTERN.test(factsText)) {
      warnings.push("已选择「内搭+外套」，但图2只识别到一件上装，请确认层级是否真的有两层");
    }
  }

  const userBlocks = [asText(options.userPrompt, 20000), asText(options.poseAnchorPrompt, 4000), asText(options.productNote, 4000)]
    .filter(Boolean);

  const sections = [];
  if (userBlocks.length) sections.push({ id: "user", title: "【用户补充】", body: userBlocks.join("\n\n") });
  // 2026-09-26（按用户要求）：换装目标句很短，合成**一排**，不再换行。
  const targetBody = [targets, keep].filter(Boolean).join("");
  if (targetBody) sections.push({ id: "target", title: "【本次换装目标】", body: targetBody });
  if (facts) sections.push({ id: "facts", title: "【图2服装事实】", body: facts });
  if (wearing) sections.push({ id: "wearing", title: "【穿法状态】", body: wearing });
  sections.push({ id: "baseline", title: "【人物基准】", body: OUTFIT_PERSON_BASELINE });

  // 2026-09-26（按用户要求）：发给模型的是**纯正文**，不带【本次换装目标】【穿法状态】这类小标题 ——
  // 标题只是界面上的分区说明，不该占提示词。顺序仍然保持需求规定的顺序。
  // `sections` 仍带 title，只给界面/测试看结构，不进入 prompt。
  const prompt = sections.map((section) => section.body).join("\n\n");
  const autoChars = sections
    .filter((section) => section.id !== "user")
    .reduce((sum, section) => sum + section.body.length, 0);
  if (autoChars > OUTFIT_AUTO_PROMPT_CHAR_LIMIT) {
    warnings.push(`自动内容约 ${autoChars} 字，超过建议上限 ${OUTFIT_AUTO_PROMPT_CHAR_LIMIT} 字`);
  }
  return {
    prompt,
    sections,
    targets,
    keep,
    wearing,
    facts,
    autoChars,
    chars: prompt.length,
    warnings
  };
}

/** 提交按钮旁的一行摘要：本次替换 / 保持 / 穿法。 */
export function summarizeOutfitIntent(intent) {
  const normalized = normalizeOutfitIntent(intent);
  const layer = resolveUpperLayer(normalized);
  const parts = normalized.parts;
  const upperPhrases = [];
  if (parts.includes("upper")) {
    if (layer.value === "inner-outer") {
      if (parts.length === 1) upperPhrases.push("内搭+外套");
      else upperPhrases.push("内搭", "外套");
    } else {
      upperPhrases.push(layer.promptLabel);
    }
  }
  const phrases = [
    ...upperPhrases,
    ...OUTFIT_PART_VALUES.filter((part) => part !== "upper" && parts.includes(part)).map((part) => partLabel(part))
  ];
  const replaceText = phrases.length ? phrases.join("、") : "未选择";
  // 保持列表同样不含鞋子（半身图没有鞋子，界面上也别显示"保持鞋子"）。
  const untouched = OUTFIT_KEEP_PART_VALUES.filter((part) => !parts.includes(part));
  const keepText = untouched.length ? untouched.map((part) => partLabel(part)).join("、") : "无";
  const wearingText = WEARING_MODE_OPTIONS.find((item) => item.value === normalized.wearing.mode)?.label || "";
  return { replaceText, keepText, wearingText };
}
