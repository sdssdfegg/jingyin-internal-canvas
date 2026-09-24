# AI 换装 SKILL 基线记录

## 2026-08-01 用户确认效果好版本

- 基线文件：`server/skill-baselines/outfit-skill.good-2026-08-01.js`
- 当前线上文件：`server/outfit-skill.js`
- SHA256：`3FF672873E0A28C64C695E0BB2C07C5AE26E10EDC6CE07C176AF6BC29185F1CF`
- 来源记录：从 `D:\RJ\静音换装内测\server\index.js` 中恢复出的昨日最后可用 SKILL，并已通过用户测试确认当前效果好。
- 保护范围：模型适配提示词、图1人物/姿态硬锁、图2服装硬锁、批量一致性、参考图边界、电商成片质量约束。

## 2026-08-06 V3 批量局部回贴稳定版本

- 基线目录：`server/skill-baselines/V3-batch-local-paste-stable-2026-08-06`
- 适用场景：批量生成里 GPT 和 Nano Banana 2 的图1局部回贴不明显偏移，人物、下巴、脖子、肩线和上下身体关系稳定。
- 保护范围：批量 SKILL、姿态锚点、图1局部回贴触发、贴回合成、局部蒙版基础逻辑和批量请求通道。
- 重要说明：后续如果要优化裤子/衣服的轻微色差，优先做轻量的色彩连续性或边缘融合调整，不要随意改动这份基线的姿态和贴回逻辑。

## 恢复方式

如果后续调整 SKILL 后效果不理想，直接把基线文件覆盖回线上文件：

```powershell
Copy-Item -LiteralPath ".\server\skill-baselines\outfit-skill.good-2026-08-01.js" -Destination ".\server\outfit-skill.js" -Force
npm.cmd run check
npm.cmd run build
```

恢复后重启本地服务，让 `server/outfit-skill.js` 重新加载。

如果是恢复 2026-08-06 V3 批量局部回贴稳定版本，按该基线目录里的 `README.md` 对照恢复相关文件。
