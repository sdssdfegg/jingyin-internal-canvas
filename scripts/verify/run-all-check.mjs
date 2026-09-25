// 验证「验证脚本已被接入 npm test / npm run check」这件事本身。
//
// 覆盖：
//   1. package.json 里 test / check 已指向 run-all；check 仍包含全部源码语法检查
//   2. run-all 能发现全部可执行验证脚本（数量与磁盘一致，且顺序表里的都在）
//   3. --only 过滤生效；找不到时报错退出（退出码 2）；--list 只打印不执行
//   4. **失败会传播**：故意放一个必失败的脚本进去，run-all 必须退出非 0 并在输出里点名
//   5. 浏览器侧模块（.js/.jsx）不会被当成可执行脚本；测试夹具（__ 开头）不进默认门禁
//   6. 只读取证工具（恒返回 0、不做断言）被显式分类，不会混进断言门禁
//
// 用法：node scripts/verify/run-all-check.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const VERIFY_DIR = path.join(ROOT, "scripts", "verify");
const NODE = process.execPath;
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ---------- 1) package.json 接线 ----------
check("package.json 有 npm test 且指向 run-all",
  String(pkg.scripts?.test || "").includes("scripts/verify/run-all.mjs"),
  String(pkg.scripts?.test || "(缺失)"));
check("npm run check 里串上了 run-all（语法检查 + 全部验证脚本）",
  String(pkg.scripts?.check || "").includes("node scripts/verify/run-all.mjs"),
  String(pkg.scripts?.check || "").slice(-60));
check("check 仍然包含全部源码语法检查（14 个 node --check 目标）",
  ([...String(pkg.scripts?.check || "").matchAll(/node\s+--check\s+(\S+)/g)]
    .map((m) => m[1])
    .filter((target) => !target.replace(/\\/g, "/").startsWith("scripts/")).length) === 14,
  `实际 ${([...String(pkg.scripts?.check || "").matchAll(/node\s+--check\s+(\S+)/g)].length)} 个`);
check("保留 check:syntax 便于单独跑语法检查",
  String(pkg.scripts?.["check:syntax"] || "").includes("node --check"),
  String(pkg.scripts?.["check:syntax"] || "(缺失)").slice(0, 40));

// ---------- 2) run-all 能发现全部脚本 ----------
// `__` 开头的是测试夹具（见 run-all.mjs 的 isFixture），不属于正式验证集，
// 这里也要排除：否则夹具一旦清理失败残留，会误报"顺序表漏掉脚本"。
const diskScripts = readdirSync(VERIFY_DIR)
  .filter((name) => name.endsWith(".mjs") && !name.startsWith("__"))
  .map((name) => name.replace(/\.mjs$/, ""));
