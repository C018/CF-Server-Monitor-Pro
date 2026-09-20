#!/usr/bin/env node
/**
 * CF-Server-Monitor-Pro 构建脚本（零第三方依赖）
 *
 * 职责：
 *   1) 读取 src/index.js，写入 dist/_worker.js（Pages 单文件 Worker 入口）
 *   2) 将 src/index.js 覆盖同步到根目录 workers.js（保持源码与部署入口一致）
 *   3) 抽取 src/index.js 中由 @notify-core 标记包裹的告警引擎区块，按文件顺序拼接，
 *      追加 scheduled / fetch 入口，生成 cron/worker.js（独立定时告警 Worker，生成物，请勿手写）
 *   4) 对生成的 cron/worker.js 做语法校验（node --check），失败立即退出码 1 并打印原因
 *   5) 断言 cron/worker.js 零残留 SITE_URL / API_SECRET / /api/cron（不得依赖 Pages 侧 HTTP 接口）
 *   6) 输出每个产出文件的字节数与 SHA256，并断言三份入口文件哈希一致，不一致则退出码 1
 *
 * 标记形式（src/index.js 内）：
 *   @notify-core 起始标记： /* @notify-core:start *\/
 *   @notify-core 结束标记： /* @notify-core:end *\/
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.js');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_WORKER = path.join(DIST_DIR, '_worker.js');
const ROOT_WORKER = path.join(ROOT, 'workers.js');
const CRON_WORKER = path.join(ROOT, 'cron', 'worker.js');

// 标记行必须以独立的块注释形式出现，避免把说明性文字误判为标记
const RE_MARK_START = /^\s*\/\*\s*@notify-core:start\s*\*\/\s*$/;
const RE_MARK_END = /^\s*\/\*\s*@notify-core:end\s*\*\/\s*$/;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fail(msg) {
  console.error('[build] 失败：' + msg);
  process.exit(1);
}

/** 按文件顺序抽取 @notify-core 标记区块，返回 [{ startLine, endLine, text }]（行号 1-based，含边界） */
function extractNotifyCoreBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (RE_MARK_START.test(lines[i])) {
      if (open >= 0) fail('第 ' + (open + 1) + ' 行的 @notify-core:start 尚未闭合，又出现新的起始标记（第 ' + (i + 1) + ' 行）');
      open = i;
      continue;
    }
    if (RE_MARK_END.test(lines[i])) {
      if (open < 0) fail('第 ' + (i + 1) + ' 行出现 @notify-core:end，但没有对应的 @notify-core:start');
      if (i - open < 2) fail('第 ' + (open + 1) + ' 行到第 ' + (i + 1) + ' 行的 @notify-core 区块为空');
      blocks.push({ startLine: open + 2, endLine: i, text: lines.slice(open + 1, i).join('\n') });
      open = -1;
    }
  }
  if (open >= 0) fail('第 ' + (open + 1) + ' 行的 @notify-core:start 缺少对应的 @notify-core:end');
  if (blocks.length === 0) fail('src/index.js 中未找到任何 @notify-core 标记区块');
  return blocks;
}

const CRON_HEADER = [
  '/**',
  ' * CF-Server-Monitor-Pro 定时告警 Worker（独立部署，自动生成，请勿手写修改）',
  ' *',
  ' * 生成方式：node scripts/build.js 从 src/index.js 中 @notify-core 标记区块抽取 + 拼接入口',
  ' *          源文件：src/index.js（唯一真源），改动请改源文件后重新执行 npm run build',
  ' *',
  ' * 运行方式：本 Worker 直接绑定与 Pages 相同的 D1 数据库（变量名 DB）自行执行告警检查，',
  ' *          不依赖任何 Pages 侧 HTTP 接口，也不需要站点地址。',
  ' *',
  ' * 鉴权：仅 fetch 手动触发入口需要密钥（x-cf-secret 请求头或 ?secret= 查询参数），',
  ' *      通过 wrangler secret put API_SECRET -c cron/wrangler.toml 配置（勿写入明文）；',
  ' *      未配置时手动入口一律返回 403，定时触发（scheduled）不需要密钥。',
  ' *      该密钥与本 Pages 项目侧的 API_SECRET 各自独立，需分别配置。',
  ' *',
  ' * 部署：npm run deploy:cron（wrangler deploy -c cron/wrangler.toml）',
  ' * 绑定：Dashboard → Workers & Pages → 本 Worker → Settings → Bindings → D1 database bindings，',
  ' *      变量名填 DB，指向 Pages 项目使用的同一个数据库（如 monitor_db）。',
  ' *',
  ' * 容错：D1 表结构尚未初始化（缺表）或未绑定 DB 时，告警链路内部按 try/catch 降级，',
  ' *      返回失败原因而不会抛出异常，Worker 不会崩溃；待 Pages 首次访问完成建表后自动恢复正常。',
  ' */'
].join('\n');

