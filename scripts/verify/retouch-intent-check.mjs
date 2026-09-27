// 服装精修「结构化意图 + 唯一精简提示词编译器」轻量断言（纯逻辑，不起服务、不联网、不扣费）。
//
// 覆盖需求第七节的编译器侧验证项：
//   对称两种、衣摆三种、版型四种分别生成正确指令；默认"跟随原图"不强制改动；
//   用户补充只出现一次；内置默认词不会被当成用户补充重复塞；字符数上限；
//   旧字段/对象值不会变成 [object Object]；非法枚举与版本能被校验拦下。
//
// 用法：node scripts/verify/retouch-intent-check.mjs
import process from "node:process";
import {
  RETOUCH_AUTO_PROMPT_CHAR_LIMIT,
  RETOUCH_CLEANUP_TEXT,
  RETOUCH_GOAL_TEXT,
  compileRetouchPrompt,
  defaultRetouchIntent,
  isBuiltinRetouchPrompt,
  normalizeRetouchIntent,
  summarizeRetouchIntent,
  validateRetouchIntent,
  WHITE_REFINE_DEFAULT_PROMPT
} from "../../src/shared/retouch-intent.js";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}
const compiled = (intentPatch = {}, options = {}) => compileRetouchPrompt({
  intent: normalizeRetouchIntent(intentPatch),
  ...options
});

// ---------- 1) 默认意图 ----------
const fallback = defaultRetouchIntent();
check("默认意图：版本 1 / 关闭对称 / 衣摆跟随原图 / 版型跟随原图 / 无补充",
  fallback.version === 1
    && fallback.symmetry === "off"
    && fallback.hemTreatment === "follow_original"
    && fallback.fit === "follow_original"
    && fallback.customPrompt === "",
  JSON.stringify(fallback));

// ---------- 2) 固定精修目标包含需求里的八项 ----------
const base = compiled();
[
  ["干净的服装白底精修图", "生成干净白底精修图"],
  ["去除明显褶皱", "去褶皱"],
  ["横平竖直", "细节横平竖直"],
  ["保持服装原有款式、颜色、面料、纹理、缝线、扣子、口袋", "保持原细节"],
  ["不创新、不凭空增加细节、不改变服装设计", "不创新"],
  ["去掉衣架、夹子、大头针和固定服装的其他物品", "去衣架/固定物"],
  ["不偏色", "不偏色"],
  ["修正服装外轮廓，使轮廓平滑、连续、自然", "轮廓平滑"]
].forEach(([needle, label]) => {
  check(`固定目标包含「${label}」`, base.prompt.includes(needle), needle);
});
check("横平竖直明确带限制：不强行拉直褶裥/弧线/波浪边/不对称",
  /不把原本有意的褶裥、弧线、波浪边和不对称设计强行拉直/.test(base.prompt));
check("固定目标与清理段各只出现一次",
  base.prompt.split(RETOUCH_GOAL_TEXT).length - 1 === 1
    && base.prompt.split(RETOUCH_CLEANUP_TEXT).length - 1 === 1);
check("分段顺序是 目标 → 清理与轮廓 → 结构事实",
  base.sections.map((section) => section.id).join(",") === "goal,cleanup,structure",
  base.sections.map((section) => section.id).join(","));
check("没有用户补充时不出现【用户补充】段", !base.prompt.includes("【用户补充】"));

// ---------- 3) 对称 ----------
const symmetryOff = compiled({ symmetry: "off" });
const symmetryOn = compiled({ symmetry: "on" });
check("关闭对称：明确禁止强行对称并保留原始不对称",
  /关闭对称/.test(symmetryOff.prompt) && /保留原图中真实的左右不对称细节/.test(symmetryOff.prompt)
    && /不要强行把服装做成对称/.test(symmetryOff.prompt),
  symmetryOff.structure);
check("开启服装对称：只调服装左右结构、不动人物与款式",
  /开启服装对称/.test(symmetryOn.prompt)
    && /只调整服装左右结构/.test(symmetryOn.prompt)
    && /不改变人物身体、脸、姿势和服装款式/.test(symmetryOn.prompt),
  symmetryOn.structure);
