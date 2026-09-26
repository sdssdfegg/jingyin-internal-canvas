// 批量换装「结构化意图 + 精简提示词编译器」轻量断言。
//
// 覆盖需求第十节的编译器侧验证项：部位七种组合、上装层级三种文字、保持句只在未选部位出现、
// 三项全选没有多余保持句、通用自动规则开关不影响换装目标、自定义穿法真实进入提示词、
// 图2事实只插所选部位、同一信息不重复三遍、旧存档字段安全、非法枚举能被校验拦下、字符数上限。
//
// 纯逻辑，不起服务、不联网、不扣费。
// 用法：node scripts/verify/outfit-intent-check.mjs
import process from "node:process";
import {
  OUTFIT_AUTO_PROMPT_CHAR_LIMIT,
  OUTFIT_PERSON_BASELINE,
  compileOutfitPrompt,
  defaultOutfitIntent,
  normalizeOutfitIntent,
  outfitFactsText,
  outfitTargetText,
  recognizedFactKeys,
  resolveUpperLayer,
  summarizeOutfitIntent,
  validateOutfitIntent,
  visibleWearingFields
} from "../../src/shared/outfit-intent.js";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

function intent(patch = {}) {
  return normalizeOutfitIntent({
    parts: ["upper"],
    ...patch,
    wearing: { mode: "follow", values: {}, ...(patch.wearing || {}) },
    facts: patch.facts || {}
  });
}

function targetOf(patch) {
  return outfitTargetText(intent(patch));
}

function compiled(patch, options = {}) {
  return compileOutfitPrompt({ intent: intent(patch), userPrompt: options.userPrompt || "", ...options });
}

// —— 1) 七种部位组合的目标句
const combos = [
  { parts: ["upper"], target: "让图1模特穿着图2的上装。", keep: "图1的下装和鞋子保持不变。" },
  { parts: ["lower"], target: "让图1模特穿着图2的下装。", keep: "图1的上装和鞋子保持不变。" },
  { parts: ["shoes"], target: "让图1模特穿着图2的鞋子。", keep: "图1的上装和下装保持不变。" },
  { parts: ["upper", "lower"], target: "让图1模特穿着图2的上装和下装。", keep: "图1的鞋子保持不变。" },
  { parts: ["upper", "shoes"], target: "让图1模特穿着图2的上装和鞋子。", keep: "图1的下装保持不变。" },
  { parts: ["lower", "shoes"], target: "让图1模特穿着图2的下装和鞋子。", keep: "图1的上装保持不变。" },
  { parts: ["upper", "lower", "shoes"], target: "让图1模特穿着图2的上装、下装和鞋子。", keep: "" }
];
combos.forEach((item) => {
  const actualTarget = targetOf({ parts: item.parts, upperLayer: "single" });
  check(`组合 ${item.parts.join("+")} 目标句正确`, actualTarget === item.target, actualTarget);
  const actualKeep = compiled({ parts: item.parts, upperLayer: "single" }).keep;
  check(`组合 ${item.parts.join("+")} 保持句正确`, actualKeep === item.keep, actualKeep || "(空)");
});

// —— 2) 三项全选时没有多余"保持不变"
check("三项全选没有多余保持句",
  !compiled({ parts: ["upper", "lower", "shoes"], upperLayer: "single" }).prompt.includes("保持不变"),
  compiled({ parts: ["upper", "lower", "shoes"], upperLayer: "single" }).targets);

// —— 3) 上装层级生成不同且准确的文字
const layers = {
  single: "让图1模特穿着图2的上装。",
  inner: "让图1模特穿着图2的内搭。",
  outer: "让图1模特穿着图2的外套。",
  "inner-outer": "让图1模特穿着图2的内搭和外套。"
};
Object.entries(layers).forEach(([value, expected]) => {
  const actual = targetOf({ parts: ["upper"], upperLayer: value });
  check(`上装层级 ${value} 文字准确`, actual === expected, actual);
});
check("内搭/外套/内搭+外套三种文字互不相同",
  new Set([layers.inner, layers.outer, layers["inner-outer"]]).size === 3);