const CRON_ENTRY = [
  '',
  '// ---- 手动入口鉴权（入口模板自带，常量时间比较）----',
  '// 与 Pages 侧手动触发接口的鉴权行为保持一致：取 x-cf-secret 请求头或 ?secret= 查询参数，未配置密钥一律拒绝。',
  '// 说明：Pages 侧的 safeEqual 定义在其 fetch 处理器内部（局部作用域），无法在不扩大 @notify-core',
  '//      抽取范围的前提下复用，故在入口模板内自带等价实现。',
  'function cronSafeEqual(a, b) {',
  '  const la = String(a || ""), lb = String(b || "");',
  '  let res = la.length === lb.length ? 0 : 1;',
  '  const n = Math.max(la.length, lb.length);',
  '  for (let i = 0; i < n; i++) res |= (la.charCodeAt(i) || 0) ^ (lb.charCodeAt(i) || 0);',
  '  return res === 0;',
  '}',
  '',
  'function cronForbidden() {',
  '  return new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {',
  '    status: 403,',
  '    headers: { "Content-Type": "application/json;charset=UTF-8" }',
  '  });',
  '}',
  '',
  'export default {',
  '  // Cron 触发（每分钟）：执行告警检查（含失败补发 drain），异步进行，不阻塞调度返回',
  '  // 定时入口由 Cron Triggers 触发，不需要密钥',
  '  async scheduled(controller, env, ctx) {',
  '    ctx.waitUntil(Promise.resolve().then(() => scheduledAlertCheck(env)));',
  '  },',
  '',
  '  // 手动触发入口：必须携带密钥（x-cf-secret 请求头或 ?secret= 查询参数），鉴权通过才执行告警检查并回显 JSON 结果',
  '  async fetch(request, env, ctx) {',
  '    // 未配置 API_SECRET 时一律拒绝，避免空值互相匹配导致鉴权被绕过',
  '    if (!env.API_SECRET) return cronForbidden();',
  '    const url = new URL(request.url);',
  '    const provided = request.headers.get("x-cf-secret") || url.searchParams.get("secret") || "";',
  '    if (!cronSafeEqual(provided, env.API_SECRET)) return cronForbidden();',
  '',
  '    const startedAt = Date.now();',
  '    try {',
  '      const result = await scheduledAlertCheck(env);',
  '      return new Response(JSON.stringify({ ok: true, triggered: "alert_check", elapsed_ms: Date.now() - startedAt, result }, null, 2), {',
  '        status: 200,',
  '        headers: { "Content-Type": "application/json;charset=UTF-8" }',
  '      });',
  '    } catch (e) {',
  '      return new Response(JSON.stringify({ ok: false, elapsed_ms: Date.now() - startedAt, error: String((e && e.message) || e) }, null, 2), {',
  '        status: 500,',
  '        headers: { "Content-Type": "application/json;charset=UTF-8" }',
  '      });',
  '    }',
  '  }',
  '};',
  ''
].join('\n');

/** 拼接生成 cron/worker.js 内容 */
function buildCronWorker(text) {
  const blocks = extractNotifyCoreBlocks(text);
  let out = CRON_HEADER + '\n\n';
  for (const b of blocks) out += b.text + '\n\n';
  out += CRON_ENTRY;
  return { code: out, blocks: blocks };
}

/** 语法校验：复制为 .mjs 交给 node --check（ESM 显式后缀，避免受 package.json type 影响） */
function checkSyntax(code, label) {
  const tmp = path.join(os.tmpdir(), 'cfmon-' + crypto.randomBytes(8).toString('hex') + '.mjs');
  try {
    fs.writeFileSync(tmp, code);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.error) fail(label + ' 语法校验无法执行：' + r.error.message);
    const errOut = ((r.stderr || '') + (r.stdout || '')).trim();
    if (r.status !== 0) fail(label + ' 语法校验未通过（node --check 退出码 ' + r.status + '）：\n' + errOut);
    return errOut;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略临时文件清理失败 */ }
  }
}