const listScripts = (extraArgs = []) => {
  const run = spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--list", ...extraArgs], { cwd: ROOT, encoding: "utf8" });
  return { status: run.status, names: run.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
};
const listRun = spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--only", "__list_probe__"], { cwd: ROOT, encoding: "utf8" });
check("run-all 对不存在的 --only 报错退出（退出码 2）",
  listRun.status === 2,
  `status=${listRun.status}`);
check("磁盘上的可执行验证脚本 >= 14 个", diskScripts.length >= 14, `实际 ${diskScripts.length} 个`);
check("run-all 自己在脚本目录里（但永远不会被当成子脚本跑，见下一组断言）", diskScripts.includes("run-all"), "run-all.mjs");
check("浏览器侧模块不会被当成可执行脚本（.js/.jsx 不在 .mjs 列表内）",
  !diskScripts.includes("crop-geometry-page") && !diskScripts.includes("error-boundary-page"),
  diskScripts.filter((n) => n.includes("page")).join(",") || "(无 page 脚本)");

// --list 是只读的：能看清"这次到底会跑什么"，元测试也靠它便宜地断言选择逻辑。
// 期望条数 = 正式脚本 - 只读取证工具（工具不进断言门禁）。
const runAllSource = readFileSync(path.join(VERIFY_DIR, "run-all.mjs"), "utf8");
function quotedIn(constName) {
  const body = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\n\\];`).exec(runAllSource)?.[1] || "";
  return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}
const ordered = quotedIn("ORDER");
const tools = quotedIn("TOOLS");

const defaultList = listScripts();
const expectedDefault = diskScripts.filter((name) => !tools.includes(name) && name !== "run-all");
check("--list 列出全部正式脚本（去掉只读工具与 run-all 自己）且退出 0",
  defaultList.status === 0 && defaultList.names.length === expectedDefault.length,
  `status=${defaultList.status} 列出 ${defaultList.names.length} / 期望 ${expectedDefault.length}`);
check("--list 结果里没有只读取证工具（speed-investigation 不进断言门禁）",
  !defaultList.names.includes("speed-investigation"),
  defaultList.names.includes("speed-investigation") ? "混进来了" : "已排除");
check("--list --only history 精确过滤",
  JSON.stringify(listScripts(["--only", "history"]).names) === JSON.stringify(["history-repair-check", "history-integrity-check"]),
  listScripts(["--only", "history"]).names.join(","));
// 回归：run-all 曾经把磁盘上的自己当成普通脚本跑 → run-all 跑 run-all → 递归爆炸。
check("默认执行列表里没有 run-all 自己（不会递归跑自己）",
  !defaultList.names.includes("run-all"),
  defaultList.names.includes("run-all") ? "run-all 出现在默认列表里" : "已排除");
check("--only 也不能把 run-all 选成子脚本（自我保护对 --only 同样生效）",
  !listScripts(["--only", "run-all"]).names.includes("run-all"),
  listScripts(["--only", "run-all"]).names.join(",") || "(空)");

// run-all 的顺序表应覆盖所有磁盘脚本（除自身、meta 检查与显式列出的只读工具）
const missingFromOrder = diskScripts.filter((name) => name !== "run-all" && name !== "run-all-check"
  && !ordered.includes(name) && !tools.includes(name));
check("顺序表覆盖所有磁盘脚本（新增脚本不会被漏跑）",
  missingFromOrder.length === 0,
  missingFromOrder.length ? `漏掉: ${missingFromOrder.join(",")}` : `ORDER ${ordered.length} 个 + TOOLS ${tools.length} 个`);
check("新增的两条服务端接口验证脚本都在顺序表里",
  ordered.includes("http-mock-check") && ordered.includes("pro-wire-check"),
  `http-mock-check=${ordered.includes("http-mock-check")} pro-wire-check=${ordered.includes("pro-wire-check")}`);
check("只读取证工具被显式分类且不混进断言顺序表",
  tools.length > 0 && tools.every((name) => !ordered.includes(name)) && tools.every((name) => diskScripts.includes(name)),
  `TOOLS=${tools.join(",")}`);
check("只读工具不会被 run-all 当成断言执行（--only 选它 → 退出码 2）",
  spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--only", "speed-investigation"], { cwd: ROOT, encoding: "utf8" }).status === 2,
  "speed-investigation");

// ---------- 3) --only 过滤生效 ----------
const onlyRun = spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--only", "history", "--json"], { cwd: ROOT, encoding: "utf8" });
let onlyJson = null;
try { onlyJson = JSON.parse(onlyRun.stdout.slice(onlyRun.stdout.indexOf("{"))); } catch { onlyJson = null; }
check("--only history 只跑相关脚本且全部通过",
  onlyRun.status === 0 && onlyJson?.scripts === 2 && onlyJson?.failed === 0,
  `status=${onlyRun.status} scripts=${onlyJson?.scripts} failed=${onlyJson?.failed}`);

// ---------- 4) 失败会传播（最容易漏的一条）----------
// 夹具是常驻文件 scripts/verify/__fail-fixture-check.mjs（`__` 前缀 → 默认不跑）。
// 这里只读不写：不再临时创建/删除夹具，避免"删不干净 → 下次必失败"的自毒。
const fixturePath = path.join(VERIFY_DIR, "__fail-fixture-check.mjs");
check("失败夹具常驻在脚本目录里", existsSync(fixturePath), path.relative(ROOT, fixturePath));
// 夹具默认不该被跑（否则残留一个必失败文件会把整套测试带崩），但 --only 点名时要能选中。
check("夹具不进默认执行列表",
  !listScripts().names.includes("__fail-fixture-check"),
  "夹具混进默认列表了");
check("夹具可以被 --only 点名选中（元测试需要它验失败传播）",
  listScripts(["--only", "__fail-fixture-check"]).names.includes("__fail-fixture-check"),
  listScripts(["--only", "__fail-fixture-check"]).names.join(","));
{
  const failRun = spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--only", "__fail-fixture-check", "--json"], { cwd: ROOT, encoding: "utf8" });
  let failJson = null;
  try { failJson = JSON.parse(failRun.stdout.slice(failRun.stdout.indexOf("{"))); } catch { failJson = null; }
  check("run-all：子脚本失败 → 整体退出非 0",
    failRun.status === 1,
    `status=${failRun.status}`);
  check("run-all：JSON 结果里如实标注失败项",
    failJson?.ok === false && failJson?.failed === 1 && failJson?.entries?.[0]?.name === "__fail-fixture-check",
    JSON.stringify(failJson?.entries || []));
  // 人读输出只能在不带 --json 的那次里验（--json 时故意只吐 JSON，方便机器解析）。
  const failRunText = spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--only", "__fail-fixture-check"], { cwd: ROOT, encoding: "utf8" });
  check("run-all：人读输出里点名失败脚本",
    failRunText.status === 1 && /失败脚本：__fail-fixture-check/.test(failRunText.stdout),
    `status=${failRunText.status} 输出未点名`);
}
check("跑完夹具后脚本目录仍是干净的（没有残留临时文件）",
  readdirSync(VERIFY_DIR).filter((name) => name.startsWith("__")).length === 1,
  readdirSync(VERIFY_DIR).filter((name) => name.startsWith("__")).join(","));

// ---------- 5) run-all 的汇总行可用 ----------
const summaryRun = spawnSync(NODE, [path.join(VERIFY_DIR, "run-all.mjs"), "--only", "history-integrity-check"], { cwd: ROOT, encoding: "utf8" });
check("run-all 输出人读汇总行（脚本数/通过/失败/用时）",
  /\[run-all\] \d+ 个脚本：通过 \d+，失败 \d+，用时 [\d.]+s/.test(summaryRun.stdout),
  (summaryRun.stdout.split(/\r?\n/).find((line) => line.includes("[run-all]")) || "").trim());

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  discoveredScripts: diskScripts.length,
  failures: failed,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
