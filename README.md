# dsh-crash-guard

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 打崩溃防护补丁的自动化工具。

## 问题

DSH 后端（Node.js）在以下场景会**直接闪退**：

1. **socket 收到 ECONNRESET**（网络连接被对端重置，如下载/网络波动时）——Node 的 Unhandled 'error' event 导致进程崩溃（node:events:487 throw er）
2. **run_code worker 线程崩溃**传播到主进程——主进程创建 Worker 时没有 .on('error') 处理器

典型症状：
- 后端控制台直接退出，浏览器页面无响应
- 下载大文件/网络波动时频繁发生
- 事件日志出现 ECONNRESET 相关错误

## 补丁内容（四层防护）

| 层 | 文件 | 作用 |
|---|---|---|
| 1 | lib/bin.js | 最早注册 uncaughtException / unhandledRejection / process error 兜底 |
| 2 | dsh-app-boot/lib/index.js | 主进程异常兜底 |
| 3 | dsh-code-runtime-worker-thread/lib/worker.cjs | worker 线程内部异常兜底 |
| 4 | dsh-code-runtime-worker-thread/lib/index.js | 拦截 Worker 的 error / exit 事件，防止传播到主进程 |

补丁效果：**网络错误只打印日志，进程不再闪退**。

## v2 改进

- **错误写入文件日志**：全部防护 handler 同时追加写入 ~/.dsh/logs/crash-guard.log（带时间戳），不再只依赖启动它的终端窗口——DSH 常从 .cmd/批处理窗口启动，窗口一关报错就彻底丢失，无法定位真正的崩溃原因。
- **boot 记录**：每次 DSH 启动 / worker 加载写一条 [boot] 日志，一眼确认防护是否生效。
- **守护启动器**：start-guard.cmd —— dsh web 崩溃后 3 秒自动重启，替代手动重启。
- **原位升级**：旧版（v1/v2）补丁自动升级为最新版，无需先手动还原。

## v2.1 修订（2026-08-29 事故复盘）

- **日志目录固化**：打补丁时把绝对路径（如 C:/Users/<用户>/.dsh/logs）写死进防护代码，不再依赖运行时环境变量——worker 沙箱环境被剥离时 USERPROFILE/HOME 缺失，旧版会写偏到磁盘根目录（C:/.dsh）。
- **ESM 安全写入**：worker index.js 是 ESM（type=module），文件写入改用 import() 异步 IIFE；旧版用 require() 在 ESM 中未定义、被 catch 吞掉导致文件日志静默失效。
- **boot 去重**：移除 app-boot 的 boot 日志（与 bin.js 重复）；worker 的 boot 仅写文件、不再刷终端。
- **守护启动器 UAC 提权**：start-guard.cmd 双击自动请求管理员权限（与官方管理员终端一致）。
- **锚点唯一校验**：重新打补丁时校验 worker 运行回调锚点全文唯一，命中数 != 1 则中止不写文件。

## 用法

    # 自动定位 DSH 安装目录并打/升级补丁
    node apply-patch.js

    # 指定 DSH 目录
    node apply-patch.js --dsh "D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh"

    # 还原（从 .bak-crashguard 备份）
    node apply-patch.js --restore

打补丁后**重启 DSH** 生效。

### 守护启动器（推荐）

从桌面/任意位置运行 start-guard.cmd（生成于脚本同级目录），窗口一直保持前台：
- dsh web 崩溃后 **3 秒自动重启**；
- Ctrl+C 停止。

## 验证

- 补丁后：日志文件 ~/.dsh/logs/crash-guard.log 出现 [boot] 行 = 防护已生效
- 网络波动时：crash-guard.log 出现 uncaughtException / unhandledRejection 记录，进程仍存活
- 若日志出现 worker-exit code=3/134 等异常退出码，即定位到 worker 崩溃点

## 注意事项

- **npm 更新 DSH 后补丁会被覆盖**，需要重新运行本脚本
- 补丁修改 DSH 核心文件，**升级 DSH 前建议先备份**（脚本会自动创建 .bak-crashguard）
- 守护启动器会循环执行 dsh web，请勿同时用旧启动器和守护启动器各开一个实例（端口 3080 冲突）

## 相关建议

除补丁外，以下配置可减少网络崩溃诱因：

- ~/.dsh/settings.yaml 中 shell.timeoutMs 建议 120000（默认 12s 太短，网络请求易超时被杀）
- 扩大 Windows TCP 动态端口范围（下载多连接耗尽端口）：

        netsh int ipv4 set dynamicport tcp start=1025 num=64510

- 确保代理规则包含 AI API 域名（如 api.deepseek.com 走直连/代理可达），避免 API 连接被重置

## License

MIT

