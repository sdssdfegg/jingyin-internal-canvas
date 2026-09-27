// 服装精修「结构化意图 + 唯一精简提示词编译器」轻量断言（纯逻辑，不起服务、不联网、不扣费）。
//
// 覆盖需求第七节的编译器侧验证项：
//   对称两种、衣摆三种、版型四种分别生成正确指令；默认"跟随原图"不强制改动；
//   用户补充只出现一次；内置默认词不会被当成用户补充重复塞；字符数上限；
//   旧字段/对象值不会变成 [object Object]；非法枚举与版本能被校验拦下。
//
// 用法：node scripts/verify/retouch-intent-check.mjs
import process from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
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
const CLIENT = path.join(process.cwd(), "src", "outfit-workflow.jsx");
const CSS = path.join(process.cwd(), "src", "features", "outfit", "retouch-intent.css");
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
check("分段顺序是 目标 → 清理与轮廓 → 结构要求",
  base.sections.map((section) => section.id).join(",") === "goal,cleanup,structure",
  base.sections.map((section) => section.id).join(","));
check("没有用户补充时不出现【用户补充】段", !base.prompt.includes("【用户补充】"));

// ---------- 2b) 提示词里不写"状态说明"，只写给模型的指令 ----------
check("提示词里不出现「关闭对称/开启服装对称/跟随原图/平直/自然波浪」这类状态标签",
  !/关闭对称|开启服装对称|对称：|衣摆或裙摆：|版型：|跟随原图/.test(base.prompt),
  base.prompt.slice(-120));
check("结构段只写指令：关闭对称写成『保留原图真实的左右不对称细节，不要强行做成对称』",
  base.structure === "保留原图中真实的左右不对称细节，不要强行把服装做成对称。",
  JSON.stringify(base.structure));
check("选「跟随原图」的字段整行省略（不占字数、不说废话）",
  !base.prompt.includes("衣摆") && !base.prompt.includes("版型"),
  base.structure);

// ---------- 3) 对称 ----------
const symmetryOff = compiled({ symmetry: "off" });
const symmetryOn = compiled({ symmetry: "on" });
check("关闭对称：明确禁止强行对称并保留原始不对称",
  /保留原图中真实的左右不对称细节/.test(symmetryOff.prompt)
    && /不要强行把服装做成对称/.test(symmetryOff.prompt),
  symmetryOff.structure);
check("开启服装对称：只调服装左右结构、不动人物与款式",
  /把服装左右结构调成对称版型/.test(symmetryOn.prompt)
    && /不改变人物身体、脸、姿势和服装款式/.test(symmetryOn.prompt),
  symmetryOn.structure);
check("对称开与关生成不同指令", symmetryOff.prompt !== symmetryOn.prompt);

// ---------- 4) 衣摆或裙摆 ----------
const hemFollow = compiled({ hemTreatment: "follow_original" });
const hemStraight = compiled({ hemTreatment: "straight" });
const hemWave = compiled({ hemTreatment: "natural_wave" });
check("衣摆跟随原图：结构段不写任何衣摆内容",
  !/衣摆/.test(hemFollow.structure) && !/裙摆/.test(hemFollow.structure), JSON.stringify(hemFollow.structure));
check("衣摆平直：写入平直指令且保住开衩褶裥设计线",
  /把明显歪扭或摆放造成的衣摆、裙摆波浪拉平直/.test(hemStraight.prompt) && /不要抹掉原有的开衩、褶裥和设计线/.test(hemStraight.prompt),
  hemStraight.structure);
check("衣摆自然波浪：写入波浪指令且不制造夸张褶皱",
  /衣摆或裙摆保持自然垂落的波浪/.test(hemWave.prompt) && /不要凭空制造夸张褶皱/.test(hemWave.prompt),
  hemWave.structure);
check("衣摆三种状态互不相同",
  new Set([hemFollow.prompt, hemStraight.prompt, hemWave.prompt]).size === 3);

// ---------- 5) 版型 ----------
const fitFollow = compiled({ fit: "follow_original" });
const fitStraight = compiled({ fit: "straight" });
const fitWaisted = compiled({ fit: "waisted" });
const fitLoose = compiled({ fit: "loose" });
check("版型跟随原图：结构段不写任何版型内容",
  !/版型/.test(fitFollow.structure), JSON.stringify(fitFollow.structure));
check("版型直筒写入正确指令", /把服装版型修成直筒轮廓/.test(fitStraight.prompt), fitStraight.structure);
check("版型收腰写入正确指令", /把服装版型修成收腰轮廓/.test(fitWaisted.prompt), fitWaisted.structure);
check("版型宽松写入正确指令", /把服装版型修成宽松轮廓/.test(fitLoose.prompt), fitLoose.structure);
check("版型四种状态互不相同",
  new Set([fitFollow.prompt, fitStraight.prompt, fitWaisted.prompt, fitLoose.prompt]).size === 4);
check("改版型时说明不改款式/长度/细节",
  /把服装版型修成直筒轮廓，不改变款式、长度和细节设计。/.test(fitStraight.prompt), fitStraight.structure);

// ---------- 6) 默认「跟随原图」不会强制改变原服装 ----------
const defaultPromptText = compiled().prompt;
check("默认状态不出现任何主动改变指令",
  !/平直/.test(defaultPromptText)
    && !/自然波浪/.test(defaultPromptText)
    && !/直筒|收腰|宽松/.test(defaultPromptText)
    && !/对称版型/.test(defaultPromptText),
  compiled().structure);
