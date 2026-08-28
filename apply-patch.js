#!/usr/bin/env node
/**
 * dsh-crash-guard — 自动给 DSH (DeepSeek Harness) 打崩溃防护补丁
 *
 * 问题: DSH 后端遇到 socket ECONNRESET / worker 线程崩溃时,
 *      因缺少 error 处理器导致 "Unhandled 'error' event" -> 进程闪退。
 * 修复: 注入 uncaughtException / unhandledRejection / worker error 兜底。
 *
 * 用法: node apply-patch.js [--dsh <path>] [--restore]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TAG = "[dsh-crash-guard]";

function log(...a) { console.log(TAG, ...a); }

// 定位 DSH 安装目录
function findDshRoot() {
  // 1) 从 require.resolve 反推
  try {
    const pkg = require.resolve("@deepseek-ai/dsh/package.json");
    return path.dirname(pkg);
  } catch (e) {}
  // 2) 常见全局安装位置
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

// 注入补丁到文件（shebang 后 / import 后 / 顶层）
function injectGuard(file, guard, marker, position) {
  if (!fs.existsSync(file)) return { skipped: true, reason: "文件不存在" };
  let content = fs.readFileSync(file, "utf8");
  if (content.includes(marker)) return { skipped: true, reason: "已打过补丁" };
  fs.copyFileSync(file, file + ".bak-crashguard");
  const lines = content.split("\n");
  if (position === "after-shebang" && lines[0].startsWith("#!")) {
    lines.splice(1, 0, ...guard.split("\n"));
    fs.writeFileSync(file, lines.join("\n"));
  } else if (position === "after-first-import") {
    const idx = lines.findIndex(l => /^import /.test(l));
    if (idx < 0) return { skipped: true, reason: "未找到 import" };
    lines.splice(idx + 1, 0, ...guard.split("\n"));
    fs.writeFileSync(file, lines.join("\n"));
  } else if (position === "after-first-require") {
    const idx = lines.findIndex(l => /require\(/.test(l) && l.trim().endsWith(";"));
    lines.splice(idx + 1, 0, ...guard.split("\n"));
    fs.writeFileSync(file, lines.join("\n"));
  } else {
    fs.writeFileSync(file, guard + "\n" + content);
  }
  return { patched: true };
}

// 主逻辑
async function main() {
  const args = process.argv.slice(2);
  const dshIdx = args.indexOf("--dsh");
  const root = dshIdx >= 0 ? args[dshIdx + 1] : findDshRoot();
  log("DSH 目录:", root);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  log("版本:", pkg.version);

  const appBoot = path.join(root, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  const workerCjs = path.join(root, "node_modules", "@deepseek-ai", "dsh-code-runtime-worker-thread", "lib", "worker.cjs");
  const workerIndex = path.join(root, "node_modules", "@deepseek-ai", "dsh-code-runtime-worker-thread", "lib", "index.js");
  const binJs = path.join(root, "lib", "bin.js");

  const GUARD_MAIN = [
    '// ===== [dsh-crash-guard] 崩溃防护 =====',
    'process.on("uncaughtException", (err) => {',
    '  console.error("[dsh-crash-guard] uncaughtException:", err?.stack || err);',
    '});',
    'process.on("unhandledRejection", (reason) => {',
    '  console.error("[dsh-crash-guard] unhandledRejection:", reason);',
    '});',
    '// ===== end crash-guard =====',
  ].join("\n");

  const GUARD_BIN = [
    '// ===== [dsh-crash-guard] bin.js 崩溃防护（最早执行）=====',
    'process.on("uncaughtException", (err) => {',
    '  console.error("[dsh-crash-guard:bin]", err?.stack || err);',
    '});',
    'process.on("unhandledRejection", (reason) => {',
    '  console.error("[dsh-crash-guard:bin] unhandledRejection:", reason);',
    '});',
    'process.on("error", (err) => {',
    '  console.error("[dsh-crash-guard:bin] process error:", err?.stack || err);',
    '});',
    '// ===== end crash-guard =====',
  ].join("\n");

  const results = [];
  results.push(["bin.js", injectGuard(binJs, GUARD_BIN, "dsh-crash-guard:bin", "after-shebang")]);
  results.push(["app-boot/index.js", injectGuard(appBoot, GUARD_MAIN, "dsh-crash-guard", "after-first-import")]);
  results.push(["worker.cjs", injectGuard(workerCjs, GUARD_MAIN.replace(":bin", ":worker"), "dsh-crash-guard:worker", "after-first-require")]);

  // worker index.js: 加 worker.on("error"/"exit")
  if (fs.existsSync(workerIndex)) {
    let c = fs.readFileSync(workerIndex, "utf8");
    if (c.includes("dsh-crash-guard:worker-error")) {
      results.push(["worker index.js", { skipped: true, reason: "已打过补丁" }]);
    } else {
      fs.copyFileSync(workerIndex, workerIndex + ".bak-crashguard");
      const anchor = "return new Promise((resolve) => {";
      const patch = [
        'worker.on("error", (err) => {',
        '  console.error("[dsh-crash-guard:worker-error]", err?.stack || err);',
        '});',
        'worker.on("exit", (code) => {',
        '  // 正常完成路径固定走 worker.terminate()，Windows 上 exit code 恒为 1（日志噪音），不打印。',
        '  // 真正的异常退出 code != 1（OOM 134 / 自然退出 0 / 崩溃 3）。',
        '  if (code !== 1) console.error("[dsh-crash-guard:worker-exit] unexpected code=" + code);',
        '});',
        anchor,
      ].join("\n");
      if (c.includes(anchor)) {
        c = c.replace(anchor, patch);
        fs.writeFileSync(workerIndex, c);
        results.push(["worker index.js", { patched: true }]);
      } else {
        results.push(["worker index.js", { skipped: true, reason: "未找到插入点" }]);
      }
    }
  }

  for (const [name, r] of results) {
    if (r.patched) log("已打补丁:", name);
    else log("跳过:", name, "->", r.reason || "");
  }

  // 语法验证
  for (const [name, r] of results) {
    if (!r.patched) continue;
    const file = { "bin.js": binJs, "app-boot/index.js": appBoot, "worker.cjs": workerCjs, "worker index.js": workerIndex }[name];
    try {
      execSync('node --check "' + file + '"', { stdio: "ignore" });
      log("语法 OK:", name);
    } catch (e) {
      log("语法错误:", name, "—— 正在回滚");
      if (fs.existsSync(file + ".bak-crashguard")) fs.copyFileSync(file + ".bak-crashguard", file);
    }
  }
  log("完成。请重启 DSH 生效。");
}

main().catch(e => { console.error(TAG, "失败:", e.message); process.exit(1); });