check("对称开与关生成不同指令", symmetryOff.prompt !== symmetryOn.prompt);

// ---------- 4) 衣摆或裙摆 ----------
const hemFollow = compiled({ hemTreatment: "follow_original" });
const hemStraight = compiled({ hemTreatment: "straight" });
const hemWave = compiled({ hemTreatment: "natural_wave" });
check("衣摆跟随原图：只写跟随原图", /衣摆或裙摆：跟随原图。/.test(hemFollow.prompt), hemFollow.structure);
check("衣摆跟随原图：不出现平直/自然波浪指令",
  !hemFollow.prompt.includes("衣摆或裙摆：平直") && !hemFollow.prompt.includes("自然波浪"), hemFollow.structure);
check("衣摆平直：写入平直指令且保住开衩褶裥设计线",
  /衣摆或裙摆：平直/.test(hemStraight.prompt) && /不要抹掉原有的开衩、褶裥和设计线/.test(hemStraight.prompt),
  hemStraight.structure);
check("衣摆自然波浪：写入波浪指令且不制造夸张褶皱",
  /衣摆或裙摆：自然波浪/.test(hemWave.prompt) && /不要凭空制造夸张褶皱/.test(hemWave.prompt),
  hemWave.structure);
check("衣摆三种状态互不相同",
  new Set([hemFollow.prompt, hemStraight.prompt, hemWave.prompt]).size === 3);

// ---------- 5) 版型 ----------
const fitFollow = compiled({ fit: "follow_original" });
const fitStraight = compiled({ fit: "straight" });
const fitWaisted = compiled({ fit: "waisted" });
const fitLoose = compiled({ fit: "loose" });
check("版型跟随原图：只写跟随原图", /版型：跟随原图。/.test(fitFollow.prompt), fitFollow.structure);
check("版型跟随原图：不出现直筒/收腰/宽松",
  !/版型：(直筒|收腰|宽松)/.test(fitFollow.prompt), fitFollow.structure);
check("版型直筒写入正确指令", /版型：直筒/.test(fitStraight.prompt), fitStraight.structure);
check("版型收腰写入正确指令", /版型：收腰/.test(fitWaisted.prompt), fitWaisted.structure);
check("版型宽松写入正确指令", /版型：宽松/.test(fitLoose.prompt), fitLoose.structure);
check("版型四种状态互不相同",
  new Set([fitFollow.prompt, fitStraight.prompt, fitWaisted.prompt, fitLoose.prompt]).size === 4);
check("改版型时说明不改款式/长度/细节",
  /版型：直筒，把服装修成直筒轮廓，不改变款式、长度和细节设计。/.test(fitStraight.prompt), fitStraight.structure);

// ---------- 6) 默认「跟随原图」不会强制改变原服装 ----------
const defaultPromptText = compiled().prompt;
check("默认状态不出现任何主动改变指令",
  !/平直/.test(defaultPromptText)
    && !/自然波浪/.test(defaultPromptText)
    && !/版型：(直筒|收腰|宽松)/.test(defaultPromptText)
    && !/开启服装对称/.test(defaultPromptText),
  compiled().structure);
check("默认状态明确保留原图不对称细节", /关闭对称/.test(defaultPromptText));

// ---------- 7) 用户补充只出现一次 + 内置默认词不重复塞 ----------
const withCustom = compiled({ customPrompt: "背景保持纯白，保留吊牌" });
check("用户补充只出现一次",
  withCustom.prompt.split("背景保持纯白，保留吊牌").length - 1 === 1,
  withCustom.prompt.slice(0, 80));
check("用户补充段排在最前面",
  withCustom.prompt.startsWith("【用户补充】\n背景保持纯白，保留吊牌"), withCustom.prompt.slice(0, 60));
const withPagePrompt = compileRetouchPrompt({
  intent: fallback,
  userPrompt: "我自己写的顾客要求：去掉吊牌线头",
  productNote: "场景补充：不要补光斑"
});
check("页面提示词 + 场景补充都算用户内容且各出现一次",
  withPagePrompt.prompt.split("我自己写的顾客要求：去掉吊牌线头").length - 1 === 1
    && withPagePrompt.prompt.split("场景补充：不要补光斑").length - 1 === 1);
