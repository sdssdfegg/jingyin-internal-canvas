// 受控 fixture：只用来验证启动器有没有把 Node 的真实退出码原样报出来。
//
// 它不做任何业务、不联网、不读写项目数据，只是立刻用一个指定的非零码退出。
// 由 scripts/verify/check-launcher.mjs 通过启动器的 -ServerEntryRelative 参数调用。
const raw = process.env.JINGYIN_LAUNCHER_FIXTURE_EXIT_CODE;
const parsed = Number.parseInt(raw === undefined ? "7" : String(raw), 10);
const code = Number.isFinite(parsed) && parsed !== 0 ? parsed : 7;

console.log("[fixture] launcher exit-code fixture started");
console.log("[fixture] stdin/argv ignored; this run is not a real server");
console.error(`[fixture] intentional failure, exiting with code ${code}`);
process.exit(code);
