// 「批量提示词只发用户原话 + 图3 上传门控仍在」一致性检查（纯函数 + 文本交叉核对，不启动服务、不打上游）。
//
// 2026-09-26 SKILL / 图1图2 规则整体删除后的新契约：
//   1. `buildOutfitPrompt` 对**任何** workflow 都只回用户自己写的东西：
//      原始提示词 → 姿态锚点智能文本 → 场景补充，顺序固定、逐字不改；
//   2. 服务端不再追加任何规则块（批量换装 Skill、图1/图2 关系、图3 门控、服装类别、
//      成衣比例/长度、模型适配……全部已删除）；
//   3. 客户端的**上传门控**没有删：换装/姿态在"提示词没提到图3"时仍然不上传图3，
//      上传区 hint 仍然逐页写明这个语义（这是上传行为，不是提示词规则）。
//
// 历史背景（保留可追溯）：删除前这里钉的是 builder 的图3门控分三类
// （要求提及 / 上传即参与 / 不使用图3）。规则删除后，这三类一起消失，
// 所以本检查改成钉"谁都别想再悄悄把规则加回来"。
//
// 用法：node scripts/verify/reference-gate-check.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildOutfitPrompt } from "../../server/outfit-skill.js";

const ROOT = process.cwd();
const CLIENT = readFileSync(path.join(ROOT, "src", "outfit-workflow.jsx"), "utf8");

let failures = 0;
const lines = [];
function check(name, ok, detail = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const BASE = {
  apiKey: "sk-mock-not-real",
  model: "banana-2",
  channelId: "silent-banana-line-08",
  dispatchMode: "manual",
  imageSize: "2K",
  aspectRatio: "3:4",
  prompt: "把图2的衣服穿到图1模特身上",
  garmentParts: { upper: "single-upper", lower: "" },
  garmentComposition: "single-upper",
  garmentLengths: { upper: "", lower: "" },
  referenceCount: 2
};
const MENTION = "把图2的衣服穿到图1模特身上，图3只做颜色参考";

/** 旧 SKILL 规则里出现过的字句：删除后任何输出里都不该再出现。 */
const REMOVED_RULE_MARKERS = [
  "【批量生成换装 Skill】",
  "用户文字已明确说明图3用途",
  "用户已明确说明图3用途",
  "只按用户文字说明弱参考",
  "图3默认不介入",
  "可选补充参考",
  "当前没有图3补充图时，不要凭空增加复杂道具",
  "图2至图3：可选参考/细节图",
  "【服装类别】",
  "【图2迁移范围】",
  "【服装长度落点】",
  "【模型适配】"
];

const WORKFLOWS = [
  ["批量换装(默认)", { workflowMode: "outfit" }],
  ["局部回贴", { workflowMode: "outfit", localEdit: { enabled: true, editMode: "rect" } }],
  ["批量姿态", { workflowMode: "pose-remix" }],
  ["固定背景", { workflowMode: "background-change" }],
  ["设计稿", { workflowMode: "design-draft" }],
  ["白底精修", { workflowMode: "white-refine", whiteRefineReferenceCount: 2 }],
  ["改色", { workflowMode: "recolor", colorReferenceCount: 0 }],
  ["换脸", { workflowMode: "face-swap" }],
  ["局部细节换装", { workflowMode: "local-detail" }]
];

// ---------------------------------------------------------------- 1) 任何 workflow 都只回用户原话
for (const [label, patch] of WORKFLOWS) {
  for (const [variant, prompt, referenceCount] of [
    ["未提到图3", BASE.prompt, 2],
    ["提到图3", MENTION, 2],
    ["没有图3", BASE.prompt, 0]
  ]) {
    const text = buildOutfitPrompt({ ...BASE, ...patch, prompt, referenceCount });
    check(`[${label}｜${variant}] 只回用户原话（不含任何追加规则）`,
      text === prompt,
      text === prompt ? "逐字一致" : JSON.stringify(text.slice(0, 80)));
    const hits = REMOVED_RULE_MARKERS.filter((marker) => text.includes(marker));
    check(`[${label}｜${variant}] 不含已删除的规则字句`,
      hits.length === 0,
      hits.join("|"));
  }
}

// 历史字段 batchSkillRules 现在必须被完全忽略（防止有人用旧字段把规则接回来）
{
  const withLegacyField = buildOutfitPrompt({ ...BASE, workflowMode: "outfit", batchSkillRules: true });
  check("旧字段 batchSkillRules:true 不再有任何效果（规则已删除）",
    withLegacyField === BASE.prompt,
    JSON.stringify(withLegacyField.slice(0, 60)));
}

// ---------------------------------------------------------------- 2) 三段用户文字的拼接顺序
{
  const text = buildOutfitPrompt({
    ...BASE,
    prompt: "  把图2的衣服穿到图1模特身上  ",
    poseAnchorPrompt: "姿态锚点：保持双手插兜",
    productNote: "场景补充：暖光棚拍"
  });
  check("拼接顺序 = 原始提示词 → 姿态锚点 → 场景补充（各段 trim）",
    text === "把图2的衣服穿到图1模特身上\n\n姿态锚点：保持双手插兜\n\n场景补充：暖光棚拍",
    JSON.stringify(text));
  check("空字段不产生多余空行",
    buildOutfitPrompt({ ...BASE, prompt: "只有提示词", poseAnchorPrompt: "  ", productNote: "" }) === "只有提示词");
}

// ---------------------------------------------------------------- 3) 客户端上传门控与 hint 仍在
{
  check("客户端：换装页 hint 写明「只有明确说明图3用途时才参考」",
    CLIENT.includes("默认不参与换装，只有在补充提示词里明确说明图3用途时才参考"),
    "");
  check("客户端：姿态页 hint 写明「只有在提示词里明确说明图3用途时才参考」",
    CLIENT.includes("只有在提示词里明确说明图3用途时才参考，用于补充禁忌、细节边界或客户要求"),
    "");
  check("客户端：固定背景内置规则写明「图3不是必填，只在上传时补充场景」",
    CLIENT.includes("图3不是必填，只在上传时用于补充场景氛围、光线、色调、道具边界或客户额外要求"),
    "");
  check("客户端：白底精修 hint 写明「不使用图3」",
    CLIENT.includes("白底精修不使用图3，补充要求请写在文字里"),
    "");
  check("客户端：只有换装/姿态会在未提到图3时不上传图3（上传门控没被删掉）",
    CLIENT.includes("(isOutfitWorkflow || isPoseRemixWorkflow) && referenceImages.some((item) => item.selected) && !mentionsOptionalReferenceImage"),
    "");
}

console.log(lines.join("\n"));
console.log(`\n[reference-gate-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
