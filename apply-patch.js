#!/usr/bin/env node
/**
 * dsh-crash-guard v2.1 — 自动给 DSH (DeepSeek Harness) 打崩溃防护补丁
 *
 * v2.1 修订(基于 2026-08-29 事故复盘):
 *   1. 日志目录在打补丁时固化(LOGDIR 绝对路径), 不再依赖运行时环境变量
 *      (worker 沙箱环境被剥离时 USERPROFILE/HOME 缺失, 旧版会写偏到 C:\.dsh);
 *   2. worker index.js 是 ESM(type=module), 文件写入改用 import() 异步 IIFE,
 *      旧版 require() 在 ESM 中未定义被 catch 吞掉 -> 文件日志静默失效;
 *   3. 移除 app-boot 的 boot 日志(与 bin.js 重复, 同进程两条);
 *   4. start-guard.cmd 增加 UAC 提权(与官方管理员终端一致);
 *   5. 锚点命中必须唯一(worker 运行回调), 否则中止不写文件。
 *
 * 用法: node apply-patch.js [--dsh <path>] [--restore]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TAG = "[dsh-crash-guard:v2.1]";
const MARK = "dsh-crash-guard:v2.1";

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

// 固化日志目录: 打补丁时解析(此时是正常 shell, 环境变量齐全)
function resolveLogDir() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) return home.replace(/\\/g, "/") + "/.dsh/logs";
  throw new Error("无法解析用户主目录(USERPROFILE/HOME), 请用环境变量指定");
}

// ---------- v2.1 防护代码 ----------

function makeGuardEsm(logDir, withBoot) {
  const lines = [
    '// ===== [' + MARK + '] 崩溃防护（文件日志版）=====',
    'const CG_LOG_DIR = "' + logDir + '";',
    'const cgWrite = async (kind, payload) => {',
    '  const line = "[dsh-crash-guard] " + new Date().toISOString() + " [" + kind + "] " + String(payload ?? "") + "\\n";',
    '  try { console.error(line.trimEnd()); } catch (_) {}',
    '  try {',
    '    const m = await import("node:fs");',
    '    m.mkdirSync(CG_LOG_DIR, { recursive: true });',
    '    m.appendFileSync(CG_LOG_DIR + "/crash-guard.log", line, "utf8");',
    '  } catch (_) {}',
    '};',
    'process.on("uncaughtException", (err) => { cgWrite("uncaughtException", err?.stack || err); });',
    'process.on("unhandledRejection", (reason) => { cgWrite("unhandledRejection", reason); });',
    'process.on("error", (err) => { cgWrite("process-error", err?.stack || err); });',
  ];
  if (withBoot) lines.push('cgWrite("boot", "dsh 进程启动 pid=" + process.pid);');
  lines.push('// ===== end crash-guard-v2.1 =====');
  return lines.join("\n");
}

function makeGuardCjs(logDir) {
  const lines = [
    '// ===== [' + MARK + '] worker 崩溃防护（文件日志版）=====',
    'const CG_LOG_DIR = "' + logDir + '";',
    'const cgWrite = (kind, payload) => {',
    '  const line = "[dsh-crash-guard] " + new Date().toISOString() + " [" + kind + "] " + String(payload ?? "") + "\\n";',
    '  if (kind !== "boot") { try { console.error(line.trimEnd()); } catch (_) {} }',
    '  try {',
    '    const m = require("node:fs");',
    '    m.mkdirSync(CG_LOG_DIR, { recursive: true });',
    '    m.appendFileSync(CG_LOG_DIR + "/crash-guard.log", line, "utf8");',
    '  } catch (_) {}',
    '};',
    'process.on("uncaughtException", (err) => { cgWrite("worker-uncaughtException", err?.stack || err); });',
    'process.on("unhandledRejection", (reason) => { cgWrite("worker-unhandledRejection", reason); });',
    'cgWrite("boot", "worker 线程加载 pid=" + process.pid);',
    '// ===== end crash-guard-v2.1 =====',
  ];
  return lines.join("\n");
}

function makeWorkerIndexBlock(logDir) {
  const fsWrite = '(async () => { try { const m = await import("node:fs"); m.mkdirSync("' + logDir + '", { recursive: true }); m.appendFileSync("' + logDir + '/crash-guard.log", line, "utf8"); } catch (_) {} })();';
  return [
    '\t\tworker.on("error", (err) => {',
    '\t\t\t// [dsh-crash-guard:v2.1:worker-error] 拦截 worker 崩溃, 防止传播到主进程(ESM: 用 import() 异步写)',
    '\t\t\tconst line = "[dsh-crash-guard] " + new Date().toISOString() + " [worker-error] " + String(err?.stack || err) + "\\n";',
    '\t\t\tconsole.error(line.trimEnd());',
    '\t\t\t' + fsWrite,
    '\t\t});',
    '\t\tworker.on("exit", (code) => {',
    '\t\t\t// [dsh-crash-guard:v2.1:worker-exit] 异常退出才打印(Windows 正常 terminate 恒为 1):',
    '\t\t\tconst line = "[dsh-crash-guard] " + new Date().toISOString() + " [worker-exit] code=" + code + "\\n";',
    '\t\t\tif (code !== 1) console.error(line.trimEnd());',
    '\t\t\t' + fsWrite,
    '\t\t});',
  ].join("\n") + "\n";
}

// ---------- 旧版清理(任意 v1/v2/v2.0 块均可剥离) ----------

function stripAnyGuardBlock(content) {
  const re = /\/\/ ={5} \[dsh-crash-guard[^\]]*\][\s\S]*?\/\/ ={5} end crash-guard[^\n]*\n?/m;
  if (re.test(content)) return content.replace(re, "");
  return content;
}

function stripWorkerIndexBlocks(content) {
  const re = /worker\.on\("error", \(err\) => \{\s*\n[\s\S]*?dsh-crash-guard[^\n]*worker-exit[\s\S]*?\}\);[\s]*\n/m;
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
  if (content.includes("end crash-guard-v2.1")) return { skipped: true, reason: "已是 v2.1" };
  const isOld = /\[dsh-crash-guard/.test(content);
  if (isOld) {
    content = stripAnyGuardBlock(content);
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
  if (content.includes("end crash-guard-v2.1")) return { skipped: true, reason: "已是 v2.1" };
  const isOld = /\[dsh-crash-guard/.test(content);
  if (isOld) {
    content = stripAnyGuardBlock(content);
  } else if (!fs.existsSync(file + ".bak-crashguard")) {
    fs.copyFileSync(file, file + ".bak-crashguard");
  }
  const next = injectAfterFirstRequire(content, guard);
  if (!next) return { skipped: true, reason: "未找到 require" };
  fs.writeFileSync(file, next);
  return { patched: true, upgraded: isOld };
}

function applyWorkerIndex(file, block) {
  if (!fs.existsSync(file)) return { skipped: true, reason: "文件不存在" };
  let content = fs.readFileSync(file, "utf8");
  if (content.includes("dsh-crash-guard:v2.1:worker-error")) return { skipped: true, reason: "已是 v2.1" };
  const isOld = /dsh-crash-guard/.test(content);
  if (isOld) {
    content = stripWorkerIndexBlocks(content);
  } else if (!fs.existsSync(file + ".bak-crashguard")) {
    fs.copyFileSync(file, file + ".bak-crashguard");
  }
  // 锚点: worker 运行回调(其后紧跟 let settled = false), 全文必须唯一
  const anchorRe = /return new Promise\(\(resolve\) => \{\s*\n[ \t]*let settled = false;/;
  const hits = (content.match(anchorRe) || []).length;
  if (hits !== 1) return { skipped: true, reason: "锚点命中 " + hits + " 处(应为 1), 中止" };
  content = content.replace(anchorRe, (m) => block + m);
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

  const logDir = resolveLogDir();
  log("日志目录(固化):", logDir);

  const targets = [
    ["bin.js", applyEsm(binJs, makeGuardEsm(logDir, true))],
    ["app-boot/index.js", applyEsm(appBoot, makeGuardEsm(logDir, false))],
    ["worker.cjs", applyWorkerCjs(workerCjs, makeGuardCjs(logDir))],
    ["worker index.js", applyWorkerIndex(workerIndex, makeWorkerIndexBlock(logDir))],
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

  // 守护启动器(带 UAC 提权; 缺失或旧版则重写)
  const repoDir = path.dirname(fs.realpathSync(__filename));
  const guardCmd = path.join(repoDir, "start-guard.cmd");
  let cmd = "";
  if (fs.existsSync(guardCmd)) cmd = fs.readFileSync(guardCmd, "utf8");
  if (!cmd.includes("net session")) {
    fs.writeFileSync(guardCmd, [
      "@echo off",
      "chcp 65001 >nul",
      "rem 一键管理员终端式守护: 双击后自动请求 UAC 并以管理员运行 DSH, 崩溃后 3 秒自动重启",
      "net session >nul 2>&1",
      "if %errorlevel% neq 0 (",
      "    echo 正在请求管理员权限...",
      "    powershell -NoProfile -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\"",
      "    exit /b",
      ")",
      "title dsh web 守护启动器 (崩溃自动重启, Ctrl+C 退出)",
      "echo [dsh-crash-guard] 守护模式: dsh web 崩溃后 3 秒自动重启... (Ctrl+C 停止)",
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
    log("已生成/更新守护启动器:", guardCmd);
  }

  log("完成。请重启 DSH 使 v2.1 完全生效(worker.cjs 对新 worker 即时生效)。");
}

main().catch(e => { console.error(TAG, "失败:", e.message); process.exit(1); });