// —— 3b) 需求里给出的那条完整原文
const required = compiled({ parts: ["upper"], upperLayer: "inner-outer" });
check("『内搭+外套、下装不变、鞋子不变』完整原文与需求一致",
  required.prompt === [
    "【本次换装目标】",
    "让图1模特穿着图2的内搭和外套。",
    "图1的下装和鞋子保持不变。",
    "",
    "【穿法状态】",
    "穿法跟随图2，不自行改变扣合、衣摆、袖子和领口状态。",
    "",
    "【人物基准】",
    OUTFIT_PERSON_BASELINE
  ].join("\n"),
  JSON.stringify(required.prompt));

// —— 4) 人物基准只出现一次
const once = compiled({ parts: ["upper", "lower"], upperLayer: "single" });
check("人物基准只出现一次", once.prompt.split(OUTFIT_PERSON_BASELINE).length - 1 === 1);

// —— 5) 通用自动规则开关（智能介入 / 旧 SKILL）开关不影响换装目标
const skillOff = compileOutfitPrompt({ intent: intent({ parts: ["upper"], upperLayer: "inner-outer" }), userPrompt: "用户原话" });
const skillOn = compileOutfitPrompt({
  intent: intent({ parts: ["upper"], upperLayer: "inner-outer" }),
  userPrompt: "用户原话",
  poseAnchorPrompt: "姿态锚点：保持图1站姿"
});
check("SKILL/智能介入关闭时换装目标仍在",
  skillOff.prompt.includes("让图1模特穿着图2的内搭和外套。"),
  skillOff.targets);
check("SKILL/智能介入开与关，换装目标完全相同",
  skillOff.targets === skillOn.targets && skillOff.keep === skillOn.keep && skillOff.wearing === skillOn.wearing);
check("用户原话原样保留",
  skillOff.prompt.includes("【用户补充】\n用户原话") && skillOn.prompt.includes("用户原话"));

// —— 6) 自定义穿法真实进入提示词
const custom = compiled({
  parts: ["upper", "lower"],
  upperLayer: "outer",
  facts: { closure: "有门襟扣子", hem: "衣摆外穿", sleeveState: "袖子放下" },
  wearing: {
    mode: "custom",
    values: {
      closure: "open",
      outerState: "half",
      hem: "front-half",
      sleeve: "forearm",
      collar: "stand",
      fit: "loose",
      waistband: "high",
      lowerHem: "cuffed"
    }
  }
});
[
  ["门襟全开", "扣合状态"],
  ["外套半敞开", "外套状态"],
  ["衣摆前侧半扎、后摆放出", "衣摆"],
  ["袖子推至前臂", "袖子"],
  ["衣领立起", "衣领"],
  ["版型宽松", "版型"],
  ["下装为高腰", "腰头"],
  ["裤脚挽边", "裤脚/裙摆"]
].forEach(([text, label]) => {
  check(`自定义${label}进入最终提示词`, custom.prompt.includes(text), text);
});

// —— 6b) 字段按部位动态出现：鞋子没有衣领/袖子，下装只有腰头/裤脚
const shoeFields = visibleWearingFields(intent({ parts: ["shoes"] })).map((field) => field.key);
check("鞋子不出现衣领、袖子", !shoeFields.includes("collar") && !shoeFields.includes("sleeve"), shoeFields.join(","));
const lowerFields = visibleWearingFields(intent({ parts: ["lower"] })).map((field) => field.key);
check("下装只出现腰头与裤脚/裙摆",
  lowerFields.length === 2 && lowerFields.includes("waistband") && lowerFields.includes("lowerHem"),
  lowerFields.join(","));
const plainFields = visibleWearingFields(intent({
  parts: ["upper"],
  factsSource: { mode: "auto", sourceId: "c1" },
  facts: { closure: "未识别", category: "针织圆领上衣", structure: "罗纹收口" }
})).map((field) => field.key);
check("普通无扣上衣不强制出现扣子设置", !plainFields.includes("closure"), plainFields.join(","));
const layeredFields = visibleWearingFields(intent({ parts: ["upper"], upperLayer: "inner-outer" })).map((field) => field.key);
check("内搭+外套时出现外套状态", layeredFields.includes("outerState"), layeredFields.join(","));
const innerFields = visibleWearingFields(intent({ parts: ["upper"], upperLayer: "inner" })).map((field) => field.key);
check("仅内搭时不出现外套状态", !innerFields.includes("outerState"), innerFields.join(","));

