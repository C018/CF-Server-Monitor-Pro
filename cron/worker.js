/**
 * CF-Server-Monitor-Pro 定时告警 Worker（独立部署，自动生成，请勿手写修改）
 *
 * 生成方式：node scripts/build.js 从 src/index.js 中 @notify-core 标记区块抽取 + 拼接入口
 *          源文件：src/index.js（唯一真源），改动请改源文件后重新执行 npm run build
 *
 * 运行方式：本 Worker 直接绑定与 Pages 相同的 D1 数据库（变量名 DB）自行执行告警检查，
 *          不依赖任何 Pages 侧 HTTP 接口，也不需要站点地址。
 *
 * 鉴权：仅 fetch 手动触发入口需要密钥（x-cf-secret 请求头或 ?secret= 查询参数），
 *      通过 wrangler secret put API_SECRET -c cron/wrangler.toml 配置（勿写入明文）；
 *      未配置时手动入口一律返回 403，定时触发（scheduled）不需要密钥。
 *      该密钥与本 Pages 项目侧的 API_SECRET 各自独立，需分别配置。
 *
 * 部署：npm run deploy:cron（wrangler deploy -c cron/wrangler.toml）
 * 绑定：Dashboard → Workers & Pages → 本 Worker → Settings → Bindings → D1 database bindings，
 *      变量名填 DB，指向 Pages 项目使用的同一个数据库（如 monitor_db）。
 *
 * 容错：D1 表结构尚未初始化（缺表）或未绑定 DB 时，告警链路内部按 try/catch 降级，
 *      返回失败原因而不会抛出异常，Worker 不会崩溃；待 Pages 首次访问完成建表后自动恢复正常。
 */

