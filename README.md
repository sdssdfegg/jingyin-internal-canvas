# 静音AI绘画 V11 源码版

V11 是基于 V10 源码复制出来的正规化版本：界面布局和主要功能沿用 V10，不走 V2.1 新界面；底层把渠道、并发和上传链路重新收口。

## 本地运行

双击源码目录里的启动脚本：

```text
启动静音内测画板.bat
```

启动脚本会自己找 Node.js，不需要手工指定路径，也不需要去双击 `node.exe`。
探测顺序（找到第一个能跑 `node -v` 的就用）：

```text
1. 项目自带运行时   <源码目录>\runtime\node\node.exe        ← 源码包已经带了这个
                    <源码目录>\node\node.exe
                    <源码目录>\node_modules\node\bin\node.exe  等
2. 启动脚本附近     <源码目录>\scripts\node.exe
                    <源码目录>\..\node.exe
3. 当前 PATH        node.exe / node（含 .cmd/.bat 转发脚本，会自动解析出真实 node.exe）
4. 常见安装位置     C:\Program Files\nodejs、%LOCALAPPDATA%\Programs\nodejs、
                    nvm / fnm / volta / scoop / chocolatey / winget 的版本目录
5. 其它程序自带     Adobe、腾讯文档、Tabbit 等程序捆绑的 node.exe（只在前面都失败时才用）
6. 最后兜底         D:\RJ\node\node.exe
```

**源码包自带 Node 运行时**

`runtime\node\node.exe` 已经随源码包提供（官方 OpenJS Foundation 签名，v24.9.0），
所以就算目标机器完全没装 Node，双击启动器也能跑起来。

如果这个文件丢失或需要换成别的版本，用下面任一方式重建：

```powershell
# 自动在机器上找一个可用的 node.exe 复制过来
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-local-node.ps1

# 指定来源
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-local-node.ps1 -Source "D:\somewhere\node.exe" -Force
```

如果一个都没找到，脚本会：

- 打印“未找到可用 Node.js”和**实际探测过的每一个路径**；
- 给出安装 Node.js 或配置 PATH 的具体做法；
- 以退出码 `2` 结束，并保持窗口打开，不会假装启动成功。

启动器退出码：

```text
0 = 启动成功（或服务本来就在运行且健康检查通过）
1 = 服务启动失败（Node 报错 / 端口始终没监听 / 健康检查没过）
2 = 未找到可用 Node.js
3 = 端口已监听但 /api/health 没通过
其它 = Node 进程自己的真实退出码
```

命令行启动（想自己指定 Node 时）：

```powershell
cd <源码目录>
runtime\node\node.exe server/index.js
```

打开：

```text
http://127.0.0.1:8787/
```

如果 8787 被别的程序占用，服务会自动顺延到下一个端口，启动器会把**真实端口**显示出来，以它打印的地址为准。

启动器日志：

```text
logs\launcher-diagnostic.log        每次启动的探测记录（用了哪个 Node、探测过哪些路径）
logs\launcher-server.log            服务 stdout
logs\launcher-server.err.log        服务 stderr
logs\launcher-failure-<时间戳>.log  启动失败时的输出快照
```

## 中转站规则

- 本地软件只调用 `https://api.jingyin.online/v1`。
- 渠道商 API、上游 KEY、模型映射、价格、限流和备用渠道都放在 `api.jingyin.online` 后台。
- 每个用户使用自己的静音中转站 KEY，一人一台电脑。
- 源码和发布包不内置渠道商 KEY，不内置旧直连地址。

## V11 当前底层优化

- 批量工作流默认并发改为 5。
- 普通批量不再按任务总数无限开 worker，最多同时跑 5 个。
- 服务端图片请求总并发默认 5，可用 `IMAGE_CONCURRENCY_LIMIT=5` 控制。
- 图片请求默认只发 1 种中转站标准参数格式；如需旧兼容重试，可临时设置 `JINGYIN_ENABLE_IMAGE_COMPAT_VARIANTS=1`。
- `/api/images` 和 `/api/generate-outfit` 的上传先落到 `tmp/uploads`，请求结束自动清理，减少大图上传长期占用内存。
- 旧的本地直连渠道路由已从主源码配置移除。

## 运行数据

运行时数据不属于源码：

```text
data/
logs/
tmp/
node_modules/
dist/
.env
```

这些目录都在 `.gitignore` 中，不应该打进源码备份。

生成日志：

```text
D:\静音AI绘画V11（源码）\logs\generation.jsonl
```

里面的 `timing.channelWaitMs` 接近中转站/上游实际等待时间；如果 50 台电脑同时慢，优先看中转站后台的队列、限流和渠道耗时。

本地健康检查：

```text
http://127.0.0.1:8787/api/health
```

这里可以看到当前图片并发、排队数量和本机内存占用，不包含 KEY、提示词或图片内容。

中转站优先级和连通性：

```text
http://127.0.0.1:8787/api/gateways
http://127.0.0.1:8787/api/gateways/status
```

`/api/gateways/status` 不携带用户 KEY、不出图、不扣费，只能判断本地到中转站入口是否可达；用户 KEY、余额、模型权限和中转站后台渠道商是否正常，要看真实生成日志或中转站后台。

## 维护目录

后续调整功能前，先看维护文档总索引：

```text
D:\静音AI绘画V11（源码）\V11维护文档\00-总索引.md
```

这个文件夹专门放给后续维护用的小 MD。每次只发相关 1-3 个文档，避免一次性内容过大。

功能目录地图：

```text
D:\静音AI绘画V11（源码）\V11维护文档\01-目录分区与维护地图.md
```

重复 UI、重复功能同步检查表：

```text
D:\静音AI绘画V11（源码）\V11维护文档\02-重复功能同步登记表.md
```

如果某个 UI 或逻辑还没有抽成共享组件，改动前先看这张表，避免只改一个分区导致另一个分区保持旧版本。

API 调用、登录/KEY、中转站链路：

```text
D:\静音AI绘画V11（源码）\V11维护文档\04-API调用与登录系统地图.md
D:\静音AI绘画V11（源码）\src\api\README.md
```

批量 tab 分区：

```text
D:\静音AI绘画V11（源码）\V11维护文档\05-批量分区功能地图.md
D:\静音AI绘画V11（源码）\src\features\outfit\workflows\README.md
```

默认提示词和 SKILL 规则先看：

```text
D:\静音AI绘画V11（源码）\prompts\README.md
```

后端最终生图规则已集中到 `prompts/server/`，旧的 `server/outfit-skill.js` 和 `server/detail-skills.js` 只保留兼容转发。