// —— 7) 图2事实只插入所选部位
const factsIntent = intent({
  parts: ["upper"],
  upperLayer: "single",
  facts: {
    category: "衬衫",
    color: "白色",
    material: "棉",
    length: "过腰",
    lowerType: "直筒牛仔裤",
    shoeType: "白色运动鞋",
    hem: "衣摆外穿"
  }
});
const upperFacts = outfitFactsText(factsIntent);
check("只选上装时事实不含下装/鞋子", !upperFacts.includes("直筒牛仔裤") && !upperFacts.includes("白色运动鞋"), upperFacts);
check("只选上装时事实包含上装项", upperFacts.includes("衬衫") && upperFacts.includes("白色") && upperFacts.includes("棉"), upperFacts);
const lowerFacts = outfitFactsText(intent({ parts: ["lower"], facts: factsIntent.facts }));
check("只选下装时事实只含下装项",
  lowerFacts.includes("直筒牛仔裤") && !lowerFacts.includes("衬衫") && !lowerFacts.includes("白色运动鞋"),
  lowerFacts);
check("未分析时事实段整段省略", compiled({ parts: ["upper"] }).prompt.includes("【图2服装事实】") === false);

// —— 8) 同一信息不重复三遍
const dedupe = compileOutfitPrompt({
  intent: intent({
    parts: ["upper"],
    upperLayer: "single",
    facts: { closure: "有门襟扣子", hem: "衣摆外穿", sleeveState: "袖子放下" },
    wearing: { mode: "custom", values: { closure: "open", hem: "out", sleeve: "down" } }
  }),
  userPrompt: ""
});
check("自定义穿法覆盖后，图2事实不再重复扣合/衣摆/袖子",
  !dedupe.facts.includes("门襟") && !dedupe.facts.includes("衣摆") && !dedupe.facts.includes("袖子"),
  dedupe.facts || "(空)");
check("『保持不变』句只出现一次",
  dedupe.prompt.split("保持不变").length - 1 === 1);
check("『人物基准』句只出现一次",
  dedupe.prompt.split(OUTFIT_PERSON_BASELINE).length - 1 === 1);

// —— 8b) 全部自动内容长度不超过建议上限
const longest = compiled({
  parts: ["upper", "lower", "shoes"],
  upperLayer: "inner-outer",
  facts: {
    category: "外套+内搭两层，外套为短款夹克，内搭为圆领针织",
    color: "外套深卡其，内搭米白，下装黑色，鞋子白色",
    material: "外套棉质斜纹，内搭细针织，下装牛仔，鞋子皮革",
    silhouette: "外套宽松直筒，下装合体",
    length: "外套到腰下，下装到脚踝，鞋子低帮",
    collarSleeve: "外套翻领，袖长到腕骨，内搭圆领",
    sleeveState: "外套袖子自然放下，袖口落在腕骨",
    closure: "外套前襟四颗扣子全扣，内搭无扣",
    hem: "外套衣摆自然放出，内搭衣摆扎入下装",
    lowerType: "直筒长裤，裤脚平齐",
    shoeType: "低帮系带运动鞋",
    structure: "外套有口袋盖和袖口袢带，下装侧缝明显"
  }
});
check(`最长一组自动内容 ≤ ${OUTFIT_AUTO_PROMPT_CHAR_LIMIT} 字（实测 ${longest.autoChars}）`,
  longest.autoChars <= OUTFIT_AUTO_PROMPT_CHAR_LIMIT,
  `autoChars=${longest.autoChars}`);
check("超长时给出可读提示",
  longest.warnings.some((item) => /超过建议上限/.test(item)) === (longest.autoChars > OUTFIT_AUTO_PROMPT_CHAR_LIMIT),
  longest.warnings.join(" / "));

// —— 9) 提交前检查与摘要
const emptyCheck = validateOutfitIntent({ parts: [] });
check("未选部位时校验不通过并给出中文原因",
  emptyCheck.ok === false && emptyCheck.errors.some((item) => /至少选择一个更换部位/.test(item)),
  emptyCheck.errors.join(" / "));
const badCheck = validateOutfitIntent({ parts: ["upper", "hat"], upperLayer: "大袄", wearing: { mode: "随缘", values: { closure: "半扣" } } });
check("非法部位/层级/穿法模式/穿法取值都能被拦下",
  badCheck.ok === false
  && badCheck.errors.some((item) => /非法的更换部位/.test(item))
  && badCheck.errors.some((item) => /非法的上装层级/.test(item))
  && badCheck.errors.some((item) => /非法的穿法模式/.test(item))
  && badCheck.errors.some((item) => /非法的扣合状态取值/.test(item)),
  badCheck.errors.join(" / "));
