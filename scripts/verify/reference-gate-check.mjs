// 「图3（补充参考图）门控」一致性检查（纯函数 + 文本交叉核对，不启动服务、不打上游）。
//
// 为什么要有这个检查：
//   第 4 步 lint 报告把 `buildBackgroundChangePrompt` 里 `referenceMentioned` 算了没用
//   列成「门控与其它路径不一致」的疑点。本轮逐条核对后发现：**不是缺陷，是有意设计**，
//   而且三处互相印证：
//     1. builder 门控：换装/局部回贴/批量姿态要求「用户提到图3」才描述图3；
//        固定背景/设计稿/换脸/改色/局部细节换装是「上传即参与」
//     2. 客户端 hint（src/outfit-workflow.jsx 的上传区提示）逐页写明了同样的语义
//     3. 客户端上传行为：只有换装/姿态会在「没提到图3」时**不上传**图3
//        （src/outfit-workflow.jsx: `if ((isOutfitWorkflow || isPoseRemixWorkflow) && … && !mentionsOptionalReferenceImage(…)`）
//
//   白底精修那条文案讲的是「图2至图N」（另一个计数字段 whiteRefineReferenceCount，
//   数的是服装图，不是图3），与它的 hint「白底精修不使用图3」一致，不是差异。
//
//   这个测试把上面三层钉住：谁改了 builder 文案、改了 hint、或改了上传门控，都会红。
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
  batchSkillRules: true,
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

function promptFor(patch, { mention, referenceCount = 2 } = {}) {
  return buildOutfitPrompt({
    ...BASE,
    ...patch,
    referenceCount,
    ...(mention ? { prompt: MENTION } : {})
  });
}

// 只在「要求提及」的三条路径的**提及分支**里出现的字句：用它们判定某条路径属于哪一类。
// 三条路径措辞各不相同，所以三个都要列（漏一个就会把那条路径判成「上传即参与」）。
const MENTION_ONLY_MARKERS = [
  "用户文字已明确说明图3用途",   // 批量换装（默认分支）
  "用户已明确说明图3用途",       // 批量姿态
  "只按用户文字说明弱参考"       // 局部回贴
];
const isMentionGated = (text) => MENTION_ONLY_MARKERS.some((marker) => text.includes(marker));

// ---------------------------------------------------------------- 1) 要求提及的三条路径
{
  const outfitPlain = promptFor({ workflowMode: "outfit" });
  check("批量换装：未提到图3时，不追加「已明确说明图3用途」这句",
    !isMentionGated(outfitPlain),
    outfitPlain.split("\n").find((line) => line.includes("图3")) || "");
  check("批量换装：提到图3时，追加「已明确说明图3用途」",
    promptFor({ workflowMode: "outfit" }, { mention: true }).includes("用户文字已明确说明图3用途"));

  const localEditOff = promptFor({ workflowMode: "outfit", localEdit: { enabled: true, editMode: "rect" } });
  check("局部回贴：未提到图3时写明「图3默认不介入」",
    localEditOff.includes("图3默认不介入；只有用户文字明确说明图3用途时才弱参考"),
    localEditOff.split("\n").find((line) => line.includes("图3默认不介入")) || "");
  check("局部回贴：提到图3时改成「只按用户文字说明弱参考」",
    promptFor({ workflowMode: "outfit", localEdit: { enabled: true, editMode: "rect" } }, { mention: true })
      .includes("图3及后续 2 张只按用户文字说明弱参考，不能替代图2服装"));

  const pose = promptFor({ workflowMode: "pose-remix" });
  check("批量姿态：未提到图3时写明「不参考图3」",
    pose.includes("当前没有明确启用图3时，不参考图3"));
  check("批量姿态：提到图3时改成「已明确说明图3用途」",
    promptFor({ workflowMode: "pose-remix" }, { mention: true }).includes("用户已明确说明图3用途"));
}

