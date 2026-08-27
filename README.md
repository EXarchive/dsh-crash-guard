# dsh-crash-guard

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 打崩溃防护补丁的自动化工具。

## 问题

DSH 后端（Node.js）在以下场景会**直接闪退**：

1. **socket 收到 ECONNRESET**（网络连接被对端重置，如下载/网络波动时）——Node 的 `Unhandled 'error' event` 导致进程崩溃（`node:events:487 throw er`）
2. **run_code worker 线程崩溃**传播到主进程——主进程创建 `Worker` 时没有 `.on('error')` 处理器

典型症状：
- 后端控制台直接退出，浏览器页面无响应
- 下载大文件/网络波动时频繁发生
- 事件日志出现 `ECONNRESET` 相关错误

## 补丁内容（四层防护）

| 层 | 文件 | 作用 |
|---|---|---|
| 1 | `lib/bin.js` | 最早注册 `uncaughtException` / `unhandledRejection` / `process error` 兜底 |
| 2 | `dsh-app-boot/lib/index.js` | 主进程异常兜底 |
| 3 | `dsh-code-runtime-worker-thread/lib/worker.cjs` | worker 线程内部异常兜底 |
| 4 | `dsh-code-runtime-worker-thread/lib/index.js` | 拦截 `Worker` 的 `error` / `exit` 事件，防止传播到主进程 |

补丁效果：**网络错误只打印日志，进程不再闪退**。

## 用法

```bash
# 自动定位 DSH 安装目录并打补丁
node apply-patch.js

# 指定 DSH 目录
node apply-patch.js --dsh "D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh"

# 恢复
# 每个被打补丁的文件旁有 .bak-crashguard 备份，手动恢复即可
```

打补丁后**重启 DSH** 生效。

## 验证

- 补丁后：控制台出现 `[dsh-crash-guard]` / `[dsh-crash-guard:worker-exit]` 但**进程存活**
- 网络波动时不再闪退

## 注意事项

- **npm 更新 DSH 后补丁会被覆盖**，需要重新运行本脚本
- 补丁修改 DSH 核心文件，**升级 DSH 前建议先备份**（脚本会自动创建 .bak-crashguard）

## 相关建议

除补丁外，以下配置可减少网络崩溃诱因：

- `~/.dsh/settings.yaml`：`shell.timeoutMs` 建议 `120000`（默认 12s 太短，网络请求易超时被杀）
- 扩大 Windows TCP 动态端口范围（下载多连接耗尽端口）：
  ```bash
  netsh int ipv4 set dynamicport tcp start=1025 num=64510
  ```
- 确保代理规则包含 AI API 域名（如 api.deepseek.com 走直连/代理可达），避免 API 连接被重置

## License

MIT