check("内置默认词不会被当成用户补充重复塞进提示词",
  isBuiltinRetouchPrompt(WHITE_REFINE_DEFAULT_PROMPT)
    && !compileRetouchPrompt({ intent: fallback, userPrompt: WHITE_REFINE_DEFAULT_PROMPT }).prompt.includes("多图生图"),
  compileRetouchPrompt({ intent: fallback, userPrompt: WHITE_REFINE_DEFAULT_PROMPT }).prompt.slice(0, 40));
check("空的页面提示词也不会产生空段落",
  compileRetouchPrompt({ intent: fallback, userPrompt: "   ", productNote: "" }).prompt.startsWith("【服装精修目标】"));

// ---------- 8) 字符数 ----------
const longest = compileRetouchPrompt({
  intent: { symmetry: "on", hemTreatment: "natural_wave", fit: "waisted", customPrompt: "补".repeat(200) },
  userPrompt: "用户".repeat(50)
});
check(`自动内容 ≤ ${RETOUCH_AUTO_PROMPT_CHAR_LIMIT} 字（实测 ${longest.autoChars}）`,
  longest.autoChars <= RETOUCH_AUTO_PROMPT_CHAR_LIMIT, `autoChars=${longest.autoChars}`);
check("超长自动内容会给出提示（仅提示，不阻断）",
  longest.warnings.some((item) => /超过建议上限/.test(item)) === (longest.autoChars > RETOUCH_AUTO_PROMPT_CHAR_LIMIT),
  longest.warnings.join(" / "));
check("超过补充长度上限会提示",
  compiled({ customPrompt: "补".repeat(1200) }).warnings.some((item) => /用户补充超过/.test(item)));

// ---------- 9) 校验：非法枚举 / 版本 ----------
check("合法默认意图通过校验", validateRetouchIntent(defaultRetouchIntent()).ok);
[
  ["版本不支持", { version: 2 }],
  ["非法对称", { symmetry: "maybe" }],
  ["非法衣摆", { hemTreatment: "curly" }],
  ["非法版型", { fit: "oversize-plus" }],
  ["用户补充不是文本", { customPrompt: { text: "x" } }]
].forEach(([label, patch]) => {
  const result = validateRetouchIntent({ ...defaultRetouchIntent(), ...patch });
  check(`${label} → 校验失败并给出中文原因`,
    !result.ok && result.errors.length > 0,
    `${result.ok} ${result.errors.join(" / ")}`);
});
check("缺失意图对象也返回可读原因", validateRetouchIntent(null).errors[0] === "缺少精修意图");

// ---------- 10) 绝不出现 [object Object] ----------
const dirty = normalizeRetouchIntent({
  version: 1,
  symmetry: { value: "on" },
  hemTreatment: ["straight"],
  fit: 3,
  customPrompt: { nested: true },
  legacySkill: "旧 SKILL 整段文本"
});
check("对象/数组/数字取值被安全归一（不抛错、不留脏值）",
  dirty.symmetry === "off" && dirty.hemTreatment === "follow_original" && dirty.fit === "follow_original" && dirty.customPrompt === "",
  JSON.stringify(dirty));
check("编译结果里没有 [object Object]",
  !compileRetouchPrompt({ intent: dirty }).prompt.includes("[object Object]"));
check("旧字段不进入意图对象",
  !("legacySkill" in dirty));

// ---------- 11) 摘要 ----------
const summary = summarizeRetouchIntent({ symmetry: "off", hemTreatment: "follow_original", fit: "straight" });
check("摘要文案正确（白底精修｜对称：关闭｜衣摆：跟随原图｜版型：直筒）",
  summary.symmetryText === "关闭对称" && summary.hemText === "跟随原图" && summary.fitText === "直筒",
  JSON.stringify(summary));

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  longestAutoChars: longest.autoChars,
  defaultPrompt: compiled().prompt,
  failures: failed.map((item) => ({ name: item.name, detail: item.detail }))
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