// ---------------------------------------------------------------- 2) 上传即参与的五条路径
{
  const cases = [
    ["固定背景", { workflowMode: "background-change" }, "图3及后续 2 张：可选补充参考"],
    ["设计稿", { workflowMode: "design-draft" }, "第3张及后续属于图3区域：可选细节/风格补充"],
    ["换脸", { workflowMode: "face-swap" }, "图3及后续 2 张：可选补充参考"],
    ["改色", { workflowMode: "recolor", colorReferenceCount: 0 }, "来自前端图3补充区"],
    ["局部细节换装", { workflowMode: "local-detail" }, "图3及后续 2 张只做可选补充"]
  ];
  for (const [label, patch, expected] of cases) {
    const text = promptFor(patch);
    check(`${label}：没提到图3也按「上传即参与」描述（与它的页面 hint 一致）`,
      text.includes(expected) && !isMentionGated(text),
      expected);
  }
}

// ---------------------------------------------------------------- 3) 没有图3时的兜底文案
{
  const background = promptFor({ workflowMode: "background-change" }, { referenceCount: 0 });
  check("固定背景：没有图3时走「不要凭空增加」兜底",
    background.includes("当前没有图3补充图时，不要凭空增加复杂道具"),
    background.split("\n").find((line) => line.includes("图3")) || "");
  const outfit = promptFor({ workflowMode: "outfit" }, { referenceCount: 0 });
  check("批量换装：没有图3时同样不追加图3说明句",
    !isMentionGated(outfit),
    "");
}

// ---------------------------------------------------------------- 4) 白底精修：讲的是图2至图N（不是图3）
{
  const whiteRefine = promptFor({ workflowMode: "white-refine", whiteRefineReferenceCount: 2 });
  check("白底精修：参考文案讲「图2至图N」（服装图计数），不是图3",
    whiteRefine.includes("图2至图3：可选参考/细节图"),
    whiteRefine.split("\n").find((line) => line.includes("可选参考/细节图")) || "");
}

// ---------------------------------------------------------------- 5) 客户端三处与 builder 对齐
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
  check("客户端：只有换装/姿态会在未提到图3时不上传图3",
    CLIENT.includes("(isOutfitWorkflow || isPoseRemixWorkflow) && referenceImages.some((item) => item.selected) && !mentionsOptionalReferenceImage"),
    "");
}

// ---------------------------------------------------------------- 6) 分类集合断言（防止以后悄悄多改一条）
{
  const all = [
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
  // 判定某条路径是不是「要求提及」：提到图3之后多出提及专用字句，且没提到时没有。
  // 只查一半会判错（未提及分支里也有「明确说明图3用途」这种字样，必须前后对比）。
  const gatedPaths = all.filter(([, patch]) => (
    isMentionGated(promptFor(patch, { mention: true })) && !isMentionGated(promptFor(patch))
  )).map(([label]) => label);
  const expected = ["批量换装(默认)", "局部回贴", "批量姿态"];
  check("「要求提及图3」的路径恰好是换装 / 局部回贴 / 批量姿态三条",
    JSON.stringify(gatedPaths) === JSON.stringify(expected),
    `实际 ${gatedPaths.join(",") || "(无)"}`);
  check("其余六条都是「上传即参与」或「不使用图3」",
    all.length - gatedPaths.length === 6,
    `非提及门控 ${all.length - gatedPaths.length} 条`);
}

// ---------------------------------------------------------------- 7) SKILL 开关关闭时不追加任何规则
{
  const off = buildOutfitPrompt({ ...BASE, workflowMode: "background-change", batchSkillRules: false, referenceCount: 2 });
  check("批量 SKILL 关闭时，任何图3门控文案都不出现（只发用户原话）",
    !off.includes("图3及后续") && !off.includes("可选补充参考") && off.includes(BASE.prompt),
    off.slice(0, 60));
}

console.log(lines.join("\n"));
console.log(`\n[reference-gate-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
