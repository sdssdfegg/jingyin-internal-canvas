// 验证脚本共用的「测试实例收尾」工具。
//
// 为什么不直接用 fs.rmSync：
//   实测在开发机上，工作区路径上的 `fs.rmSync(p, { recursive: true, force: true })`
//   会**静默无效**——不抛错、也不删任何东西（同一进程里删系统临时目录却是正常的，
//   所以是工作区路径上的拦截，不是杀软也不是文件锁）。结果就是三个脚本各自写的
//   「跑完删掉沙盒」全是空操作，.codex-artifacts 下越积越多，而脚本仍然报通过。
//   这里改成显式自底向上 unlink/rmdir，可观测、可重试、失败能说出是哪一个文件。
//
// 另一个坑：Windows 上子进程被 kill 之后句柄不是立刻释放的，所以删除要带重试。
//
// 放在 scripts/verify/lib/ 而不是 scripts/verify/ 根下是刻意的：
// run-all.mjs 只把根目录的 .mjs 当成可执行验证脚本，lib 里的不会被误跑。
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * 同步删掉一棵目录树（自底向上 unlink/rmdir）。
 * @returns {string[]} 失败项描述（空数组 = 全部删掉）
 */
export function removeTreeSync(dir) {
  const errors = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      errors.push(`${current}: ${error?.code || error?.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try { unlinkSync(full); } catch (error) { errors.push(`${full}: ${error?.code || error?.message}`); }
      }
    }
    try { rmdirSync(current); } catch (error) { errors.push(`${current}: ${error?.code || error?.message}`); }
  };
  if (existsSync(dir)) walk(dir);
  return errors;
}

/**
 * 准备一个干净的沙盒目录：先真删（不是 rmSync），再建出来。
 * 固定名字的沙盒脚本必须用它，否则上一轮的残留会污染这一轮的种子
 * （history-repair-check 就被残留的 missing_1.png 坑过一次）。
 */
export function freshSandbox(dir) {
  removeTreeSync(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 等一个子进程真的退出（先 kill，再等 exit 事件）。
 * @returns {Promise<boolean>} 是否确认已退出
 */
export async function stopChild(child, { timeoutMs = 10000 } = {}) {
  if (!child) return true;
  const alreadyExited = () => child.exitCode !== null || child.signalCode !== null;
  if (alreadyExited()) return true;
  const exited = new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  try { child.kill(); } catch { /* 已经退出了 */ }
  await exited;
  return alreadyExited();
}

/**
 * 带重试地删掉沙盒目录（句柄释放有延迟，单次往往删不干净）。
 * @returns {Promise<{removed:boolean, attempts:number, error:string}>} 结果与最后一次错误
 */
export async function removeSandbox(dir, { attempts = 12, delayMs = 700 } = {}) {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const errors = removeTreeSync(dir);
    lastError = errors.join(" | ");
    if (!existsSync(dir)) return { removed: true, attempts: attempt, error: "" };
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { removed: false, attempts, error: lastError || "目录仍然存在（删除未报错）" };
}

/**
 * 进程退出时的兜底清理：正常路径已经收过了，这里只处理「中途抛错」的情况。
 * exit 钩子只允许同步操作，所以是最朴素的 kill + 删树，删不干净也不阻塞退出。
 */
export function installExitCleanup({ getChild, sandboxDir }) {
  process.on("exit", () => {
    try { getChild()?.kill(); } catch { /* ignore */ }
    if (sandboxDir) removeTreeSync(sandboxDir);
  });
}
