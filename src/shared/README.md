# shared 目录

这里放多个前端板块共同使用的配置和工具。

- `models.js`：前端展示用模型、尺寸和结果图来源解析。
- `local-edit-mask.js`：快捷生成和批量生成共用的局部编辑/涂抹蒙版工具。

维护规则：

1. 如果一个规则会同时影响快捷生成、批量生成、参考生图或详情页，优先放到这里。
2. 旧入口 `src/models.js` 和 `src/local-edit-mask.js` 只做兼容转发，新代码优先从 `src/shared/` 引入。
3. 不要在这里写具体页面 UI，页面 UI 后续应进入 `src/features/`。
