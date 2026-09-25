// `npm run check` 的语法检查执行器。
//
// 背景：本机没有 npm（也无 D:\RJ\node），沙箱内 node 的 child_process 默认 pipe
// stdio 会 EPERM，所以这里直接读 package.json 的 scripts.check，
// 拆出所有 `node --check <file>` 目标，用 stdio:'inherit' 逐个执行。
//
// 说明：scripts.check 现在还串了 `node scripts/verify/run-all.mjs`（把验证脚本接入 check）。
// 这里只保留**业务源码**目标，跳过 scripts/ 下的验证脚本本身：
// 验证脚本由 run-all 真正执行（比只做语法检查更强），没必要再被 --check 一遍。
//
// 用法：node scripts/verify/run-node-check.mjs
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const script = String(pkg.scripts?.check || "");
const targets = [...script.matchAll(/node\s+--check\s+(\S+)/g)]
  .map((match) => match[1])
  .filter((target) => !target.replace(/\\/g, "/").startsWith("scripts/"));

if (targets.length === 0) {
  console.error("[run-node-check] package.json 里没有找到 node --check 目标");
  process.exit(1);
}

let failed = 0;
for (const target of targets) {
  const result = spawnSync(process.execPath, ["--check", target], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[run-node-check] FAIL ${target}`);
    failed += 1;
  } else {
    console.log(`[run-node-check] OK   ${target}`);
  }
}
console.log(`[run-node-check] 目标 ${targets.length} 个，失败 ${failed} 个`);
process.exit(failed === 0 ? 0 : 1);
