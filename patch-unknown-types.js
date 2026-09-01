
#!/usr/bin/env node
/**
 * patch-unknown-types.js — dsh-crash-guard 配套: 修复 SessionFormatUnsupportedError
 * 症状: 打开历史会话报 "event type 'message-edit/version' ... unknown to this harness"
 * 原因: 插件/遗留事件类型(message-edit/version, permissionRules/decision, session/imported)
 *       不在 dsh-session 的 KNOWN_SESSION_EVENT_TYPES 表中(插件事件构造上在表外),
 *       旧会话的这些事件又未带 ignorable 标记 -> 读取端拒载。
 * 修复: 向 KNOWN_SESSION_EVENT_TYPES 追加白名单(仅放行, 不削弱未来未知类型拦截)。
 * 用法: node patch-unknown-types.js [--dsh <dsh安装/缓存目录>]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ADD = [
  '"message-edit/version",',
  '"permissionRules/decision",',
  '"session/imported",',
];
const MARK = "dsh-unknown-types-fix";

function locate() {
  const roots = [];
  for (const g of process.argv.slice(2)) if (g.startsWith("--")) continue;
  const argsOk = [];
  const dshIdx = process.argv.indexOf("--dsh");
  if (dshIdx >= 0 && process.argv[dshIdx + 1]) argsOk.push(process.argv[dshIdx + 1]);
  if (process.env.APPDATA) argsOk.push(path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"));
  argsOk.push("D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh");
  argsOk.push("D:/Program Files/nodejs/node_cache/_npx");
  const results = [];
  for (const r of argsOk) {
    if (fs.existsSync(r + "/node_modules/@deepseek-ai/dsh-session/lib/index.js")) {
      results.push(path.join(r, "node_modules", "@deepseek-ai", "dsh-session", "lib", "index.js"));
    }
  }
  // npx 平铺
  const npxRoot = "D:/Program Files/nodejs/node_cache/_npx";
  if (fs.existsSync(npxRoot)) {
    for (const h of fs.readdirSync(npxRoot)) {
      const f = path.join(npxRoot, h, "node_modules", "@deepseek-ai", "dsh-session", "lib", "index.js");
      if (fs.existsSync(f)) results.push(f);
    }
  }
  const profile = "C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js";
  if (fs.existsSync(profile)) results.push(profile);
  return [...new Set(results)];
}

let patched = 0, already = 0, missing = 0;
for (const f of locate()) {
  let c = fs.readFileSync(f, "utf8");
  if (c.includes(MARK)) { already++; console.log("skip(已补):", f); continue; }
  const anchor = "KNOWN_SESSION_EVENT_TYPES = new Set([";
  const i = c.indexOf(anchor);
  if (i < 0) { missing++; console.log("skip(锚点未找到):", f); continue; }
  fs.copyFileSync(f, f + ".bak-unknown-types");
  const insertAt = i + anchor.length;
  const insertion = "\n\t// [crash-guard dsh-unknown-types-fix] 插件/遗留事件类型(拒载补丁, 见 dsh-crash-guard)\n\t" + ADD.join("\n\t");
  c = c.slice(0, insertAt) + insertion + c.slice(insertAt);
  fs.writeFileSync(f, c);
  // 语法校验
  try { require("child_process").execSync('node --check "' + f + '"', { stdio: "ignore" }); } catch (e) { console.log("语法错误, 回滚:", f); fs.copyFileSync(f + ".bak-unknown-types", f); continue; }
  patched++;
  console.log("已补:", f);
}
console.log("结果: 补丁=" + patched + " 已存在=" + already + " 失败=" + missing);
if (patched > 0) console.log("请重启 DSH 后打开历史会话(修复在服务进程加载时生效)。");