// Telegram 告警专用转义（模块顶层，供 Cron 定时扫描复用）
const tgEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===== 通知中心多通道引擎（通知重构第2步A：Provider 抽象 + 统一发送入口，纯新增，不接管现有调用链） =====
// Provider 接口约定：
//   { id, type, name, configSchema, validate(cfg) -> {ok, error}, send(payload, cfg) -> {ok, status, retryAfter, error} }
// payload 约定：{ text, title?, markdown?, level?, keyboard?, edit?, message_id?, chat_id?, timestamp? }
const NOTIFY_DEFAULT_TIMEOUT_MS = 10000;
const notifyProviders = new Map();
function notifyRegisterProvider(provider) {
  if (provider && provider.type) notifyProviders.set(String(provider.type), provider);
  return provider;
}
function notifyListProviders() {
  return Array.from(notifyProviders.values()).map(p => ({ id: p.id, type: p.type, name: p.name, configSchema: p.configSchema || {} }));
}
function notifyGetProvider(type) {
  return notifyProviders.get(String(type || '')) || null;
}
function notifyNormalizeConfig(cfg) {
  if (!cfg) return {};
  if (typeof cfg === 'string') { try { const o = JSON.parse(cfg); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
  return (typeof cfg === 'object') ? cfg : {};
}
function notifyTimeoutMs(cfg) {
  const t = parseInt((cfg || {}).timeout_ms, 10);
  return (isNaN(t) || t <= 0) ? NOTIFY_DEFAULT_TIMEOUT_MS : t;
}
function notifyFail(error, status) { return { ok: false, status: status || 0, retryAfter: 0, error: String(error || '') }; }

// ---- 内置 Provider 1/2：Telegram（请求形态与后台机器人 tgSend / tgEdit 一致：HTML parse_mode + inline keyboard） ----
notifyRegisterProvider({
  id: 'telegram', type: 'telegram', name: 'Telegram',
  configSchema: {
    bot_token: { label: 'Bot Token', type: 'password', required: true },
    chat_id: { label: 'Chat ID', type: 'string', required: true },
    api_base: { label: 'API 网关', type: 'string', default: 'https://api.telegram.org' },
    parse_mode: { label: '解析模式', type: 'select', options: ['HTML', 'MarkdownV2', 'none'], default: 'HTML' },
    disable_notification: { label: '静默推送', type: 'boolean', default: false },
    timeout_ms: { label: '超时(ms)', type: 'number', default: NOTIFY_DEFAULT_TIMEOUT_MS }
  },
  validate(cfg) {
    if (!cfg || !cfg.bot_token) return { ok: false, error: 'missing_bot_token' };
    if (!cfg.chat_id) return { ok: false, error: 'missing_chat_id' };
    return { ok: true, error: '' };
  },
  async send(payload, cfg) {
    const p = payload || {};
    const isEdit = !!(p.edit && p.message_id);
    const method = isEdit ? 'editMessageText' : 'sendMessage';
    const parseMode = (cfg.parse_mode === undefined || cfg.parse_mode === null) ? 'HTML' : String(cfg.parse_mode);
    const body = { chat_id: (p.chat_id || cfg.chat_id), text: String(p.text == null ? '' : p.text) };
    if (parseMode && parseMode !== 'none') body.parse_mode = parseMode;
    if (isEdit) body.message_id = p.message_id;
    const kb = p.keyboard || p.reply_markup;
    if (kb) body.reply_markup = kb;
    if (cfg.disable_notification && !isEdit) body.disable_notification = true;
    let res;
    try {
      res = await fetch(`${cfg.api_base || 'https://api.telegram.org'}/bot${cfg.bot_token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(notifyTimeoutMs(cfg))
      });
    } catch (e) { return notifyFail((e && e.message) || e); }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.ok && data && data.ok) return { ok: true, status: res.status, retryAfter: 0, error: '' };
    const retryAfter = (data && data.parameters && parseInt(data.parameters.retry_after, 10)) || 0;
    return { ok: false, status: res.status, retryAfter, error: (data && data.description) || ('http_' + res.status) };
  }
});

// ---- 内置 Provider 2/2：通用 Webhook（POST JSON，覆盖 Bark / Server酱 / PushPlus / 钉钉 / 飞书 / 企业微信 / ntfy / 自建） ----
const NOTIFY_WEBHOOK_PRESETS = ['custom', 'bark', 'serverchan', 'pushplus', 'dingtalk', 'feishu', 'wecom', 'ntfy'];
function notifyWebhookRequest(payload, cfg) {
  const p = payload || {};
  const preset = String(cfg.preset || 'custom').toLowerCase();
  const title = String(p.title || 'CF-Server-Monitor-Pro 通知');
  const text = String(p.text == null ? '' : p.text);
  const headers = Object.assign({}, cfg.headers || {});
  if (!headers['User-Agent']) headers['User-Agent'] = 'CF-Server-Monitor-Pro/Notify';
  let bodyObj = null, rawBody = null;
  if (preset === 'bark') {
    bodyObj = { title, body: text, group: cfg.group || 'CF监控', level: p.level || 'active' };
  } else if (preset === 'serverchan') {
    bodyObj = { title, desp: text };
  } else if (preset === 'pushplus') {
    bodyObj = { token: cfg.token || '', title, content: text, template: 'html' };
  } else if (preset === 'dingtalk') {
    bodyObj = p.markdown ? { msgtype: 'markdown', markdown: { title, text } } : { msgtype: 'text', text: { content: title + '\n' + text } };
  } else if (preset === 'feishu' || preset === 'lark') {
    bodyObj = p.markdown
      ? { msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: title } }, elements: [{ tag: 'markdown', content: text }] } }
      : { msg_type: 'text', content: { text: title + '\n' + text } };
  } else if (preset === 'wecom') {
    bodyObj = { msgtype: 'text', text: { content: title + '\n' + text } };
  } else if (preset === 'ntfy') {
    if (!headers['Title']) headers['Title'] = encodeURIComponent(title);
    if (cfg.token && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + cfg.token;
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    rawBody = title + '\n' + text;
  } else {
    bodyObj = { title, text, content: text, level: p.level || 'info', markdown: !!p.markdown, channel: cfg.name || '', source: 'CF-Server-Monitor-Pro', timestamp: p.timestamp || Date.now() };
  }
  if (rawBody === null) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    rawBody = JSON.stringify(bodyObj);
  }
  return { url: String(cfg.url || ''), method: String(cfg.method || 'POST').toUpperCase(), headers, body: rawBody };
}
notifyRegisterProvider({
  id: 'webhook', type: 'webhook', name: '通用 Webhook',
  configSchema: {
    preset: { label: '平台预设', type: 'select', options: NOTIFY_WEBHOOK_PRESETS, default: 'custom' },
    url: { label: '推送地址', type: 'string', required: true },
    method: { label: '请求方法', type: 'select', options: ['POST', 'PUT', 'GET'], default: 'POST' },
    headers: { label: '自定义请求头', type: 'object', default: {} },
    token: { label: 'Token / Key', type: 'string' },
    timeout_ms: { label: '超时(ms)', type: 'number', default: NOTIFY_DEFAULT_TIMEOUT_MS }
  },
  validate(cfg) {
    if (!cfg || !cfg.url) return { ok: false, error: 'missing_url' };
    if (!/^https?:\/\//i.test(String(cfg.url))) return { ok: false, error: 'invalid_url' };
    return { ok: true, error: '' };
  },
  async send(payload, cfg) {
    const req = notifyWebhookRequest(payload, cfg);
    const opts = { method: req.method, headers: req.headers, signal: AbortSignal.timeout(notifyTimeoutMs(cfg)) };
    let url = req.url;
    if (req.method === 'GET') url += (url.indexOf('?') === -1 ? '?' : '&') + 'data=' + encodeURIComponent(req.body);
    else opts.body = req.body;
    let res;
    try { res = await fetch(url, opts); } catch (e) { return notifyFail((e && e.message) || e); }
    if (res.ok) return { ok: true, status: res.status, retryAfter: 0, error: '' };
    let tip = '';
    try { tip = String((await res.text()) || '').slice(0, 200); } catch (e) {}
    return { ok: false, status: res.status, retryAfter: 0, error: tip || ('http_' + res.status) };
  }
});

// ---- 统一发送入口：入参为 notify_channels 的一行（或等价对象），config 支持对象或 JSON 字符串 ----
async function sendViaChannel(channel, payload) {
  const out = { ok: false, status: 0, retryAfter: 0, error: '', provider: '', channel_id: '', channel_type: '' };
  if (!channel) { out.error = 'missing_channel'; return out; }
  out.channel_id = String(channel.id || '');
  out.channel_type = String(channel.type || '');
  if (channel.enabled === 0 || channel.enabled === '0' || channel.enabled === false) { out.error = 'channel_disabled'; return out; }
  const provider = notifyGetProvider(channel.type);
  if (!provider) { out.error = 'provider_not_found:' + String(channel.type || ''); return out; }
  out.provider = provider.id || provider.type;
  const cfg = notifyNormalizeConfig(channel.config);
  const v = provider.validate(cfg);
  if (!v || v.ok !== true) { out.error = (v && v.error) || 'config_invalid'; return out; }
  let r;
  try { r = await provider.send(payload || {}, cfg); } catch (e) { return Object.assign(out, notifyFail((e && e.message) || e)); }
  out.ok = !!(r && r.ok);
  out.status = (r && r.status) || 0;
  out.retryAfter = (r && r.retryAfter) || 0;
  out.error = (r && r.error) || '';
  return out;
}
// 按通道 ID 从 notify_channels 读取配置后发送（DB 行 → sendViaChannel）
async function sendViaChannelId(env, channelId, payload) {
  try {
    const row = await env.DB.prepare('SELECT id, type, name, config, enabled FROM notify_channels WHERE id = ?').bind(String(channelId)).first();
    if (!row) return { ok: false, status: 0, retryAfter: 0, error: 'channel_not_found', provider: '', channel_id: String(channelId), channel_type: '' };
    return await sendViaChannel(row, payload);
  } catch (e) { return notifyFail((e && e.message) || e); }
}
// 解析当前生效的 Telegram 通道：优先 notify_channels 中启用的 telegram 通道（默认通道优先），
// 通道缺失或配置不完整时回退旧 settings（tg_bot_token / tg_chat_id）映射
async function notifyResolveTelegramChannel(env, settings) {
  try {
    const { results } = await env.DB.prepare("SELECT id, type, name, config, enabled FROM notify_channels WHERE type = 'telegram' AND enabled = 1 ORDER BY created_at ASC").all();
    if (results && results.length) {
      const pick = results.find(r => r.id === 'ch_telegram_default') || results[0];
      const cfg = notifyNormalizeConfig(pick.config);
      if (cfg.bot_token && cfg.chat_id) return pick;
    }
  } catch (e) {}
  return buildLegacyTelegramChannel(settings);
}
// 把旧 settings（tg_bot_token / tg_chat_id）映射为通道对象，供后续步骤接棒时复用
function buildLegacyTelegramChannel(settings) {
  const s = settings || {};
  const cfg = {};
  if (s.tg_bot_token) cfg.bot_token = s.tg_bot_token;
  if (s.tg_chat_id) cfg.chat_id = s.tg_chat_id;
  cfg.parse_mode = 'HTML';
  return { id: 'ch_telegram_default', type: 'telegram', name: '默认 Telegram 通道', config: cfg, enabled: 1, legacy: true };
}
// ===== 通知中心多通道引擎 END =====

// ===== 通知规则引擎（通知重构第3步A-1：纯函数骨架 + offline / recover 两类基础规则，无副作用、不发送） =====
// 入口：evaluateNotifyRules(rules, servers, state, now) -> events[]
//   rules   : notify_rules 行数组 {id,name,enabled,type,scope,params,severity,cooldown,silent_window,recover_notify}
//   servers : 节点数组 {id,name,group,tags,last_updated,...}
//   state   : 状态表快照 { "<rule_id>::<server_id>": {state,since,last_notified_at,fire_count} }
//   now     : 当前时间戳(ms)
// 约定：不读写外部资源、不修改入参；需要落库的变更以 state_op 挂在事件上（collectNotifyStateOps 折叠）；
//       仅 deliverable === true 的事件需要发送，其余为抑制/清理事件。
const NOTIFY_SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const NOTIFY_OFFLINE_DEFAULT_THRESHOLD = 120;
const NOTIFY_REPEAT_DEFAULT_SEC = 1800;   // 离线持续告警重复提醒默认间隔（秒）：firing 状态下距上次提醒超过该间隔则再次推送
const NOTIFY_REPEAT_MIN_SEC = 60;         // 重复提醒间隔下限（秒），防止配置过小导致刷屏
const NOTIFY_TRAFFIC_DEFAULT_THRESHOLD = 90;
const NOTIFY_EXPIRE_DEFAULT_DAYS = 7;
function notifyStateKey(ruleId, serverId) { return String(ruleId) + '::' + String(serverId); }
function notifyToNum(v) { if (v === null || v === undefined || v === '') return null; const n = (typeof v === 'number') ? v : parseFloat(v); return isNaN(n) ? null : n; }
function notifyTruthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
function notifySeverityRank(sev) { const r = NOTIFY_SEVERITY_RANK[String(sev || 'warning')]; return (r === undefined) ? 1 : r; }
// scope 匹配：{all, groups[], ids[], tags[]}，三类列表皆空或 all!==false 视为全量
function notifyMatchScope(scope, server) {
  const s = (scope && typeof scope === 'object') ? scope : (notifyNormalizeConfig(scope) || {});
  if (s.all === false) return false;
  const groups = Array.isArray(s.groups) ? s.groups.map(String) : [];
  const ids = Array.isArray(s.ids) ? s.ids.map(String) : [];
  const tags = Array.isArray(s.tags) ? s.tags.map(String) : [];
  if (!groups.length && !ids.length && !tags.length) return true;
  const sv = server || {};
  if (ids.indexOf(String(sv.id)) !== -1) return true;
  if (groups.length && groups.indexOf(String(sv.group || '')) !== -1) return true;
  const stags = Array.isArray(sv.tags) ? sv.tags.map(String) : [];
  for (const t of tags) { if (stags.indexOf(t) !== -1) return true; }
  return false;
}
// 免打扰时段：'22:00-08:00' / 多段以 , 或 ; 分隔；空/off/none 表示关闭；按中国上海时区判定
function notifyShanghaiMinutes(now) {
  try {
    const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
    const p = String(t).split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  } catch (e) { const d = new Date(now + 8 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
}
function notifySilentWindowActive(spec, now) {
  const s = String(spec === null || spec === undefined ? '' : spec).trim().toLowerCase();
  if (!s || s === 'off' || s === 'none' || s === '0' || s === 'false') return false;
  const mins = notifyShanghaiMinutes(now);
  for (const tok of s.split(/[,;]/)) {
    const m = String(tok).trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const a = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const b = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (a === b) return true;
    if (a < b) { if (mins >= a && mins < b) return true; }
    else { if (mins >= a || mins < b) return true; }
  }
  return false;
}
function notifyEventTime(now) { return new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
function notifyOfflineThresholdMs(rule) {
  const p = notifyNormalizeConfig((rule || {}).params);
  const thr = notifyToNum(p.threshold);
  const extra = notifyToNum(p.forDuration === undefined ? p.for_duration : p.forDuration) || 0;
  const base = (thr === null || thr < 0) ? NOTIFY_OFFLINE_DEFAULT_THRESHOLD : thr;
  return { baseMs: base * 1000, forMs: extra * 1000, thresholdSec: base, forDurationSec: extra };
}

// 离线重复提醒间隔（秒）：params.repeat_interval > params.repeat > params.cooldown > rule.cooldown > 默认值
// 约束：不低于 rule.cooldown（冷却下限）与聚合摘要窗口（避免同窗口去重键冲突导致续报被吞），且不小于 NOTIFY_REPEAT_MIN_SEC
function notifyOfflineRepeatSec(rule) {
  const r = (rule && typeof rule === 'object') ? rule : {};
  const p = notifyNormalizeConfig(r.params) || {};
  const read = (k) => { const v = notifyToNum(p[k]); return (v !== null && v > 0) ? v : null; };
  let sec = read('repeat_interval');
  if (sec === null) sec = read('repeatInterval');
  if (sec === null) sec = read('repeat');
  if (sec === null) sec = read('repeat_sec');
  if (sec === null) sec = read('cooldown');
  if (sec === null) {
    const cd0 = notifyToNum(r.cooldown);
    sec = (cd0 !== null && cd0 > 0) ? cd0 : NOTIFY_REPEAT_DEFAULT_SEC;
  }
  const cd = notifyToNum(r.cooldown) || 0;
  if (cd > sec) sec = cd;
  const dg = notifyDigestSpec(r);
  if (dg && dg.enabled && dg.windowSec > sec) sec = dg.windowSec;
  return Math.max(NOTIFY_REPEAT_MIN_SEC, Math.floor(sec));
}
function notifyCollectStateOps(events) {
  const patch = { upsert: [], remove: [] };
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    const op = ev && ev.state_op;
    if (!op) continue;
    if (op.op === 'delete') patch.remove.push({ rule_id: op.rule_id, server_id: op.server_id, key: op.key });
    else if (op.op === 'upsert') patch.upsert.push(op.row);
  }
  return patch;
}
// 事件构造骨架
function notifyBuildEvent(rule, over) {
  return Object.assign({
    rule_id: String((rule || {}).id || ''), rule_name: String((rule || {}).name || ''), rule_type: String((rule || {}).type || ''),
    kind: 'fire', deliverable: false, suppressed_by: null,
    severity: String((rule || {}).severity || 'warning'), severity_rank: notifySeverityRank((rule || {}).severity),
    server_id: null, server_name: '', group: '',
    title: '', text: '', html: '', metrics: null, state_op: null, dedupe_key: '', at: 0
  }, over || {});
}
// metric 规则辅助：指标字段映射 / 阈值解析 / 取值与比较（复用骨架既有语义）
const NOTIFY_METRIC_FIELDS = {
  cpu: { key: 'cpu', field: 'cpu', label: 'CPU 使用率', unit: '%' },
  ram: { key: 'ram', field: 'ram', label: '内存使用率', unit: '%' },
  disk: { key: 'disk', field: 'disk', label: '磁盘使用率', unit: '%' },
  load: { key: 'load', field: 'load_avg', label: '系统负载', unit: '' }
};
function notifyMetricField(metric) {
  const k = String(metric === null || metric === undefined ? '' : metric).trim().toLowerCase();
  return NOTIFY_METRIC_FIELDS[k] || null;
}
function notifyMetricSpec(rule, meta) {
  const p = notifyNormalizeConfig((rule || {}).params);
  const thr = notifyToNum(p.threshold);
  const forRaw = (p.forDuration === undefined ? p.for_duration : p.forDuration);
  const extra = notifyToNum(forRaw) || 0;
  const clearRaw = (p.clear_threshold === undefined ? p.clearThreshold : p.clear_threshold);
  const clearNum = notifyToNum(clearRaw);
  // 未显式给出恢复阈值时，回退为与触发阈值同值（靠 forDuration 与去抖动阈值分离实现防抖）
  const clear = (clearNum === null) ? thr : clearNum;
  return {
    metric: meta ? meta.key : null, label: meta ? meta.label : '', unit: meta ? meta.unit : '',
    threshold: thr, clearThreshold: clear, forMs: extra * 1000, forDurationSec: extra,
    hasThreshold: thr !== null
  };
}
function notifyMetricValue(server, meta) {
  if (!server || !meta) return null;
  return notifyToNum(server[meta.field]);
}
function notifyMetricBreached(value, spec) {
  if (!spec || !spec.hasThreshold || value === null) return false;
  return value > spec.threshold;
}
function notifyMetricCleared(value, spec) {
  if (!spec || spec.clearThreshold === null || value === null) return false;
  return value <= spec.clearThreshold;
}
function notifyMetricEventText(server, meta, spec, value, kind, nowMs) {
  const name = String((server || {}).name || '');
  const label = meta ? meta.label : '指标';
  const unit = meta ? meta.unit : '';
  const cur = (value === null || value === undefined) ? '-' : (value + unit);
  const thr = (spec && spec.threshold !== null && spec.threshold !== undefined) ? (spec.threshold + unit) : '-';
  const cthr = (spec && spec.clearThreshold !== null && spec.clearThreshold !== undefined) ? (spec.clearThreshold + unit) : '-';
  const time = notifyEventTime(nowMs);
  const isRec = (kind === 'recover' || kind === 'clear');
  const isPend = (kind === 'pending');
  const title = isRec ? '指标恢复通知' : (isPend ? '指标待确认' : '指标告警');
  const stateLabel = isRec ? '已回落' : (isPend ? '超阈值待确认' : '超阈值');
  const limitLabel = isRec ? '恢复阈值' : '触发阈值';
  const limitVal = isRec ? cthr : thr;
  const icon = isRec ? '✅' : '⚠️';
  const plain = title + '\n\n节点名称: ' + name + '\n状态: ' + label + ' ' + stateLabel + '\n当前值: ' + cur + '\n' + limitLabel + ': ' + limitVal + '\n时间: ' + time;
  const html = icon + ' <b>' + title + '</b>\n\n<b>节点名称:</b> ' + tgEsc(name) + '\n<b>状态:</b> ' + label + ' ' + stateLabel + '\n<b>当前值:</b> ' + cur + '\n<b>' + limitLabel + ':</b> ' + limitVal + '\n<b>时间:</b> ' + time;
  return { title: title, text: plain, html: html };
}
// traffic_ratio / expire_days 规则辅助：字节解析与格式化 / 阈值解析 / 到期日解析 / 事件文案
const NOTIFY_BYTES_UNITS = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776, pb: 1125899906842624 };
function notifyParseBytes(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return (isFinite(v) && v > 0) ? v : null;
  const str = String(v).trim();
  if (!str) return null;
  const m = str.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!isFinite(num) || num <= 0) return null;
  const u = String(m[2] || '').trim().toLowerCase();
  if (!u) return num;
  const alias = { k: 'kb', kb: 'kb', m: 'mb', mb: 'mb', g: 'gb', gb: 'gb', t: 'tb', tb: 'tb', p: 'pb', pb: 'pb', b: 'b', byte: 'b', bytes: 'b' };
  const key = alias[u];
  return (key && NOTIFY_BYTES_UNITS[key]) ? num * NOTIFY_BYTES_UNITS[key] : null;
}
function notifyFormatBytes(v) {
  if (v === null || v === undefined || !isFinite(v)) return '-';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Number(v), i = 0;
  while (n >= 1024 && i < sizes.length - 1) { n = n / 1024; i++; }
  return (i === 0 ? Math.round(n) : Math.round(n * 100) / 100) + ' ' + sizes[i];
}
function notifyRatioSpec(rule) {
  const p = notifyNormalizeConfig((rule || {}).params);
  let thr = notifyToNum(p.threshold);
  if (thr === null) thr = NOTIFY_TRAFFIC_DEFAULT_THRESHOLD;
  if (thr > 0 && thr <= 1) thr = thr * 100; // 兼容 0.8 形式的比例写法
  const clearRaw = (p.clear_threshold === undefined ? p.clearThreshold : p.clear_threshold);
  let clear = notifyToNum(clearRaw);
  if (clear === null) clear = thr;
  else if (clear > 0 && clear <= 1) clear = clear * 100;
  return { threshold: thr, clearThreshold: clear };
}
function notifyTrafficUsed(server) {
  const rx = notifyToNum(server ? server.monthly_rx : null);
  const tx = notifyToNum(server ? server.monthly_tx : null);
  if (rx === null && tx === null) return null;
  return (rx || 0) + (tx || 0);
}
function notifyParseDateMs(v) {
  const str = String(v === null || v === undefined ? '' : v).trim();
  if (!str) return null;
  const m = str.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const t = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return isNaN(t) ? null : t;
  }
  const t2 = new Date(str).getTime();
  return isNaN(t2) ? null : t2;
}
function notifyExpireSpec(rule) {
  const p = notifyNormalizeConfig((rule || {}).params);
  const thr = notifyToNum(p.threshold);
  const clearRaw = (p.clear_threshold === undefined ? p.clearThreshold : p.clear_threshold);
  const clearNum = notifyToNum(clearRaw);
  const base = (thr === null || thr < 0) ? NOTIFY_EXPIRE_DEFAULT_DAYS : thr;
  return { threshold: base, clearThreshold: (clearNum === null) ? base : clearNum };
}
function notifyTrafficEventText(server, spec, metrics, kind, nowMs) {
  const name = String((server || {}).name || '');
  const isRec = (kind === 'recover' || kind === 'clear');
  const title = isRec ? '流量恢复通知' : '流量告警';
  const icon = isRec ? '✅' : '⚠️';
  const used = notifyFormatBytes(metrics ? metrics.used_bytes : null);
  const limit = notifyFormatBytes(metrics ? metrics.limit_bytes : null);
  const rp = (metrics && metrics.ratio_percent !== null && metrics.ratio_percent !== undefined) ? (Math.round(metrics.ratio_percent * 10) / 10 + '%') : '-';
  const limitLabel = isRec ? '恢复阈值' : '告警阈值';
  const limitVal = (isRec ? spec.clearThreshold : spec.threshold) + '%';
  const stateLabel = isRec ? '已回落' : '用量超阈值';
  const time = notifyEventTime(nowMs);
  const plain = title + '\n\n节点名称: ' + name + '\n状态: 月流量 ' + stateLabel + '\n已用流量: ' + used + ' / ' + limit + '\n当前占比: ' + rp + '\n' + limitLabel + ': ' + limitVal + '\n时间: ' + time;
  const html = icon + ' <b>' + title + '</b>\n\n<b>节点名称:</b> ' + tgEsc(name) + '\n<b>状态:</b> 月流量 ' + stateLabel + '\n<b>已用流量:</b> ' + used + ' / ' + limit + '\n<b>当前占比:</b> ' + rp + '\n<b>' + limitLabel + ':</b> ' + limitVal + '\n<b>时间:</b> ' + time;
  return { title: title, text: plain, html: html };
}
function notifyExpireEventText(server, spec, metrics, kind, nowMs) {
  const name = String((server || {}).name || '');
  const isRec = (kind === 'recover' || kind === 'clear');
  const title = isRec ? '到期提醒解除' : '到期提醒';
  const icon = isRec ? '✅' : '⚠️';
  const days = (metrics && metrics.days_left !== null && metrics.days_left !== undefined) ? metrics.days_left : null;
  const dayText = (days === null) ? '-' : (days < 0 ? ('已过期 ' + Math.abs(days) + ' 天') : (days + ' 天'));
  const limitLabel = isRec ? '解除阈值' : '提醒阈值';
  const limitVal = (isRec ? spec.clearThreshold : spec.threshold) + ' 天';
  const stateLabel = isRec ? '已解除' : '临近到期';
  const expText = String((server || {}).expire_date || '-');
  const time = notifyEventTime(nowMs);
  const plain = title + '\n\n节点名称: ' + name + '\n状态: ' + stateLabel + '\n到期日期: ' + expText + '\n剩余时间: ' + dayText + '\n' + limitLabel + ': ' + limitVal + '\n时间: ' + time;
  const html = icon + ' <b>' + title + '</b>\n\n<b>节点名称:</b> ' + tgEsc(name) + '\n<b>状态:</b> ' + stateLabel + '\n<b>到期日期:</b> ' + tgEsc(expText) + '\n<b>剩余时间:</b> ' + dayText + '\n<b>' + limitLabel + ':</b> ' + limitVal + '\n<b>时间:</b> ' + time;
  return { title: title, text: plain, html: html };
}
function evaluateNotifyRules(rules, servers, state, now) {
  const nowMs = notifyToNum(now) === null ? Date.now() : notifyToNum(now);
  const ruleList = (Array.isArray(rules) ? rules : []).filter(r => r && r.enabled !== 0 && r.enabled !== '0' && r.enabled !== false);
  const serverList = Array.isArray(servers) ? servers : [];
  const stateMap = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  const readState = (ruleId, serverId) => { const v = stateMap[notifyStateKey(ruleId, serverId)]; return (v && typeof v === 'object') ? v : null; };
  const byId = new Map();
  for (const r of ruleList) byId.set(String(r.id), r);
  // recover 规则最后处理（需先收集归属规则已产出的恢复事件）
  const ordered = ruleList.slice().sort((a, b) => (String(a.type) === 'recover' ? 1 : 0) - (String(b.type) === 'recover' ? 1 : 0));
  const events = [];
  const ownerRecovered = new Set();
  for (const rule of ordered) {
    const type = String(rule.type || '');
    if (type !== 'offline' && type !== 'recover' && type !== 'metric' && type !== 'traffic_ratio' && type !== 'expire_days') continue;
    const scope = notifyNormalizeConfig(rule.scope);
    const cooldownSec = notifyToNum(rule.cooldown) || 0;
    const silentSpec = rule.silent_window;
    const silentNow = notifySilentWindowActive(silentSpec, nowMs);
    const recoverNotify = notifyTruthy(rule.recover_notify);
    const matched = serverList.filter(s => notifyMatchScope(scope, s));
    const emit = (server, kind, metrics, action) => {
      const sid = String(server.id);
      const isRecover = (kind === 'recover');
      const plain = isRecover
        ? `节点恢复通知\n\n节点名称: ${server.name}\n状态: 恢复在线\n时间: ${notifyEventTime(nowMs)}`
        : `节点离线告警\n\n节点名称: ${server.name}\n状态: 离线 (超过判定阈值未上报)\n时间: ${notifyEventTime(nowMs)}`;
      const html = isRecover
        ? `✅ <b>节点恢复通知</b>\n\n<b>节点名称:</b> ${tgEsc(server.name)}\n<b>状态:</b> 恢复在线\n<b>时间:</b> ${notifyEventTime(nowMs)}`
        : `⚠️ <b>节点离线告警</b>\n\n<b>节点名称:</b> ${tgEsc(server.name)}\n<b>状态:</b> 离线 (超过判定阈值未上报)\n<b>时间:</b> ${notifyEventTime(nowMs)}`;
      events.push(notifyBuildEvent(rule, {
        kind, deliverable: false, server_id: sid, server_name: String(server.name || ''), group: String(server.group || ''),
        title: isRecover ? '节点恢复通知' : '节点离线告警', text: plain, html,
        metrics: metrics || null, state_op: action || null,
        dedupe_key: [String(rule.id), sid, kind].join('::'), at: nowMs
      }));
      return events[events.length - 1];
    };
    const gateFire = (ev, prev, fireCount, since) => {
      const sid2 = String(ev.server_id);
      if (cooldownSec > 0 && prev && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) {
        ev.deliverable = false; ev.suppressed_by = 'cooldown';
        ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid2, state: 'firing', since: since, last_notified_at: notifyToNum(prev.last_notified_at), fire_count: fireCount } };
      } else if (silentNow) {
        ev.deliverable = false; ev.suppressed_by = 'silent_window';
        ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid2, state: 'firing', since: since, last_notified_at: notifyToNum(prev && prev.last_notified_at) || 0, fire_count: fireCount } };
      } else ev.deliverable = true;
      return ev;
    };
    const gateRecover = (ev, prev) => {
      if (!recoverNotify) return ev;
      ownerRecovered.add(notifyStateKey(rule.id, String(ev.server_id)));
      if (silentNow) { ev.deliverable = false; ev.suppressed_by = 'silent_window'; }
      else if (cooldownSec > 0 && prev && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) { ev.deliverable = false; ev.suppressed_by = 'cooldown'; }
      else ev.deliverable = true;
      return ev;
    };
    if (type === 'offline') {
      const thr = notifyOfflineThresholdMs(rule);
      for (const s of matched) {
        const sid = String(s.id);
        const last = notifyToNum(s.last_updated);
        const stale = (last === null) ? null : (nowMs - last);
        const isOffline = (stale === null) ? false : (stale > thr.baseMs + thr.forMs);
        const prev = readState(rule.id, sid);
        const firing = !!(prev && prev.state === 'firing');
        const metrics = { stale_ms: stale, threshold_sec: thr.thresholdSec, for_duration_sec: thr.forDurationSec, last_updated: last };
        if (isOffline && !firing) {
          const since = (prev && notifyToNum(prev.since)) || nowMs;
          const fireCount = ((prev && notifyToNum(prev.fire_count)) || 0) + 1;
          const ev = emit(s, 'fire', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since, last_notified_at: nowMs, fire_count: fireCount } });
          if (cooldownSec > 0 && prev && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) {
            ev.deliverable = false; ev.suppressed_by = 'cooldown';
            ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since, last_notified_at: notifyToNum(prev.last_notified_at), fire_count: fireCount } };
          } else if (silentNow) {
            ev.deliverable = false; ev.suppressed_by = 'silent_window';
            ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since, last_notified_at: notifyToNum(prev && prev.last_notified_at) || 0, fire_count: fireCount } };
          } else ev.deliverable = true;
        } else if (isOffline && firing) {
          // 治本改造：firing 状态不再永久抑制推送——距上次提醒已超过重复提醒间隔时，重新产生 fire 事件续报
          const repeatSec = notifyOfflineRepeatSec(rule);
          const lastNotified = notifyToNum(prev.last_notified_at);
          const repeatDue = (lastNotified === null) || ((nowMs - lastNotified) >= repeatSec * 1000);
          if (repeatDue) {
            const since = notifyToNum(prev.since) || nowMs;
            const fireCount = (notifyToNum(prev.fire_count) || 0) + 1;
            const ev = emit(s, 'fire', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: since, last_notified_at: nowMs, fire_count: fireCount } });
            // 每轮续报使用独立去重键（含轮次），否则 notify_log 幂等去重会把重复提醒吞掉（inserted=false → skipped）
            ev.dedupe_key = [String(rule.id), sid, 'fire', 'repeat', String(fireCount)].join('::');
            ev.repeat = true;
            ev.repeat_count = fireCount;
            ev.repeat_interval_sec = repeatSec;
            const offlineSec = Math.max(0, Math.round((notifyToNum(stale) || 0) / 1000));
            const timeText = notifyEventTime(nowMs);
            const nameTxt = String(s.name || '');
            ev.title = '节点离线告警（持续提醒 第 ' + fireCount + ' 次）';
            ev.text = '节点离线告警（持续提醒）\n\n节点名称: ' + nameTxt + '\n状态: 离线 (超过判定阈值未上报)\n已持续离线: ' + offlineSec + ' 秒\n提醒次数: 第 ' + fireCount + ' 次\n时间: ' + timeText;
            ev.html = '⚠️ <b>节点离线告警（持续提醒）</b>\n\n<b>节点名称:</b> ' + tgEsc(nameTxt) + '\n<b>状态:</b> 离线 (超过判定阈值未上报)\n<b>已持续离线:</b> ' + offlineSec + ' 秒\n<b>提醒次数:</b> 第 ' + fireCount + ' 次\n<b>时间:</b> ' + timeText;
            if (silentNow) {
              // 免打扰时段内抑制投递，但不推进 last_notified_at：静默结束后可立即补推
              ev.deliverable = false; ev.suppressed_by = 'silent_window';
              ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: since, last_notified_at: (lastNotified === null ? 0 : lastNotified), fire_count: fireCount } };
            } else ev.deliverable = true;
          }
        } else if (!isOffline && firing) {
          const ev = emit(s, recoverNotify ? 'recover' : 'clear', metrics, { op: 'delete', rule_id: String(rule.id), server_id: sid, key: notifyStateKey(rule.id, sid) });
          if (recoverNotify) {
            ownerRecovered.add(notifyStateKey(rule.id, sid));
            if (silentNow) { ev.deliverable = false; ev.suppressed_by = 'silent_window'; }
            else if (cooldownSec > 0 && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) { ev.deliverable = false; ev.suppressed_by = 'cooldown'; }
            else ev.deliverable = true;
          }
        }
      }
    } else if (type === 'recover') {
      // 兜底恢复：仅对“归属规则未在本轮产出恢复事件”的 firing 状态补发
      const thrSecDefault = NOTIFY_OFFLINE_DEFAULT_THRESHOLD;
      for (const key of Object.keys(stateMap)) {
        const row = stateMap[key];
        if (!row || typeof row !== 'object' || row.state !== 'firing') continue;
        const ownerId = String(row.rule_id || String(key).split('::')[0]);
        const ownerRule = byId.get(ownerId);
        // 守卫：兜底恢复仅处理 owner 规则类型为 offline 的 firing 状态，避免误清除 metric / traffic_ratio / expire_days 等规则的状态
        if (ownerRule) {
          if (String(ownerRule.type) !== 'offline') continue;
          if (notifyTruthy(ownerRule.recover_notify)) continue;
        }
        if (ownerRecovered.has(notifyStateKey(ownerId, String(row.server_id || String(key).split('::')[1])))) continue;
        const sid = String(row.server_id || String(key).split('::')[1]);
        const s = serverList.find(x => String(x.id) === sid);
        if (!s || !notifyMatchScope(scope, s)) continue;
        const last = notifyToNum(s.last_updated);
        const stale = (last === null) ? null : (nowMs - last);
        let limitSec = thrSecDefault;
        if (ownerRule) limitSec = notifyOfflineThresholdMs(ownerRule).thresholdSec;
        if (stale !== null && stale <= limitSec * 1000) {
          const ev = emit(s, 'recover', { stale_ms: stale, threshold_sec: limitSec }, { op: 'delete', rule_id: ownerId, server_id: sid, key: notifyStateKey(ownerId, sid) });
          if (silentNow) { ev.deliverable = false; ev.suppressed_by = 'silent_window'; }
          else if (cooldownSec > 0 && notifyToNum(row.last_notified_at) !== null && (nowMs - notifyToNum(row.last_notified_at)) < cooldownSec * 1000) { ev.deliverable = false; ev.suppressed_by = 'cooldown'; }
          else ev.deliverable = true;
        }
      }
    } else if (type === 'metric') {
      const rawMetric = (rule.metric === undefined || rule.metric === null || rule.metric === '') ? rule.metric_name : rule.metric;
      const meta = notifyMetricField(rawMetric);
      if (meta) {
        const spec = notifyMetricSpec(rule, meta);
        const emitMetric = (server, kind, metrics, action) => {
          const ev = emit(server, kind, metrics, action);
          const tx = notifyMetricEventText(server, meta, spec, metrics ? metrics.value : null, kind, nowMs);
          ev.title = tx.title; ev.text = tx.text; ev.html = tx.html;
          return ev;
        };
        for (const s of matched) {
          const sid = String(s.id);
          const value = notifyMetricValue(s, meta);
          const breached = notifyMetricBreached(value, spec);
          const cleared = notifyMetricCleared(value, spec);
          const prev = readState(rule.id, sid);
          const st = prev ? String(prev.state || '') : '';
          const metrics = {
            metric: spec.metric, metric_label: spec.label, unit: spec.unit, value: value,
            threshold: spec.threshold, clear_threshold: spec.clearThreshold, for_duration_sec: spec.forDurationSec
          };
          if (st === 'firing') {
            if (cleared) {
              const ev = emitMetric(s, recoverNotify ? 'recover' : 'clear', metrics, { op: 'delete', rule_id: String(rule.id), server_id: sid, key: notifyStateKey(rule.id, sid) });
              if (recoverNotify) {
                ownerRecovered.add(notifyStateKey(rule.id, sid));
                if (silentNow) { ev.deliverable = false; ev.suppressed_by = 'silent_window'; }
                else if (cooldownSec > 0 && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) { ev.deliverable = false; ev.suppressed_by = 'cooldown'; }
                else ev.deliverable = true;
              }
            }
          } else if (st === 'pending') {
            const since = (notifyToNum(prev.since) === null) ? nowMs : notifyToNum(prev.since);
            if (!breached) {
              emitMetric(s, 'clear', metrics, { op: 'delete', rule_id: String(rule.id), server_id: sid, key: notifyStateKey(rule.id, sid) });
            } else if (nowMs - since >= spec.forMs) {
              const fireCount = (notifyToNum(prev.fire_count) || 0) + 1;
              const ev = emitMetric(s, 'fire', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: since, last_notified_at: nowMs, fire_count: fireCount } });
              if (cooldownSec > 0 && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) {
                ev.deliverable = false; ev.suppressed_by = 'cooldown';
                ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: since, last_notified_at: notifyToNum(prev.last_notified_at), fire_count: fireCount } };
              } else if (silentNow) {
                ev.deliverable = false; ev.suppressed_by = 'silent_window';
                ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: since, last_notified_at: notifyToNum(prev.last_notified_at) || 0, fire_count: fireCount } };
              } else ev.deliverable = true;
            }
          } else if (breached) {
            if (spec.forMs <= 0) {
              const fireCount = (notifyToNum(prev && prev.fire_count) || 0) + 1;
              const ev = emitMetric(s, 'fire', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: nowMs, last_notified_at: nowMs, fire_count: fireCount } });
              if (cooldownSec > 0 && prev && notifyToNum(prev.last_notified_at) !== null && (nowMs - notifyToNum(prev.last_notified_at)) < cooldownSec * 1000) {
                ev.deliverable = false; ev.suppressed_by = 'cooldown';
                ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: nowMs, last_notified_at: notifyToNum(prev.last_notified_at), fire_count: fireCount } };
              } else if (silentNow) {
                ev.deliverable = false; ev.suppressed_by = 'silent_window';
                ev.state_op = { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: nowMs, last_notified_at: notifyToNum(prev && prev.last_notified_at) || 0, fire_count: fireCount } };
              } else ev.deliverable = true;
            } else {
              emitMetric(s, 'pending', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'pending', since: nowMs, last_notified_at: notifyToNum(prev && prev.last_notified_at) || 0, fire_count: notifyToNum(prev && prev.fire_count) || 0 } });
            }
          }
        }
      }
    } else if (type === 'traffic_ratio') {
      const rSpec = notifyRatioSpec(rule);
      const emitWith = (server, kind, metrics, action, tx) => {
        const ev = emit(server, kind, metrics, action);
        ev.title = tx.title; ev.text = tx.text; ev.html = tx.html;
        return ev;
      };
      for (const s of matched) {
        const sid = String(s.id);
        const used = notifyTrafficUsed(s);
        const limit = notifyParseBytes(s.traffic_limit);
        if (used === null || limit === null) continue;
        const ratio = used / limit * 100;
        const breached = (ratio >= rSpec.threshold);
        const cleared = (ratio <= rSpec.clearThreshold);
        const prev = readState(rule.id, sid);
        const st = prev ? String(prev.state || '') : '';
        const metrics = { used_bytes: used, limit_bytes: limit, ratio_percent: ratio, threshold: rSpec.threshold, clear_threshold: rSpec.clearThreshold, traffic_limit: String(s.traffic_limit || '') };
        if (st === 'firing') {
          if (cleared) {
            const rk = recoverNotify ? 'recover' : 'clear';
            const ev = emitWith(s, rk, metrics, { op: 'delete', rule_id: String(rule.id), server_id: sid, key: notifyStateKey(rule.id, sid) }, notifyTrafficEventText(s, rSpec, metrics, rk, nowMs));
            gateRecover(ev, prev);
          }
        } else if (breached) {
          const fireCount = (notifyToNum(prev && prev.fire_count) || 0) + 1;
          const ev = emitWith(s, 'fire', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: nowMs, last_notified_at: nowMs, fire_count: fireCount } }, notifyTrafficEventText(s, rSpec, metrics, 'fire', nowMs));
          gateFire(ev, prev, fireCount, nowMs);
        }
      }
    } else if (type === 'expire_days') {
      const eSpec = notifyExpireSpec(rule);
      const emitWith = (server, kind, metrics, action, tx) => {
        const ev = emit(server, kind, metrics, action);
        ev.title = tx.title; ev.text = tx.text; ev.html = tx.html;
        return ev;
      };
      for (const s of matched) {
        const sid = String(s.id);
        const expMs = notifyParseDateMs(s.expire_date);
        if (expMs === null) continue;
        const daysLeft = Math.ceil((expMs - nowMs) / 86400000);
        const breached = (daysLeft <= eSpec.threshold);
        const cleared = (daysLeft > eSpec.clearThreshold);
        const prev = readState(rule.id, sid);
        const st = prev ? String(prev.state || '') : '';
        const metrics = { days_left: daysLeft, expire_ms: expMs, expire_date: String(s.expire_date || ''), threshold: eSpec.threshold, clear_threshold: eSpec.clearThreshold };
        if (st === 'firing') {
          if (cleared) {
            const rk = recoverNotify ? 'recover' : 'clear';
            const ev = emitWith(s, rk, metrics, { op: 'delete', rule_id: String(rule.id), server_id: sid, key: notifyStateKey(rule.id, sid) }, notifyExpireEventText(s, eSpec, metrics, rk, nowMs));
            gateRecover(ev, prev);
          }
        } else if (breached) {
          const fireCount = (notifyToNum(prev && prev.fire_count) || 0) + 1;
          const ev = emitWith(s, 'fire', metrics, { op: 'upsert', row: { rule_id: String(rule.id), server_id: sid, state: 'firing', since: nowMs, last_notified_at: nowMs, fire_count: fireCount } }, notifyExpireEventText(s, eSpec, metrics, 'fire', nowMs));
          gateFire(ev, prev, fireCount, nowMs);
        }
      }
    }
  }
  events.sort((a, b) => (a.severity_rank - b.severity_rank) || String(a.rule_id).localeCompare(String(b.rule_id)) || String(a.server_id).localeCompare(String(b.server_id)) || String(a.kind).localeCompare(String(b.kind)));
  return events;
}
// ===== 通知规则引擎骨架 END =====
// ===== 通知运行时数据存取层（通知重构第3步B-1：纯新增，不接管现有调用链） =====
// 职责：把 notify_channels / notify_rules / notify_bindings / alert_state / notify_log / notify_queue 的读写
//       收敛为少量 helper，供后续步骤（runNotifyCycle 等）接棒；本轮只提供函数，不修改任何既有调用链。
// 契约：
//   loadNotifyConfig(env)          -> { channels[], channelsById{}, rules[], rulesById{}, bindings{}, channelsByRule{}, loaded_at }
//   loadAlertState(env, {ruleIds}) -> { "<rule_id>::<server_id>": {state,since,last_notified_at,fire_count} }（键与 notifyStateKey 对齐）
//   applyStateOps(env, ops|events) -> { upserted, deleted, failed, errors[] }（upsert 走 ON CONFLICT，delete 走精确主键）
//   notifyLogWrite(env, entry)     -> { ok, id, inserted, error }
//   notifyQueueEnqueue(env, item)  -> { ok, id, error }
const NOTIFY_DB_BATCH_LIMIT = 40; // 单次 D1 batch 语句数上限保护
function notifyNewId(prefix) {
  const hasUuid = (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function');
  const rnd = hasUuid ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(16) + Math.random().toString(16).slice(2));
  return String(prefix || 'nf') + '_' + rnd.slice(0, 24);
}
function notifyChunkList(list, size) {
  const arr = Array.isArray(list) ? list : [];
  const n = Math.max(1, parseInt(size, 10) || NOTIFY_DB_BATCH_LIMIT);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
// 通道行 → 归一对象（config 就地 JSON 解析）
function notifyNormalizeChannelRow(row) {
  const c = row || {};
  return {
    id: String(c.id || ''), type: String(c.type || ''), name: String(c.name || ''),
    config: notifyNormalizeConfig(c.config), enabled: notifyTruthy(c.enabled) ? 1 : 0,
    created_at: notifyToNum(c.created_at) || 0
  };
}
// 规则行 → 归一对象（scope/params 就地 JSON 解析，数值/布尔归一，可直接交给 evaluateNotifyRules）
function notifyNormalizeRuleRow(row) {
  const r = row || {};
  return {
    id: String(r.id || ''), name: String(r.name || ''), enabled: notifyTruthy(r.enabled) ? 1 : 0,
    type: String(r.type || 'offline'), scope: notifyNormalizeConfig(r.scope), params: notifyNormalizeConfig(r.params),
    severity: String(r.severity || 'warning'), cooldown: notifyToNum(r.cooldown) || 0,
    silent_window: String(r.silent_window || ''), digest: String(r.digest || 'off'),
    recover_notify: notifyTruthy(r.recover_notify) ? 1 : 0, created_at: notifyToNum(r.created_at) || 0,
    // 指标类规则的目标指标：优先行字段，其次 params.metric（供 evaluateNotifyRules 的 metric 分支解析）
    metric: String(r.metric || r.metric_name || notifyNormalizeConfig(r.params).metric || '')
  };
}
// ① 一次性加载通道 / 规则 / 订阅关系（按 enabled 过滤；bindings 只保留“启用规则 × 启用通道”的有效订阅）
async function loadNotifyConfig(env) {
  const out = { channels: [], channelsById: {}, rules: [], rulesById: {}, bindings: {}, channelsByRule: {}, loaded_at: Date.now() };
  if (!env || !env.DB) return out;
  try {
    const chRes = await env.DB.prepare('SELECT id, type, name, config, enabled, created_at FROM notify_channels ORDER BY created_at ASC').all();
    for (const row of (chRes && chRes.results) || []) {
      const c = notifyNormalizeChannelRow(row);
      if (!c.id || !c.enabled) continue;
      out.channels.push(c);
      out.channelsById[c.id] = c;
    }
  } catch (e) {}
  try {
    const rlRes = await env.DB.prepare('SELECT id, name, enabled, type, scope, params, severity, cooldown, silent_window, digest, recover_notify, created_at FROM notify_rules ORDER BY created_at ASC').all();
    for (const row of (rlRes && rlRes.results) || []) {
      const r = notifyNormalizeRuleRow(row);
      if (!r.id || !r.enabled) continue;
      out.rules.push(r);
      out.rulesById[r.id] = r;
    }
  } catch (e) {}
  try {
    const bdRes = await env.DB.prepare('SELECT rule_id, channel_id, enabled, created_at FROM notify_bindings ORDER BY created_at ASC').all();
    for (const row of (bdRes && bdRes.results) || []) {
      if (!notifyTruthy(row && row.enabled)) continue;
      const rid = String((row && row.rule_id) || '');
      const cid = String((row && row.channel_id) || '');
      if (!rid || !cid || !out.rulesById[rid] || !out.channelsById[cid]) continue;
      if (!out.bindings[rid]) out.bindings[rid] = [];
      if (out.bindings[rid].indexOf(cid) === -1) out.bindings[rid].push(cid);
      if (!out.channelsByRule[rid]) out.channelsByRule[rid] = [];
      out.channelsByRule[rid].push(out.channelsById[cid]);
    }
  } catch (e) {}
  return out;
}
// ② 读取 alert_state 全量（或指定规则范围）快照，键与 notifyStateKey 对齐
async function loadAlertState(env, opts) {
  const map = {};
  if (!env || !env.DB) return map;
  const ruleIds = ((opts || {}).ruleIds && Array.isArray(opts.ruleIds)) ? opts.ruleIds.map(String).filter(Boolean) : [];
  let rows = [];
  try {
    if (ruleIds.length > 0) {
      for (const part of notifyChunkList(ruleIds, NOTIFY_DB_BATCH_LIMIT)) {
        const ph = part.map(() => '?').join(', ');
        const res = await env.DB.prepare('SELECT rule_id, server_id, state, since, last_notified_at, fire_count FROM alert_state WHERE rule_id IN (' + ph + ')').bind(...part).all();
        rows = rows.concat((res && res.results) || []);
      }
    } else {
      const res = await env.DB.prepare('SELECT rule_id, server_id, state, since, last_notified_at, fire_count FROM alert_state').all();
      rows = (res && res.results) || [];
    }
  } catch (e) { return map; }
  for (const row of rows) {
    const rid = String(row.rule_id || '');
    const sid = String(row.server_id || '');
    if (!rid || !sid) continue;
    map[notifyStateKey(rid, sid)] = {
      rule_id: rid, server_id: sid, state: String(row.state || 'ok'),
      since: notifyToNum(row.since) || 0, last_notified_at: notifyToNum(row.last_notified_at) || 0,
      fire_count: notifyToNum(row.fire_count) || 0
    };
  }
  return map;
}
// 状态行归一：保证 upsert 的 4 个可变字段可用，rule_id/server_id 任一缺失则丢弃
function notifyNormalizeStateRow(row) {
  const r = row || {};
  const rid = String(r.rule_id || '');
  const sid = String(r.server_id || '');
  if (!rid || !sid) return null;
  return {
    rule_id: rid, server_id: sid, state: String(r.state || 'ok'),
    since: notifyToNum(r.since) || 0, last_notified_at: notifyToNum(r.last_notified_at) || 0,
    fire_count: notifyToNum(r.fire_count) || 0
  };
}
// ③ 把规则引擎产出的状态变更落库：入参兼容 notifyCollectStateOps 的 patch 与 events 数组
//    upsert 用 INSERT ... ON CONFLICT(rule_id, server_id) DO UPDATE 保证并发下不丢更新；
//    delete 用 (rule_id, server_id) 精确主键，绝不整表清理。
async function applyStateOps(env, ops) {
  const result = { upserted: 0, deleted: 0, failed: 0, errors: [] };
  if (!env || !env.DB || !ops) return result;
  const patch = Array.isArray(ops) ? notifyCollectStateOps(ops) : ops;
  const stmts = [];
  const upsertSql = 'INSERT INTO alert_state (rule_id, server_id, state, since, last_notified_at, fire_count) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, server_id) DO UPDATE SET state = excluded.state, since = excluded.since, last_notified_at = excluded.last_notified_at, fire_count = excluded.fire_count';
  for (const row of (Array.isArray(patch.upsert) ? patch.upsert : [])) {
    const r = notifyNormalizeStateRow(row);
    if (!r) continue;
    stmts.push({ kind: 'upsert', sql: upsertSql, args: [r.rule_id, r.server_id, r.state, r.since, r.last_notified_at, r.fire_count] });
  }
  const deleteSql = 'DELETE FROM alert_state WHERE rule_id = ? AND server_id = ?';
  for (const row of (Array.isArray(patch.remove) ? patch.remove : [])) {
    const rid = String((row && row.rule_id) || '');
    const sid = String((row && row.server_id) || '');
    if (!rid || !sid) continue;
    stmts.push({ kind: 'delete', sql: deleteSql, args: [rid, sid] });
  }
  for (const part of notifyChunkList(stmts, NOTIFY_DB_BATCH_LIMIT)) {
    try {
      await env.DB.batch(part.map(s => env.DB.prepare(s.sql).bind(...s.args)));
      for (const s of part) { if (s.kind === 'upsert') result.upserted++; else result.deleted++; }
    } catch (e) {
      // 整批失败时逐条降级重试，避免单条异常拖垮其余状态写入
      for (const s of part) {
        try {
          await env.DB.prepare(s.sql).bind(...s.args).run();
          if (s.kind === 'upsert') result.upserted++; else result.deleted++;
        } catch (e2) {
          result.failed++;
          if (result.errors.length < 5) result.errors.push({ kind: s.kind, key: s.args[0] + '::' + s.args[1], error: String((e2 && e2.message) || e2) });
        }
      }
    }
  }
  return result;
}
// ④ 写入一条通知日志：dedupe_key 命中唯一索引或主键重复时按幂等处理（inserted=false），不抛错
const NOTIFY_LOG_DEFAULT_STATUS = 'pending';
async function notifyLogWrite(env, entry) {
  const e = entry || {};
  const out = { ok: false, id: '', inserted: false, error: '' };
  if (!env || !env.DB) { out.error = 'db_unavailable'; return out; }
  const id = String(e.id || '') || notifyNewId('nlog');
  out.id = id;
  const dk = (e.dedupe_key === undefined || e.dedupe_key === null || e.dedupe_key === '') ? null : String(e.dedupe_key);
  try {
    const res = await env.DB.prepare('INSERT OR IGNORE INTO notify_log (id, rule_id, channel_id, server_id, type, title, content, status, error, dedupe_key, attempts, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, String(e.rule_id || ''), String(e.channel_id || ''), String(e.server_id || ''), String(e.type || ''), String(e.title || ''), String(e.content || ''), String(e.status || NOTIFY_LOG_DEFAULT_STATUS), String(e.error || ''), dk, notifyToNum(e.attempts) || 0, notifyToNum(e.created_at) || Date.now(), notifyToNum(e.sent_at) || 0).run();
    out.inserted = (notifyToNum(res && res.meta && res.meta.changes) || 0) > 0;
    out.ok = true;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err);
    return out;
  }
}
// ⑤ 入队一条待投递任务（payload 支持对象，自动 JSON 序列化）
async function notifyQueueEnqueue(env, item) {
  const it = item || {};
  const out = { ok: false, id: '', error: '' };
  if (!env || !env.DB) { out.error = 'db_unavailable'; return out; }
  const id = String(it.id || '') || notifyNewId('nq');
  out.id = id;
  let payload = it.payload;
  if (payload === undefined || payload === null || payload === '') payload = '{}';
  if (typeof payload !== 'string') { try { payload = JSON.stringify(payload); } catch (e) { payload = '{}'; } }
  try {
    await env.DB.prepare('INSERT INTO notify_queue (id, log_id, rule_id, channel_id, server_id, payload, status, attempts, next_retry_at, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, String(it.log_id || ''), String(it.rule_id || ''), String(it.channel_id || ''), String(it.server_id || ''), payload, String(it.status || NOTIFY_LOG_DEFAULT_STATUS), notifyToNum(it.attempts) || 0, notifyToNum(it.next_retry_at) || 0, String(it.last_error || ''), notifyToNum(it.created_at) || Date.now()).run();
    out.ok = true;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err);
    return out;
  }
}
// ===== 通知运行时数据存取层 END =====

// ===== 通知统一评估与投递主流程（通知重构第3步B-2a：纯新增，不接管现有调用链） =====
// 职责：runNotifyCycle(env, opts) 串起 配置/状态加载 → 规则评估 → 状态落库 → 文案渲染与多通道投递 → 日志与失败入队
// 契约：
//   runNotifyCycle(env, { now?, servers?, notifyConfig?, state?, skipDelivery? }) -> {
//     ok, now, servers, events, deliverable, aggregated, sent, failed, skipped, enqueued,
//     state:{upserted,deleted,failed}, errors[]
//   }
//   - deliverable 事件按 <rule_id>::<kind> 分组，满足 digest 阈值（同轮多节点同类事件）时聚合为一条，防消息风暴；
//     聚合去重键按 digest 窗口对齐，保证同一窗口内不重复推送
//   - 同 dedupe_key 已在 notify_log 落库的投递直接跳过（幂等）
//   - 投递失败写 notify_log(status=failed) 与 notify_queue(next_retry_at/attempts)，本轮不补发
// =====

const NOTIFY_RETRY_BASE_MS = 60000;      // 失败重试基础退避 60s
const NOTIFY_RETRY_MAX_MS = 3600000;     // 失败重试退避上限 1h

// 退避间隔：60s → 120s → 240s … 上限 1h
function notifyRetryDelayMs(attempts) {
  const n = Math.max(1, parseInt(attempts, 10) || 1);
  return Math.min(NOTIFY_RETRY_MAX_MS, NOTIFY_RETRY_BASE_MS * Math.pow(2, n - 1));
}

// digest 参数解析：rule.digest 为 off/none/0/false/disabled/instant 时关闭聚合
function notifyDigestSpec(rule) {
  const r = rule || {};
  const p = notifyNormalizeConfig(r.params) || {};
  const raw = String(r.digest === null || r.digest === undefined ? '' : r.digest).trim().toLowerCase();
  const enabled = !(raw === '' || raw === 'off' || raw === 'none' || raw === '0' || raw === 'false' || raw === 'disabled' || raw === 'instant');
  const pick = (a, b) => (p[a] !== undefined ? p[a] : p[b]);
  const windowSec = Math.max(30, notifyToNum(pick('digest_window', 'digestWindow')) || 120);
  const threshold = Math.max(1, Math.floor(notifyToNum(pick('digest_threshold', 'digestThreshold')) || 3));
  const maxItems = Math.max(1, Math.floor(notifyToNum(pick('digest_max_items', 'digestMaxItems')) || 10));
  return { enabled, windowSec, threshold, maxItems };
}

// 聚合文案：标题 + 明细列表（超出上限折叠）；text 为纯文本，html 为 Telegram HTML
function notifyDigestPayload(rule, kind, evs, spec, nowMs) {
  const r = rule || {};
  const list = Array.isArray(evs) ? evs : [];
  const isRecover = String(kind) === 'recover';
  const shown = list.slice(0, spec.maxItems);
  const name = String(r.name || '通知');
  const title = name + '：' + list.length + ' 个节点' + (isRecover ? '已恢复' : '触发');
  const plain = (ev) => String((ev && (ev.server_name || ev.server_id)) || '-') + '：' + String((ev && (ev.title || ev.kind)) || '');
  const mark = (ev) => '• <b>' + tgEsc(String((ev && (ev.server_name || ev.server_id)) || '-')) + '</b>：' + tgEsc(String((ev && (ev.title || ev.kind)) || ''));
  const textLines = shown.map(ev => '- ' + plain(ev));
  const htmlLines = shown.map(ev => mark(ev));
  if (list.length > shown.length) {
    const more = list.length - shown.length;
    textLines.push('- …另有 ' + more + ' 个节点，详见后台通知中心');
    htmlLines.push('• …另有 ' + more + ' 个节点，详见后台通知中心');
  }
  const timeText = notifyEventTime(nowMs);
  const emoji = isRecover ? '✅ ' : '⚠️ ';
  return {
    title,
    text: emoji + title + '\n\n' + textLines.join('\n') + '\n\n时间: ' + timeText,
    html: emoji + '<b>' + tgEsc(name) + '</b>：' + list.length + ' 个节点' + (isRecover ? '已恢复' : '触发') + '\n\n' + htmlLines.join('\n') + '\n\n<b>时间:</b> ' + tgEsc(timeText)
  };
}

// 单事件 → 投递文案
function notifyEventPayload(rule, ev) {
  const r = rule || {};
  const e = ev || {};
  return { title: String(e.title || r.name || '通知'), text: String(e.text || ''), html: String(e.html || '') };
}

// 按通道类型选择最终投递正文（telegram 走 HTML，其余走纯文本）
function notifyChannelPayload(channel, target) {
  const t = target || {};
  const isTg = String((channel || {}).type || '') === 'telegram';
  const text = isTg ? (String(t.html || '') || String(t.text || '')) : String(t.text || '');
  return { title: String(t.title || ''), text, markdown: false, level: 'active', timestamp: Date.now() };
}

// 投递目标构建：达到阈值 → 聚合为一条（窗口对齐去重）；否则逐条投递
function notifyBuildDeliverables(rule, kind, evs, nowMs) {
  const r = rule || {};
  const list = Array.isArray(evs) ? evs : [];
  const spec = notifyDigestSpec(r);
  const out = [];
  if (spec.enabled && list.length >= spec.threshold) {
    const windowMs = spec.windowSec * 1000;
    const winStart = Math.floor(nowMs / windowMs) * windowMs;
    const dp = notifyDigestPayload(r, kind, list, spec, nowMs);
    out.push({
      is_digest: true, events: list, server_id: '', kind: String(kind),
      title: dp.title, text: dp.text, html: dp.html,
      dedupe_key: [String(r.id || ''), String(kind), 'digest', String(winStart)].join('::')
    });
    return out;
  }
  for (const ev of list) {
    const e = ev || {};
    const dk = String(e.dedupe_key || '') || [String(e.rule_id || r.id || ''), String(e.server_id || ''), String(kind)].join('::');
    const p = notifyEventPayload(r, e);
    out.push({ is_digest: false, events: [e], server_id: String(e.server_id || ''), kind: String(kind), title: p.title, text: p.text, html: p.html, dedupe_key: dk });
  }
  return out;
}

// 日志状态回写（notify_log 仅有 insert helper，此处补 sent/failed 结果落库）
async function notifyLogMarkResult(env, id, patch) {
  const p = patch || {};
  try {
    await env.DB.prepare('UPDATE notify_log SET status = ?, error = ?, sent_at = ?, attempts = ? WHERE id = ?')
      .bind(String(p.status || 'pending'), String(p.error || ''), notifyToNum(p.sent_at) || 0, Math.max(0, Math.floor(notifyToNum(p.attempts) || 0)), String(id))
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 节点加载：servers 表 → 规则引擎所需结构（group 取 server_group；表无 tags 列，暂置空数组）
async function loadNotifyServers(env) {
  const out = [];
  if (!env || !env.DB) return out;
  try {
    const { results } = await env.DB.prepare('SELECT id, name, server_group, last_updated, cpu, ram, disk, load_avg, monthly_rx, monthly_tx, traffic_limit, expire_date FROM servers').all();
    for (const row of (results || [])) {
      if (!row || row.id === undefined || row.id === null || row.id === '') continue;
      out.push({
        id: row.id, name: row.name, group: row.server_group, tags: [],
        last_updated: notifyToNum(row.last_updated) || 0,
        cpu: row.cpu, ram: row.ram, disk: row.disk, load_avg: row.load_avg,
        monthly_rx: row.monthly_rx, monthly_tx: row.monthly_tx,
        traffic_limit: row.traffic_limit, expire_date: row.expire_date
      });
    }
  } catch (e) {}
  return out;
}

// 统一评估与投递主流程（纯新增；不修改 scheduledAlertCheck / checkOfflineNodes 等既有调用链）
async function runNotifyCycle(env, opts) {
  const o = opts || {};
  const now = notifyToNum(o.now) || Date.now();
  const result = {
    ok: true, now, servers: 0, events: 0, deliverable: 0, aggregated: 0,
    sent: 0, failed: 0, skipped: 0, enqueued: 0,
    state: { upserted: 0, deleted: 0, failed: 0 }, errors: []
  };
  if (!env || !env.DB) { result.ok = false; result.errors.push('db_unavailable'); return result; }
  try {
    const cfg = o.notifyConfig || await loadNotifyConfig(env);
    const servers = Array.isArray(o.servers) ? o.servers : await loadNotifyServers(env);
    result.servers = servers.length;
    const state = (o.state && typeof o.state === 'object') ? o.state : await loadAlertState(env, { ruleIds: (cfg.rules || []).map(r => r.id) });
    const events = evaluateNotifyRules(cfg.rules || [], servers, state, now);
    result.events = events.length;
    // 状态先落库：与投递解耦，保证状态与日志互不阻塞
    result.state = await applyStateOps(env, notifyCollectStateOps(events));
    const deliverable = events.filter(ev => ev && ev.deliverable === true);
    result.deliverable = deliverable.length;
    if (o.skipDelivery === true || deliverable.length === 0) return result;
    // 分组：同一规则 + 同一事件类型 → 同一组（组内可聚合）
    const groups = []; const gidx = {};
    for (const ev of deliverable) {
      const gk = String(ev.rule_id) + '::' + String(ev.kind);
      if (gidx[gk] === undefined) { gidx[gk] = groups.length; groups.push({ rule_id: String(ev.rule_id), kind: String(ev.kind), events: [] }); }
      groups[gidx[gk]].events.push(ev);
    }
    const stamp = Date.now();
    for (const g of groups) {
      const rule = (cfg.rulesById || {})[g.rule_id] || { id: g.rule_id };
      const channels = ((cfg.channelsByRule || {})[g.rule_id] || []).filter(c => c && !(c.enabled === 0 || c.enabled === '0' || c.enabled === false));
      const targets = notifyBuildDeliverables(rule, g.kind, g.events, now);
      for (const t of targets) {
        if (t.is_digest) result.aggregated += t.events.length;
        if (!channels.length) {
          result.skipped += 1;
          await notifyLogWrite(env, { rule_id: g.rule_id, channel_id: '', server_id: t.server_id, type: g.kind, title: t.title, content: t.text, status: 'skipped', error: 'no_channel', dedupe_key: t.dedupe_key, created_at: stamp });
          continue;
        }
        for (const ch of channels) {
          const lg = await notifyLogWrite(env, { rule_id: g.rule_id, channel_id: ch.id, server_id: t.server_id, type: g.kind, title: t.title, content: t.text, status: 'pending', dedupe_key: t.dedupe_key + '::' + String(ch.id), created_at: stamp });
          if (!lg || lg.ok !== true || lg.inserted !== true) { result.skipped += 1; continue; }
          const send = await sendViaChannel(ch, notifyChannelPayload(ch, t));
          if (send && send.ok === true) {
            result.sent += 1;
            await notifyLogMarkResult(env, lg.id, { status: 'sent', sent_at: Date.now(), attempts: 1 });
          } else {
            result.failed += 1;
            const errMsg = String((send && send.error) || 'send_failed');
            await notifyLogMarkResult(env, lg.id, { status: 'failed', error: errMsg, attempts: 1 });
            const retryAfter = notifyToNum(send && send.retryAfter) || 0;
            const delayMs = retryAfter > 0 ? retryAfter * 1000 : notifyRetryDelayMs(1);
            const q = await notifyQueueEnqueue(env, {
              log_id: lg.id, rule_id: g.rule_id, channel_id: ch.id, server_id: t.server_id,
              payload: { title: t.title, text: t.text, markdown: false, channel_type: ch.type },
              status: 'pending', attempts: 1, next_retry_at: Date.now() + delayMs, last_error: errMsg, created_at: Date.now()
            });
            if (q && q.ok === true) result.enqueued += 1; else result.errors.push('enqueue_failed');
          }
        }
      }
    }
  } catch (e) {
    result.ok = false;
    result.errors.push(String((e && e.message) || e));
  }
  return result;
}
// ===== 通知统一评估与投递主流程 END =====

// ===== 通知投递可靠性补发（通知重构第3步B-2b：纯新增，不接管现有调用链） =====
// 职责：drainNotifyQueue(env, opts) 扫描 notify_queue 中到期的 pending 条目，按通道维度限速逐条补发
// 契约：
//   drainNotifyQueue(env, { now?, limit?, maxAttempts?, minIntervalMs?, budgetMs?, channelId? }) -> {
//     ok, now, scanned, sent, retried, dead, skipped, rateLimited, errors[]
//   }
//   - 仅处理 status=pending 且 next_retry_at <= now 的条目，按 next_retry_at/created_at 升序
//   - 通道维度限速：同一通道连续发送至少间隔 minIntervalMs（默认 1000ms，防 Telegram 限流）；
//     单通道时间预算 budgetMs（默认 25000ms）用尽后，该通道剩余条目本轮跳过，保持 pending 待下轮补发
//   - 成功：队列置 sent 并回写 notify_log(sent)；失败：attempts+1，未超上限按 notifyRetryDelayMs 退避推迟，
//     超上限或不可恢复错误（通道缺失/禁用/配置非法）置 dead 不再重试
//   - 服务端返回 retryAfter（如 429）优先于本地退避
// =====

const NOTIFY_DRAIN_DEFAULT_LIMIT = 20;      // 单次运行默认最多扫描条目数
const NOTIFY_DRAIN_MAX_LIMIT = 100;         // 扫描上限（防单轮耗时过长）
const NOTIFY_DRAIN_MIN_INTERVAL_MS = 1000;  // 同通道最小发送间隔（防通道侧限流）
const NOTIFY_DRAIN_BUDGET_MS = 25000;       // 单次运行单通道发送时间预算
const NOTIFY_QUEUE_MAX_ATTEMPTS = 5;        // 最大尝试次数（含首次），超出置 dead

// 队列 payload 解析：非法 JSON 退化为纯文本投递，不抛错
function notifyQueueParsePayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return { text: '' };
  try { const o = JSON.parse(s); return (o && typeof o === 'object') ? o : { text: String(o) }; }
  catch (e) { return { text: s }; }
}

// 不可恢复错误：通道缺失/禁用/配置非法/Provider 不支持 → 直接置 dead，避免无谓重试
function notifyQueuePermanentError(err) {
  const e = String(err || '');
  if (!e) return false;
  if (e === 'channel_disabled' || e === 'channel_not_found' || e === 'missing_channel') return true;
  if (e === 'config_invalid' || e === 'provider_not_found') return true;
  return e.indexOf('provider_not_found:') === 0;
}

// 队列行 → 归一对象（payload 解析、数值归一）
function notifyQueueNormalizeRow(row) {
  const r = row || {};
  return {
    id: String(r.id || ''), log_id: String(r.log_id || ''), rule_id: String(r.rule_id || ''),
    channel_id: String(r.channel_id || ''), server_id: String(r.server_id || ''),
    payload: notifyQueueParsePayload(r.payload),
    status: String(r.status || 'pending'),
    attempts: Math.max(0, Math.floor(notifyToNum(r.attempts) || 0)),
    next_retry_at: notifyToNum(r.next_retry_at) || 0,
    last_error: String(r.last_error || ''),
    created_at: notifyToNum(r.created_at) || 0
  };
}

// 读取到期条目（status=pending 且 next_retry_at <= now），查询异常经 error 字段上报，避免静默当成本轮无任务
async function notifyQueueLoadDue(env, limit, now) {
  const out = { rows: [], error: '' };
  if (!env || !env.DB) { out.error = 'db_unavailable'; return out; }
  try {
    const { results } = await env.DB.prepare('SELECT id, log_id, rule_id, channel_id, server_id, payload, status, attempts, next_retry_at, last_error, created_at FROM notify_queue WHERE status = ? AND next_retry_at <= ? ORDER BY next_retry_at ASC, created_at ASC LIMIT ?')
      .bind('pending', now, limit).all();
    for (const row of (results || [])) {
      const it = notifyQueueNormalizeRow(row);
      if (it.id) out.rows.push(it);
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

// 队列状态回写（status / attempts / next_retry_at / last_error）
async function notifyQueueMarkResult(env, id, patch) {
  const p = patch || {};
  try {
    await env.DB.prepare('UPDATE notify_queue SET status = ?, attempts = ?, next_retry_at = ?, last_error = ? WHERE id = ?')
      .bind(String(p.status || 'pending'), Math.max(0, Math.floor(notifyToNum(p.attempts) || 0)), notifyToNum(p.next_retry_at) || 0, String(p.last_error || ''), String(id))
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 通道行按 ID 读取（同轮缓存，避免重复查库）
async function notifyQueueLoadChannel(env, cache, channelId) {
  const key = String(channelId || '');
  if (!key) return null;
  const c = cache || {};
  if (Object.prototype.hasOwnProperty.call(c, key)) return c[key];
  let row = null;
  try {
    row = await env.DB.prepare('SELECT id, type, name, config, enabled FROM notify_channels WHERE id = ?').bind(key).first();
  } catch (e) { row = null; }
  c[key] = row || null;
  return c[key];
}

async function drainNotifyQueue(env, opts) {
  const o = opts || {};
  const now = notifyToNum(o.now) || Date.now();
  const result = { ok: true, now, scanned: 0, sent: 0, retried: 0, dead: 0, skipped: 0, rateLimited: 0, errors: [] };
  if (!env || !env.DB) { result.ok = false; result.errors.push('db_unavailable'); return result; }
  const limit = Math.max(1, Math.min(NOTIFY_DRAIN_MAX_LIMIT, Math.floor(notifyToNum(o.limit) || NOTIFY_DRAIN_DEFAULT_LIMIT)));
  const maxAttempts = Math.max(1, Math.floor(notifyToNum(o.maxAttempts) || NOTIFY_QUEUE_MAX_ATTEMPTS));
  const minIntervalMs = Math.max(0, notifyToNum(o.minIntervalMs) === null ? NOTIFY_DRAIN_MIN_INTERVAL_MS : notifyToNum(o.minIntervalMs));
  const budgetMs = Math.max(0, notifyToNum(o.budgetMs) === null ? NOTIFY_DRAIN_BUDGET_MS : notifyToNum(o.budgetMs));
  const onlyChannel = String(o.channelId || '');
  try {
    const loaded = await notifyQueueLoadDue(env, limit, now);
    const due = loaded.rows || [];
    if (loaded.error) { result.ok = false; result.errors.push(loaded.error); }
    result.scanned = due.length;
    const chCache = {};
    const slotByChannel = {};   // 通道 → 下一次可发送的虚拟时刻（限速判定，不做真实等待）
    for (const it of due) {
      if (onlyChannel && it.channel_id !== onlyChannel) continue;
      const cid = it.channel_id || '';
      const prev = slotByChannel[cid];
      const slot = (prev === undefined) ? now : prev;
      if (slot - now > budgetMs) { result.rateLimited += 1; result.skipped += 1; continue; }
      slotByChannel[cid] = Math.max(now, slot) + minIntervalMs;
      const attempts = it.attempts + 1;
      const px = String(it.payload.text || it.payload.content || '');
      if (!px) {
        result.dead += 1;
        await notifyQueueMarkResult(env, it.id, { status: 'dead', attempts, next_retry_at: 0, last_error: 'payload_empty' });
        if (it.log_id) await notifyLogMarkResult(env, it.log_id, { status: 'failed', error: 'payload_empty', attempts });
        continue;
      }
      const row = await notifyQueueLoadChannel(env, chCache, cid);
      const send = row ? await sendViaChannel(row, notifyChannelPayload(row, { title: it.payload.title, text: px })) : { ok: false, status: 0, retryAfter: 0, error: 'channel_not_found' };
      if (send && send.ok === true) {
        result.sent += 1;
        await notifyQueueMarkResult(env, it.id, { status: 'sent', attempts, next_retry_at: 0, last_error: '' });
        if (it.log_id) await notifyLogMarkResult(env, it.log_id, { status: 'sent', sent_at: Date.now(), attempts });
        continue;
      }
      const errMsg = String((send && send.error) || 'send_failed');
      if (notifyQueuePermanentError(errMsg) || attempts >= maxAttempts) {
        result.dead += 1;
        await notifyQueueMarkResult(env, it.id, { status: 'dead', attempts, next_retry_at: 0, last_error: errMsg });
        if (it.log_id) await notifyLogMarkResult(env, it.log_id, { status: 'failed', error: errMsg, attempts });
        continue;
      }
      const retryAfter = notifyToNum(send && send.retryAfter) || 0;
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : notifyRetryDelayMs(attempts);
      result.retried += 1;
      await notifyQueueMarkResult(env, it.id, { status: 'pending', attempts, next_retry_at: Date.now() + delayMs, last_error: errMsg });
      if (it.log_id) await notifyLogMarkResult(env, it.log_id, { status: 'failed', error: errMsg, attempts });
    }
  } catch (e) {
    result.ok = false;
    result.errors.push(String((e && e.message) || e));
  }
  return result;
}
// ===== 通知投递可靠性补发 END =====
// ===== 通知触发接线（通知重构第3步B-3：把既有告警调用链切换到统一引擎）=====
// 职责：为 Cron 与探针上报两条既有触发路径提供统一入口，替代原先各自为政的“离线判定 + 直发”双实现。
// 契约：
//   notifyTriggerGate(env, key, { now?, minIntervalMs? }) -> { allowed, key, last_at, now, reason? }
//     以 settings[key] 作为该条路径的节流闸门；两条触发路径使用不同键，互不抢占窗口
//   notifyTriggerStamp(env, key, now) -> { ok, error? }   闸门时间戳落库（UPSERT）
//   runNotifyTriggered(env, key, { now?, minIntervalMs?, drain?, notifyConfig?, skipDelivery? }) -> {
//     triggered, key, reason?, gate, cycle?, drain? }
//     流程：独立节流闸门 -> 落闸门时间戳 -> loadNotifyConfig 就绪判定（无启用规则/通道则静默返回，不写日志）
//           -> runNotifyCycle（评估 + 落状态 + 聚合投递）-> 可选 drainNotifyQueue（失败补发闭环）
// =====
const NOTIFY_TRIGGER_MIN_INTERVAL_MS = 30000;             // 单条触发路径最小执行间隔（与旧 30s 节流等价）
const NOTIFY_TRIGGER_KEY_CRON = 'last_alert_check_at';    // Cron 路径节流键（沿用旧键，保持兼容）
const NOTIFY_TRIGGER_KEY_REPORT = 'last_offline_scan_at'; // 探针上报路径节流键（独立，消除旧双实现抢锁）

// 节流闸门：读取该路径上次执行时间，未到期则拒绝（不写库、不产生副作用）
async function notifyTriggerGate(env, key, opts) {
  const o = opts || {};
  const now = notifyToNum(o.now) === null ? Date.now() : notifyToNum(o.now);
  const iv = notifyToNum(o.minIntervalMs);
  const minMs = Math.max(0, iv === null ? NOTIFY_TRIGGER_MIN_INTERVAL_MS : iv);
  const k = String(key || '');
  if (!k) return { allowed: false, reason: 'bad_key', key: k, now, last_at: 0 };
  let lastAt = 0;
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(k).first();
    lastAt = notifyToNum(row && row.value) || 0;
  } catch (e) { return { allowed: false, reason: 'settings_read_failed', key: k, now, last_at: 0 }; }
  if (lastAt > 0 && now - lastAt < minMs) return { allowed: false, reason: 'throttled', key: k, now, last_at: lastAt };
  return { allowed: true, reason: '', key: k, now, last_at: lastAt };
}

// 闸门时间戳落库（UPSERT；失败不影响本轮投递）
async function notifyTriggerStamp(env, key, now) {
  try {
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(String(key || ''), String(notifyToNum(now) === null ? Date.now() : notifyToNum(now))).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// 统一触发入口：两条既有路径（Cron / 探针上报）均经此函数进入新引擎
async function runNotifyTriggered(env, key, opts) {
  const o = opts || {};
  const out = { triggered: false, key: String(key || ''), reason: '', gate: null, cycle: null, drain: null };
  if (!env || !env.DB) { out.reason = 'db_unavailable'; return out; }
  const gate = await notifyTriggerGate(env, key, o);
  out.gate = gate;
  if (gate.allowed !== true) { out.reason = gate.reason || 'throttled'; return out; }
  out.triggered = true;
  await notifyTriggerStamp(env, key, gate.now);
  const cfg = o.notifyConfig || await loadNotifyConfig(env);
  const hasRules = (cfg.rules || []).length > 0;
  const hasChannels = (cfg.channels || []).length > 0;
  if (hasRules && hasChannels) {
    try { out.cycle = await runNotifyCycle(env, { now: gate.now, notifyConfig: cfg, skipDelivery: o.skipDelivery === true }); }
    catch (e) { out.cycle = { ok: false, errors: [String((e && e.message) || e)] }; }
  } else { out.reason = hasRules ? 'no_channel' : 'no_rule'; }
  if (o.drain === true) {
    try { out.drain = await drainNotifyQueue(env, { now: gate.now }); }
    catch (e) { out.drain = { ok: false, errors: [String((e && e.message) || e)] }; }
  }
  return out;
}
// ===== 通知触发接线 END =====

// 定时告警扫描（B-3 起切换为统一引擎）：仅按独立节流键触发一次通知周期，并附带失败补发闭环，
// 不再自行实现离线判定与直发（判定/投递/状态维护均由 runNotifyCycle 与 drainNotifyQueue 承担）
async function scheduledAlertCheck(env) {
  try {
    return await runNotifyTriggered(env, NOTIFY_TRIGGER_KEY_CRON, { drain: true });
  } catch (e) { return null; }
}


// ---- 手动入口鉴权（入口模板自带，常量时间比较）----
// 与 Pages 侧手动触发接口的鉴权行为保持一致：取 x-cf-secret 请求头或 ?secret= 查询参数，未配置密钥一律拒绝。
// 说明：Pages 侧的 safeEqual 定义在其 fetch 处理器内部（局部作用域），无法在不扩大 @notify-core
//      抽取范围的前提下复用，故在入口模板内自带等价实现。
function cronSafeEqual(a, b) {
  const la = String(a || ""), lb = String(b || "");
  let res = la.length === lb.length ? 0 : 1;
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) res |= (la.charCodeAt(i) || 0) ^ (lb.charCodeAt(i) || 0);
  return res === 0;
}

function cronForbidden() {
  return new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json;charset=UTF-8" }
  });
}

export default {
  // Cron 触发（每分钟）：执行告警检查（含失败补发 drain），异步进行，不阻塞调度返回
  // 定时入口由 Cron Triggers 触发，不需要密钥
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.resolve().then(() => scheduledAlertCheck(env)));
  },

  // 手动触发入口：必须携带密钥（x-cf-secret 请求头或 ?secret= 查询参数），鉴权通过才执行告警检查并回显 JSON 结果
  async fetch(request, env, ctx) {
    // 未配置 API_SECRET 时一律拒绝，避免空值互相匹配导致鉴权被绕过
    if (!env.API_SECRET) return cronForbidden();
    const url = new URL(request.url);
    const provided = request.headers.get("x-cf-secret") || url.searchParams.get("secret") || "";
    if (!cronSafeEqual(provided, env.API_SECRET)) return cronForbidden();

    const startedAt = Date.now();
    try {
      const result = await scheduledAlertCheck(env);
      return new Response(JSON.stringify({ ok: true, triggered: "alert_check", elapsed_ms: Date.now() - startedAt, result }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json;charset=UTF-8" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, elapsed_ms: Date.now() - startedAt, error: String((e && e.message) || e) }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json;charset=UTF-8" }
      });
    }
  }
};