function main() {
  if (!fs.existsSync(SRC)) {
    fail('找不到源文件 ' + SRC);
  }

  const sourceBuf = fs.readFileSync(SRC);
  const sourceText = sourceBuf.toString('utf8');

  // ---- 1) 三份入口文件同步 ----
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(DIST_WORKER, sourceBuf);
  fs.writeFileSync(ROOT_WORKER, sourceBuf);

  // ---- 2) 生成 cron/worker.js ----
  const built = buildCronWorker(sourceText);
  const cronBuf = Buffer.from(built.code, 'utf8');

  if (built.code.indexOf('function scheduledAlertCheck') < 0) {
    fail('抽取结果中缺少 scheduledAlertCheck，请检查 src/index.js 的 @notify-core 标记边界');
  }
  const cronText = cronBuf.toString('utf8');

  // 残留依赖校验（精确到用途，不再一律禁止 API_SECRET）：
  //  1) 严禁 SITE_URL：定时 Worker 不得依赖 Pages 站点地址
  //  2) 严禁 /api/cron 与 pages.dev：不得向 Pages 侧发起任何请求
  //  3) @notify-core 抽取区块（告警链路本体）内 API_SECRET 必须 0 命中
  //  4) API_SECRET 仅允许用于入口模板的两处鉴权语句：空值拒绝 + 常量时间比对
  const residual = cronText.match(/SITE_URL|\/api\/cron|pages\.dev/gi);
  if (residual) {
    fail('生成的 cron/worker.js 残留 Pages 侧依赖：' + Array.from(new Set(residual)).join(', '));
  }

  const blocksText = built.blocks.map((b) => b.text).join('\n');
  if (blocksText.indexOf('API_SECRET') >= 0) {
    fail('@notify-core 抽取区块内出现 API_SECRET，鉴权逻辑只应存在于生成物入口模板中');
  }
  const secretUses = cronText.match(/env\.API_SECRET/g) || [];
  if (secretUses.length !== 2) {
    fail('生成的 cron/worker.js 中 env.API_SECRET 应恰好出现 2 次（空值拒绝 + 常量时间比对），实际 ' + secretUses.length + ' 次');
  }
  if (!/if \(!env\.API_SECRET\) return cronForbidden\(\);/.test(cronText)) {
    fail('生成的 cron/worker.js 缺少「未配置 API_SECRET 一律拒绝」判断');
  }
  if (!/if \(!cronSafeEqual\(provided, env\.API_SECRET\)\) return cronForbidden\(\);/.test(cronText)) {
    fail('生成的 cron/worker.js 缺少常量时间比较的鉴权判断');
  }
  if (cronText.indexOf('x-cf-secret') < 0) {
    fail('生成的 cron/worker.js 缺少 x-cf-secret 请求头读取');
  }
  console.log('[build] 残留依赖校验通过：SITE_URL / /api/cron / pages.dev 零命中；API_SECRET 仅用于入口鉴权（用途校验通过）');

  fs.mkdirSync(path.dirname(CRON_WORKER), { recursive: true });
  fs.writeFileSync(CRON_WORKER, cronBuf);
  checkSyntax(built.code, 'cron/worker.js');

  // ---- 3) 产出清单与哈希一致性 ----
  const targets = [
    { label: 'src/index.js    (源文件)', file: SRC },
    { label: 'workers.js      (根目录部署入口，与源码保持同步)', file: ROOT_WORKER },
    { label: 'dist/_worker.js (Pages 构建产物)', file: DIST_WORKER }
  ];

  const hashes = [];
  console.log('[build] 三份入口文件：');
  for (const t of targets) {
    const buf = fs.readFileSync(t.file);
    const h = sha256(buf);
    hashes.push(h);
    console.log('  - ' + t.label);
    console.log('      路径   : ' + t.file);
    console.log('      字节数 : ' + buf.length + ' B');
    console.log('      SHA256 : ' + h);
  }

  const consistent = hashes.every((h) => h === hashes[0]);
  if (!consistent) {
    fail('三份入口文件 SHA256 不一致，请检查是否有文件被独立修改');
  }

  console.log('[build] cron/worker.js（生成物）：');
  console.log('  - 抽取区块数 : ' + built.blocks.length);
  for (const b of built.blocks) {
    console.log('      src/index.js 第 ' + b.startLine + ' - ' + b.endLine + ' 行（' + (b.endLine - b.startLine + 1) + ' 行）');
  }
  console.log('      路径   : ' + CRON_WORKER);
  console.log('      字节数 : ' + cronBuf.length + ' B');
  console.log('      SHA256 : ' + sha256(cronBuf));
  console.log('      校验   : node --check 通过；零残留 SITE_URL / /api/cron / pages.dev；API_SECRET 仅用于 fetch 手动入口鉴权');

  console.log('[build] 成功：三份入口文件 SHA256 一致 -> ' + hashes[0]);
}

main();
