// 故意失败的夹具：run-all-check 用它验证「子脚本失败 → run-all 整体退出非 0 并在输出里点名」。
//
// 为什么是一个常驻文件，而不是元测试临时写一个再删掉：
// Windows 上刚写完的 .mjs 会被杀软/索引器短暂占用，临时夹具经常删不干净；
// 残留的必失败脚本会把下一次 `npm test` 整体带崩（这个坑真实踩过）。
// 常驻夹具没有创建/删除动作，失败传播的验证就变成确定性的、且零副作用。
//
// `__` 前缀 = run-all 默认不执行它（见 run-all.mjs 的 isFixture）：
// 只有 `--only __fail-fixture-check` 明确点名时才会被选中。
console.log("intentional failure fixture（故意失败：仅用于 run-all 失败传播验证）");
process.exitCode = 1;
