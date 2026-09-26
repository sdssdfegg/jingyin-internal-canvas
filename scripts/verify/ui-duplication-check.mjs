// 快捷生成 UI 去重检查（静态解析 JSX，不启动浏览器）。
//
// 覆盖验收项：
//   - 页面没有重复的清空图片 / 提示词助手 / 优化提示词按钮
//   - 四个功能（清空图片 / 提示词助手 / 优化提示词 / 线路价格）在快捷悬浮框里各只有一套入口
//   - 只删了重复 UI，底层能力函数仍在
//
// 用法：node scripts/verify/ui-duplication-check.mjs
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

const mainJsx = readFileSync(path.join(root, "src", "main.jsx"), "utf8");

// 切出「快捷生成图片模式的悬浮框底部工具区」这一段。
const clusterIndex = mainJsx.indexOf('className="quickToolCluster"');
check("找到快捷悬浮框功能组", clusterIndex > 0);
const footerStart = mainJsx.lastIndexOf('className="composerFooter"', clusterIndex);
const footerEnd = mainJsx.indexOf("</section>", clusterIndex);
const footer = mainJsx.slice(footerStart, footerEnd);
check("成功切出快捷悬浮框底部工具区", footer.length > 200, `len=${footer.length}`);

function countIn(text, token) {
  return text.split(token).length - 1;
}

// 1) 四个功能在悬浮框里各只有一套入口
check("清空图片入口只有 1 个", countIn(footer, 'title="清空图片"') === 1, String(countIn(footer, 'title="清空图片"')));
check("提示词助手入口只有 1 个", countIn(footer, 'title="提示词助手"') === 1, String(countIn(footer, 'title="提示词助手"')));
check("优化提示词入口只有 1 个", countIn(footer, 'title="优化提示词"') === 1, String(countIn(footer, 'title="优化提示词"')));
check("线路价格入口只有 1 个", countIn(footer, 'aria-label="线路价格"') === 1, String(countIn(footer, 'aria-label="线路价格"')));

// 2) 旧入口（底部左右两侧的按钮）已删除
check("底部不再有 <span>清空图片</span> 旧入口", countIn(footer, "<span>清空图片</span>") === 0);
check("底部不再有 <span>优化提示词</span> 旧入口", countIn(footer, "<span>优化提示词</span>") === 0);
check("底部不再有 <span>词</span> 旧入口", countIn(footer, "<span>词</span>") === 0);

// 3) 快捷生成页面其它位置也没有同一功能的第二套按钮
//    参考生图 / 一键详情 属于独立模块，不在快捷生成页，排除。
const quickgenAreaStart = mainJsx.indexOf("className={`composer ${isComposerDragging");
const quickgenAreaEnd = mainJsx.indexOf("{events.length > 0 && (", quickgenAreaStart);
const quickgenSection = mainJsx.slice(quickgenAreaStart, quickgenAreaEnd);
check("快捷生成悬浮框内没有第二套清空图片按钮", countIn(quickgenSection, "<span>清空图片</span>") === 0);
check("快捷生成悬浮框内没有第二套优化提示词按钮", countIn(quickgenSection, "<span>优化提示词</span>") === 0);
check("快捷生成悬浮框内没有第二套词按钮", countIn(quickgenSection, "<span>词</span>") === 0);

// 4) 2026-09-26：SKILL / 换装开关已按用户要求删除（快捷 + 批量都不再有任何 SKILL 开关）
const settingsStateStart = mainJsx.indexOf("const defaultState = {");
const settingsStateEnd = mainJsx.indexOf("};", settingsStateStart);
const defaultStateBlock = mainJsx.slice(settingsStateStart, settingsStateEnd);
check("defaultState 里不再有 skillRulesEnabled", !defaultStateBlock.includes("skillRulesEnabled"));
check("快捷悬浮框里不再有 SKILL / 换装开关按钮", !footer.includes("skillToggleButton"));
check("快捷悬浮框里不再有「换装」开关文案", !footer.includes("<span>换装</span>"));
check("main.jsx 里不再出现 skillRulesEnabled", !mainJsx.includes("skillRulesEnabled"));

const storageEffect = mainJsx.slice(mainJsx.indexOf("writeJsonStorage(STORAGE_KEY, settings)") - 400, mainJsx.indexOf("writeJsonStorage(STORAGE_KEY, settings)") + 200);
check("settings 会写回本地存档（状态持久化）", storageEffect.includes("writeJsonStorage(STORAGE_KEY, settings)"));

// 5) 底层能力函数没有被删除
for (const fn of ["function optimizePrompt", "setIsPromptAssistantOpen", "setFiles([])"]) {
  check(`底层能力仍在：${fn}`, mainJsx.includes(fn));
}

