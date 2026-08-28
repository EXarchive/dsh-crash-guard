#!/usr/bin/env node
/**
 * dsh-crash-guard v2 — 自动给 DSH (DeepSeek Harness) 打崩溃防护补丁
 *
 * 问题: DSH 后端遇到 socket ECONNRESET / worker 线程崩溃时,
 *      因缺少 error 处理器导致 "Unhandled 'error' event" -> 进程闪退;
 *      且旧版防护只把错误打到 console —— DSH 从桌面 .cmd 窗口启动时,
 *      窗口一关/不盯着, 报错就彻底丢失, 无法定位真正的崩溃原因。
 *
 * v2 改进:
 *   1. 所有防护 handler 同时写入 ~/.dsh/logs/crash-guard.log (带时间戳), console 仍保留;
 *   2. 每次 DSH 启动/worker 加载写一条 boot 日志, 便于确认防护是否生效;
 *   3. 旧版补丁自动原位升级 (无需先还原)。
 *
 * 配套: start-guard.cmd — 守护启动器, dsh web 崩溃后 3 秒自动重启。
 *
 * 用法: node apply-patch.js [--dsh <path>] [--restore]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TAG = "[dsh-crash-guard:v2]";
const V2_MARKER = "dsh-crash-guard:v2";

function log(...a) { console.log(TAG, ...a); }

// 定位 DSH 安装目录
function findDshRoot() {
  try {
    const pkg = require.resolve("@deepseek-ai/dsh/package.json");
    return path.dirname(pkg);
  } catch (e) {}
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh"),
    path.join(process.env.NVM_SYMLINK || "", "node_modules", "@deepseek-ai", "dsh"),
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh"),
    "C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh",
    "D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh",
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) return c;
  }
  throw new Error("找不到 DSH 安装目录，请用 --dsh <path> 指定");
}

// ---------- v2 防护代码 ----------

const GUARD_ESM = [
  '// ===== [dsh-crash-guard:v2] 崩溃防护（文件日志版）=====',
  'const cgWrite = async (kind, payload) => {',
  '  const line = "[dsh-crash-guard] " + new Date().toISOString() + " [" + kind + "] " + String(payload ?? "") + "\\n";',
  '  try { console.error(line.trimEnd()); } catch (_) {}',
  '  try {',
  '    const m = await import("node:fs");',
  '    const dir = (process.env.USERPROFILE || process.env.HOME || process.cwd() || "").replace(/\\\\/g, "/") + "/.dsh/logs";',
  '    m.mkdirSync(dir, { recursive: true });',
  '    m.appendFileSync(dir + "/crash-guard.log", line, "utf8");',
  '  } catch (_) {}',
  '};',
  'process.on("uncaughtException", (err) => { cgWrite("uncaughtException", err?.stack || err); });',
  'process.on("unhandledRejection", (reason) => { cgWrite("unhandledRejection", reason); });',
  'process.on("error", (err) => { cgWrite("process-error", err?.stack || err); });',
  'cgWrite("boot", "dsh 进程启动 pid=" + process.pid);',
  '// ===== end crash-guard-v2 =====',
].join("\n");

const GUARD_CJS = [
  '// ===== [dsh-crash-guard:v2] worker 崩溃防护（文件日志版）=====',
  'const cgWrite = (kind, payload) => {',
  '  const line = "[dsh-crash-guard] " + new Date().toISOString() + " [" + kind + "] " + String(payload ?? "") + "\\n";',
  '  if (kind !== "boot") { try { console.error(line.trimEnd()); } catch (_) {} }',
  '  try {',
  '    const m = require("node:fs");',
  '    const dir = (process.env.USERPROFILE || process.env.HOME || process.cwd() || "").replace(/\\\\/g, "/") + "/.dsh/logs";',
  '    m.mkdirSync(dir, { recursive: true });',
  '    m.appendFileSync(dir + "/crash-guard.log", line, "utf8");',
  '  } catch (_) {}',
  '};',
  'process.on("uncaughtException", (err) => { cgWrite("worker-uncaughtException", err?.stack || err); });',
  'process.on("unhandledRejection", (reason) => { cgWrite("worker-unhandledRejection", reason); });',
  'cgWrite("boot", "worker 线程加载 pid=" + process.pid);',
  '// ===== end crash-guard-v2 =====',
].join("\n");

// worker index.js 内联块（类方法内, 无法定义模块级 helper）
const WORKER_INDEX_V2 = "\t\tworker.on(\"error\", (err) => {\n" +
  "\t\t\t// [dsh-crash-guard:v2:worker-error] 拦截 worker 崩溃, 防止传播到主进程\n" +
  "\t\t\tconst line = \"[dsh-crash-guard] \" + new Date().toISOString() + \" [worker-error] \" + String(err?.stack || err) + \"\\n\";\n" +
  "\t\t\tconsole.error(line.trimEnd());\n" +
  "\t\t\ttry { const m = require(\"node:fs\"); const dir = (process.env.USERPROFILE || process.env.HOME || process.cwd() || \"\").replace(/\\\\/g, \"/\") + \"/.dsh/logs\"; m.mkdirSync(dir, { recursive: true }); m.appendFileSync(dir + \"/crash-guard.log\", line, \"utf8\"); } catch (_) {}\n" +
  "\t\t});\n" +
  "\t\tworker.on(\"exit\", (code) => {\n" +
  "\t\t\t// [dsh-crash-guard:v2:worker-exit] 异常退出才打印(Windows 正常 terminate 恒为 1):\n" +
  "\t\t\tconst line = \"[dsh-crash-guard] \" + new Date().toISOString() + \" [worker-exit] code=\" + code + \"\\n\";\n" +
  "\t\t\tif (code !== 1) console.error(line.trimEnd());\n" +
  "\t\t\ttry { const m = require(\"node:fs\"); const dir = (process.env.USERPROFILE || process.env.HOME || process.cwd() || \"\").replace(/\\\\/g, \"/\") + \"/.dsh/logs\"; m.mkdirSync(dir, { recursive: true }); m.appendFileSync(dir + \"/crash-guard.log\", line, \"utf8\"); } catch (_) {}\n" +
  "\t\t});\n";

// ---------- 旧版清理 ----------

function stripOldGuardEsm(content) {
  const re = /\/\/ ={5} \[dsh-crash-guard\][\s\S]*?\/\/ ={5} end crash-guard[^\n]*\n?/m;
  if (re.test(content)) return content.replace(re, "");
  return content;
}

function stripOldWorkerIndex(content) {
  const re = /worker\.on\("error", \(err\) => \{\s*\n[\s\S]*?dsh-crash-guard:worker-exit[\s\S]*?\}\);[\s]*\n/m;
  if (re.test(content)) return content.replace(re, "");
  return content;
}

// ---------- 注入 ----------

function injectAfterShebang(content, guard) {
  const lines = content.split("\n");
  if (lines[0].startsWith("#!")) {
    lines.splice(1, 0, ...guard.split("\n"));
    return lines.join("\n");
  }
  return guard + "\n" + content;
}

function injectAfterFirstImport(content, guard) {
  const lines = content.split("\n");
  const idx = lines.findIndex(l => /^import /.test(l));
  if (idx < 0) return null;
  lines.splice(idx + 1, 0, ...guard.split("\n"));
  return lines.join("\n");
}

function injectAfterFirstRequire(content, guard) {
  const lines = content.split("\n");
  const idx = lines.findIndex(l => /require\(/.test(l) && l.trim().endsWith(";"));
  if (idx < 0) return null;
  lines.splice(idx + 1, 0, ...guard.split("\n"));
  return lines.join("\n");
}

function applyEsm(file, guard) {
  if (!fs.existsSync(file)) return { skipped: true, reason: "文件不存在" };
  let content = fs.readFileSync(file, "utf8");
  if (content.includes(V2_MARKER)) return { skipped: true, reason: "已是 v2" };
  const isOld = /\[dsh-crash-guard\]/.test(content);
  if (isOld) {
    content = stripOldGuardEsm(content);
  } else if (!fs.existsSync(file + ".bak-crashguard")) {
    fs.copyFileSync(file, file + ".bak-crashguard");
  }
  const lines = content.split("\n");
  const next = lines[0] && lines[0].startsWith("#!")
    ? injectAfterShebang(content, guard)
    : injectAfterFirstImport(content, guard);
  if (!next) return { skipped: true, reason: "未找到插入点" };
  fs.writeFileSync(file, next);
  return { patched: true, upgraded: isOld };
}

function applyWorkerCjs(file, guard) {
  if (!fs.existsSync(file)) return { skipped: true, reason: "文件不存在" };
  let content = fs.readFileSync(file, "utf8");
  if (content.includes(V2_MARKER)) return { skipped: true, reason: "已是 v2" };
  const isOld = /\[dsh-crash-guard:worker\]/.test(content);
  if (isOld) {
    const re = /\/\/ ={5} \[dsh-crash-guard\] worker[\s\S]*?\/\/ ={5} end crash-guard[^\n]*\n?/m;
    content = content.replace(re, "");
  } else if (!fs.existsSync(file + ".bak-crashguard")) {
    fs.copyFileSync(file, file + ".bak-crashguard");
  }
  const next = injectAfterFirstRequire(content, guard);
  if (!next) return { skipped: true, reason: "未找到 require" };
  fs.writeFileSync(file, next);
  return { patched: true, upgraded: isOld };
}

function applyWorkerIndex(file) {
  if (!fs.existsSync(file)) return { skipped: true, reason: "文件不存在" };
  let content = fs.readFileSync(file, "utf8");
  if (content.includes("dsh-crash-guard:v2:worker-error")) return { skipped: true, reason: "已是 v2" };
  const isOld = content.includes("dsh-crash-guard:worker-error") || content.includes("dsh-crash-guard:worker-exit");
  if (isOld) {
    content = stripOldWorkerIndex(content);
  } else if (!fs.existsSync(file + ".bak-crashguard")) {
    fs.copyFileSync(file, file + ".bak-crashguard");
  }
  // 锚点必须消歧: waitForPipeDrain 里也有 "return new Promise((resolve) => {",
  // 但只有 worker 运行回调后面紧跟 "let settled = false;", 用该组合定位, 否则插错位置导致 ReferenceError。
  const anchorRe = /return new Promise\(\(resolve\) => \{\s*\n[ \t]*let settled = false;/;
  if (!anchorRe.test(content)) return { skipped: true, reason: "未找到插入点(锚点: let settled)" };
  content = content.replace(anchorRe, (m) => WORKER_INDEX_V2 + m);
  fs.writeFileSync(file, content);
  return { patched: true, upgraded: isOld };
}

// ---------- 主逻辑 ----------

async function main() {
  const args = process.argv.slice(2);
  const restore = args.includes("--restore");
  const dshIdx = args.indexOf("--dsh");
  const root = dshIdx >= 0 ? args[dshIdx + 1] : findDshRoot();
  log("DSH 目录:", root);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  log("版本:", pkg.version);

  const appBoot = path.join(root, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  const workerCjs = path.join(root, "node_modules", "@deepseek-ai", "dsh-code-runtime-worker-thread", "lib", "worker.cjs");
  const workerIndex = path.join(root, "node_modules", "@deepseek-ai", "dsh-code-runtime-worker-thread", "lib", "index.js");
  const binJs = path.join(root, "lib", "bin.js");

  if (restore) {
    log("恢复模式: 还原 .bak-crashguard 备份");
    for (const f of [binJs, appBoot, workerCjs, workerIndex]) {
      if (fs.existsSync(f + ".bak-crashguard")) {
        fs.copyFileSync(f + ".bak-crashguard", f);
        log("已还原:", f);
      } else {
        log("无备份, 跳过:", f);
      }
    }
    log("恢复完成。");
    return;
  }

  const targets = [
    ["bin.js", applyEsm(binJs, GUARD_ESM)],
    ["app-boot/index.js", applyEsm(appBoot, GUARD_ESM)],
    ["worker.cjs", applyWorkerCjs(workerCjs, GUARD_CJS)],
    ["worker index.js", applyWorkerIndex(workerIndex)],
  ];

  for (const [name, r] of targets) {
    if (r.patched) log("已" + (r.upgraded ? "升级" : "打") + "补丁:", name);
    else log("跳过:", name, "->", r.reason || "");
  }

  // 语法验证 + 回滚
  const files = { "bin.js": binJs, "app-boot/index.js": appBoot, "worker.cjs": workerCjs, "worker index.js": workerIndex };
  for (const [name, r] of targets) {
    if (!r.patched) continue;
    try {
      execSync('node --check "' + files[name] + '"', { stdio: "ignore" });
      log("语法 OK:", name);
    } catch (e) {
      log("语法错误:", name, "—— 正在回滚 .bak-crashguard");
      if (fs.existsSync(files[name] + ".bak-crashguard")) fs.copyFileSync(files[name] + ".bak-crashguard", files[name]);
      else log("无备份可回滚！请手动检查:", files[name]);
    }
  }

  // 守护启动器
  const repoDir = path.dirname(fs.realpathSync(__filename));
  const guardCmd = path.join(repoDir, "start-guard.cmd");
  if (!fs.existsSync(guardCmd)) {
    fs.writeFileSync(guardCmd, [
      "@echo off",
      "chcp 65001 >nul",
      "title dsh web 守护启动器 (崩溃自动重启, Ctrl+C 退出)",
      "echo [dsh-crash-guard] 守护模式: dsh web 崩溃后 3 秒自动重启...",
      ":loop",
      "set HTTP_PROXY=http://127.0.0.1:7891",
      "set HTTPS_PROXY=http://127.0.0.1:7891",
      "set ALL_PROXY=http://127.0.0.1:7891",
      "dsh web",
      "echo [dsh-crash-guard] dsh web 已退出 (code %errorlevel%), 3 秒后重启... (Ctrl+C 停止)",
      "timeout /t 3 >nul",
      "goto loop",
      "",
    ].join("\r\n"), "utf8");
    log("已生成守护启动器:", guardCmd);
  }

  log("完成。请重启 DSH 使 v2 防护生效。");
}

main().catch(e => { console.error(TAG, "失败:", e.message); process.exit(1); });