check("默认状态明确保留原图不对称细节", /不要强行把服装做成对称/.test(defaultPromptText));

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

// ---------- 11) 摘要（编译器提供；界面已按用户要求不再显示这一段） ----------
const summary = summarizeRetouchIntent({ symmetry: "off", hemTreatment: "follow_original", fit: "straight" });
check("摘要文案正确（白底精修｜对称：关闭｜衣摆：跟随原图｜版型：直筒）",
  summary.symmetryText === "关闭对称" && summary.hemText === "跟随原图" && summary.fitText === "直筒",
  JSON.stringify(summary));

// ---------- 12) 前端接线（源码级契约，防止后来改坏） ----------
const clientSource = readFileSync(CLIENT, "utf8");
const cssSource = readFileSync(CSS, "utf8");
const panelStart = clientSource.indexOf("function renderRetouchIntentPanel");
const panelEnd = clientSource.indexOf("function renderResultQueue", panelStart);
const panelSource = panelStart >= 0 && panelEnd > panelStart ? clientSource.slice(panelStart, panelEnd) : "";
check("精修设置面板只在精修页渲染，且包在整行的设置条里",
  /isWhiteRefineWorkflow && \(\s*<div className="retouchSettingsRow">\s*\{renderRetouchIntentPanel\(\)\}/.test(clientSource));
check("设置条占满整行（三组排成一条），下面才是提示词 + 用户补充并排",
  /withRetouch/.test(clientSource)
    && /\.retouchSettingsRow \{\s*grid-column: 1 \/ -1;/.test(cssSource)
    && /\.composerBody\.withRetouch \.composerPromptCol \{\s*grid-template-columns: minmax\(0, 1\.25fr\)/.test(cssSource));
check("提示词框改成定高 + 框内滑动（提示词长了用滑轮看，不撑高整页）",
  /retouchPromptLive/.test(clientSource)
    && /textarea\.retouchPromptLive \{[^}]*height: 168px/.test(cssSource)
    && /textarea\.retouchPromptLive \{[^}]*overflow-y: auto/.test(cssSource),
  "height:168px + overflow-y:auto");
check("精修设置面板样式是横向一条（flex + 居中），不再是三行 grid",
  /\.retouchIntentPanel \{\s*display: flex;\s*flex-wrap: wrap;\s*align-items: center;/.test(cssSource));
check("换装页布局不受影响（仍然用两栏 withIntent）",
  /isOutfitWorkflow \? "withIntent" : ""/.test(clientSource));
check("左侧面板只剩下三组选择按钮：没有标题/说明/摘要/预览/用户补充框",
  panelSource.length > 0
    && !/<header/.test(panelSource)
    && !/retouchIntentCount/.test(panelSource)
    && !/retouchIntentPreview/.test(panelSource)
    && !/retouchIntentCustom/.test(panelSource)
    && (panelSource.match(/retouchIntentChips/g) || []).length === 3,
  `chips=${(panelSource.match(/retouchIntentChips/g) || []).length}`);
check("左侧不再有「用户补充」输入框（已挪到右侧并改名）",
  !/retouchIntentCustom/.test(clientSource)
    && /isWhiteRefineWorkflow\s*\n?\s*\?\s*"用户补充"/.test(clientSource));
check("「通用白底精修提示词」由精修设置自动生成（与换装同一套逻辑）",
  /currentPrompt === retouchAutoPrompt/.test(clientSource)
    && /retouchPromptHandEditedRef\.current = true/.test(clientSource)
    && /按当前精修设置重新生成提示词/.test(clientSource));
check("旧的手写提示词会迁移进「用户补充」，不会丢",
  /isBuiltinRetouchPrompt\(currentPrompt\)/.test(clientSource)
    && /productNote: \[currentNote, currentPrompt\]/.test(clientSource));
check("迁移有防线：已经是编译器产出（含固定目标段）的内容不会再被搬进用户补充",
  /const looksCompiled = currentPrompt\.includes\(RETOUCH_GOAL_TEXT\)/.test(clientSource)
    && /!looksCompiled/.test(clientSource)
    && /currentPrompt\.length <= 6000/.test(clientSource),
  "防止越搬越长的回流（已实测踩过）");
check("精修页只渲染图1 一个上传区（图2 已按用户要求删除）",
  /!isWhiteRefineWorkflow && <div className="assetSide">/.test(clientSource));
const currentLabelsBlock = clientSource.slice(
  clientSource.indexOf("const WHITE_REFINE_UPLOAD_LABELS"),
  clientSource.indexOf("const OUTPAINT_UPLOAD_LABELS")
);
check("图1 上传区标题改成「图片上传」（图2 标题已说明不再使用）",
  /title: "图片上传"/.test(currentLabelsBlock) && /已不用/.test(currentLabelsBlock),
  currentLabelsBlock.slice(0, 120));
check("旧的两代精修标题都写进了迁移名单",
  /LEGACY_WHITE_REFINE_UPLOAD_LABELS_1/.test(clientSource) && /LEGACY_WHITE_REFINE_UPLOAD_LABELS_2/.test(clientSource));
check("没有把换装的业务文案复制到精修",
  !/图2服装事实|本次换装目标|人物基准/.test(panelSource));

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