// 6) 2026-09-26：SKILL 规则块已整体删除，只保留"用户原话"出口 + 局部意图判定
const rulesModule = readFileSync(path.join(root, "src", "shared", "quickgen-prompt-rules.js"), "utf8");
check("共享模块只导出「提示词出口 + 局部意图判定」",
  rulesModule.includes("export function promptForQuickGeneration(prompt)")
    && rulesModule.includes("export function classifyQuickPrimaryLocalIntent(prompt)"),
  "quickgen-prompt-rules.js");
for (const constantName of [
  "QUICK_LOCAL_EDIT_PROMPT_SUFFIX",
  "QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX",
  "QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX",
  "QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_SKILL_RULE_BLOCKS"
]) {
  check(`规则块常量已删除：${constantName}`, !rulesModule.includes(constantName));
  check(`main.jsx 也不再定义：${constantName}`, !mainJsx.includes(`const ${constantName} =`));
}
check("提示词出口就是用户原话（不再拼接任何后缀）",
  /export function promptForQuickGeneration\(prompt\) \{\s*return String\(prompt \|\| ""\)\.trim\(\);\s*\}/.test(rulesModule),
  "无后缀拼接");

// 7) 2026-09-25 UI 调整：悬浮框里这四类重复入口必须消失
check("悬浮框不再有「图片生成」页签 JSX", !/className="modeTab active"[\s\S]{0,80}图片生成/.test(quickgenSection));
check("悬浮框不再有「视频生成」页签 JSX", !/className="modeTab"[\s\S]{0,120}视频生成/.test(quickgenSection));
check("悬浮框不再有 .modeTabs 容器", !quickgenSection.includes('className="modeTabs"'));
check("悬浮框不再有可见「上传」按钮", !/<span>上传 \(/.test(footer));
check("悬浮框不再有可见「库」按钮", !/<span>库<\/span>/.test(footer));
check("隐藏 file input 仍保留（上传能力不删）", footer.includes('type="file"'));
check(
  "顶部结果栏仍保留 图片/视频 切换入口（能力不删）",
  /setQuickMode\("video"\)/.test(mainJsx) && /setQuickMode\("image"\)/.test(mainJsx)
);

// 8) 悬浮框尺寸稳定性：min-width / min-height 必须是固定值
const cssText = readFileSync(path.join(root, "src", "styles.css"), "utf8");
const composerBlock = cssText.slice(cssText.indexOf(".composer {"), cssText.indexOf(".composer {") + 700);
check("悬浮框有 min-width", /min-width:\s*\d+px/.test(composerBlock), (composerBlock.match(/min-width:[^;]+/) || [""])[0]);
check("悬浮框有 min-height", /min-height:\s*\d+px/.test(composerBlock), (composerBlock.match(/min-height:[^;]+/) || [""])[0]);
check("悬浮框不再直接吃全局 --shadow（深色厚阴影）", !/box-shadow:\s*var\(--shadow\)/.test(composerBlock), (composerBlock.match(/box-shadow:[^;]+/) || [""])[0]);

// 9) 2026-09-26：SKILL 开关样式已随开关一起删除
check("styles.css 里不再有 .skillToggleButton 规则", !cssText.includes(".skillToggleButton"));
check("批量内嵌主题里不再有 .batchSkillRulesSwitch 规则",
  !readFileSync(path.join(root, "src", "outfit-workflow.css"), "utf8").includes(".batchSkillRulesSwitch"));

// 10) 上游路由错误码必须映射成中文可读文案
// 2026-09-25：映射逻辑（含 manual_channel_required）统一收敛到 src/shared/generation-errors.js，
// main.jsx 走分类器，不再自己写正则。
const generationErrors = readFileSync(path.join(root, "src", "shared", "generation-errors.js"), "utf8");
check(
  "共享错误分类器把 manual_channel_required 映射成可读提示",
  /manual_channel_required/.test(generationErrors) && /模型或渠道不可用/.test(generationErrors)
);
check(
  "快捷生成走共享分类器（main.jsx 不再散写正则）",
  /from "\.\/shared\/generation-errors\.js"/.test(mainJsx) && /formatGenerationError\(/.test(mainJsx)
);

// 11) 设置里的「开发诊断 / 一键传参自检」已替换为「连接测试」
check("设置里是「连接测试」按钮", /onClick=\{\(\) => void runConnectionTest\(\)\}/.test(mainJsx) && /连接测试/.test(mainJsx));
check("旧的诊断入口 UI 已移除（按钮与标题都不在）", !mainJsx.includes("一键传参自检") && !/Settings size=\{15\} \/> 开发诊断/.test(mainJsx));
check("连接测试只探测模型清单（不调用生图）", /\/api\/connection-test/.test(readFileSync(path.join(root, "src", "api", "connection.js"), "utf8")));

console.log(lines.join("\n"));
console.log(`\n[ui-duplication-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