const okCheck = validateOutfitIntent(intent({ parts: ["upper", "lower"] }));
check("合法意图校验通过", okCheck.ok === true, okCheck.errors.join(" / "));
const summary = summarizeOutfitIntent(intent({ parts: ["upper"], upperLayer: "inner-outer" }));
check("提交按钮摘要文案正确",
  summary.replaceText === "内搭+外套" && summary.keepText === "下装、鞋子" && summary.wearingText === "跟随图2穿法",
  JSON.stringify(summary));

// —— 10) 自动识别层级：由图2事实决定；识别不出来不瞎猜
const autoInnerOuter = resolveUpperLayer(intent({ parts: ["upper"], upperLayer: "auto", facts: { category: "外套+内搭两层" } }));
check("自动识别：事实有两层时判为内搭+外套",
  autoInnerOuter.value === "inner-outer" && autoInnerOuter.uncertain === false, JSON.stringify(autoInnerOuter));
const autoOuter = resolveUpperLayer(intent({ parts: ["upper"], upperLayer: "auto", facts: { category: "长款风衣" } }));
check("自动识别：事实是外套时判为外套", autoOuter.value === "outer", JSON.stringify(autoOuter));
const autoUnknown = resolveUpperLayer(intent({ parts: ["upper"], upperLayer: "auto", facts: {} }));
check("自动识别：没有事实时不猜层级并标记不确定",
  autoUnknown.uncertain === true && autoUnknown.resolvedBy === "fallback", JSON.stringify(autoUnknown));
check("识别不确定时给出提示",
  compiled({ parts: ["upper"], upperLayer: "auto" }).warnings.some((item) => /层级未识别/.test(item)),
  compiled({ parts: ["upper"], upperLayer: "auto" }).warnings.join(" / "));

// —— 10b) 选了内搭+外套但事实只有一件 → 提示确认
const mismatch = compiled({ parts: ["upper"], upperLayer: "inner-outer", facts: { category: "单件针织上衣" } });
check("内搭+外套 与 图2只有一件 冲突时提示确认",
  mismatch.warnings.some((item) => /只识别到一件上装/.test(item)),
  mismatch.warnings.join(" / "));

// —— 11) 旧存档字段安全：旧 garmentComposition/garmentLengths 存在也不会覆盖新选择、不会抛错
const legacy = normalizeOutfitIntent({
  parts: ["lower"],
  upperLayer: "outer",
  garmentParts: ["upper", "lower"],
  garmentComposition: "outfit-set",
  garmentLengths: { upper: "knee", lower: "ankle" },
  masterFitSpec: "旧的母版规格整段文本",
  masterFitLock: true
});
check("旧存档字段被安全忽略（不覆盖新意图、不抛错）",
  legacy.parts.length === 1 && legacy.parts[0] === "lower" && legacy.upperLayer === "outer",
  JSON.stringify(legacy.parts));
check("旧 garmentComposition/garmentLengths 不再进入意图",
  !("garmentComposition" in legacy) && !("garmentLengths" in legacy) && !("masterFitSpec" in legacy));
check("默认意图是未选任何部位",
  defaultOutfitIntent().parts.length === 0 && defaultOutfitIntent().wearing.mode === "follow");

// —— 12) 结构化对象不会变成 [object Object]
const weird = compileOutfitPrompt({ intent: { parts: ["upper"], upperLayer: "single", facts: { category: { a: 1 } } } });
check("结构化对象不会被拼成 [object Object]",
  !weird.prompt.includes("[object Object]"), weird.prompt.slice(0, 120));

// —— 13) 事实未识别标记
const recognized = recognizedFactKeys({ category: "衬衫", color: "未识别", material: "", hem: "衣摆外穿" });
check("未识别字段不算已识别",
  recognized.includes("category") && recognized.includes("hem") && !recognized.includes("color") && !recognized.includes("material"),
  recognized.join(","));

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((item) => ({ name: item.name, detail: item.detail })),
  longestAutoChars: longest.autoChars,
  requiredPrompt: required.prompt
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
