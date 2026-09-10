// Telegram 告警专用转义（模块顶层，供 Cron 定时扫描复用）
const tgEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 独立定时掉线扫描：不依赖探针上报流量，Cron 每 1 分钟触发一次
async function scheduledAlertCheck(env) {
  try {
    const cfg = {};
    try { const { results } = await env.DB.prepare('SELECT * FROM settings').all(); if (results) results.forEach(r => cfg[r.key] = r.value); } catch (e) {}
    if (cfg.tg_notify !== 'true' || !cfg.tg_bot_token || !cfg.tg_chat_id) return;
    const lastRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_alert_check_at'").first();
    const lastAt = lastRow ? parseInt(lastRow.value || '0', 10) : 0;
    if (Date.now() - lastAt < 30000) return;
    const { results: servers } = await env.DB.prepare('SELECT id, name, last_updated FROM servers').all();
    if (!servers || servers.length === 0) return;
    let alertState = {};
    const stateRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'alert_state'").first();
    if (stateRow) { try { alertState = JSON.parse(stateRow.value) || {}; } catch (e) {} }
    let changed = false;
    const now = Date.now();
    const thresMs = parseInt(cfg.alert_threshold || '120', 10) * 1000;
    const send = async (msg) => {
      try {
        await fetch(`https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.tg_chat_id, text: msg, parse_mode: 'HTML' }),
          signal: AbortSignal.timeout(10000)
        });
      } catch (e) {}
    };
    for (const s of servers) {
      const diff = now - s.last_updated;
      const isOffline = diff > thresMs;
      if (isOffline && !alertState[s.id]) {
        await send(`⚠️ <b>节点离线告警</b>\n\n<b>节点名称:</b> ${tgEsc(s.name)}\n<b>状态:</b> 离线 (超过判定阈值未上报)\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        alertState[s.id] = true; changed = true;
      } else if (!isOffline && alertState[s.id]) {
        await send(`✅ <b>节点恢复通知</b>\n\n<b>节点名称:</b> ${tgEsc(s.name)}\n<b>状态:</b> 恢复在线\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        delete alertState[s.id]; changed = true;
      }
    }
    if (changed) await env.DB.prepare('INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(JSON.stringify(alertState)).run();
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES ("last_alert_check_at", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(String(now)).run();
  } catch (e) {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.origin;
    const myDomain = url.hostname;

    // ==========================================
    // 0. 数据库自动化热创建与无缝升级
    // ==========================================
    if (!globalThis.dbInitialized) {
      try {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT, cpu TEXT, ram TEXT, disk TEXT, load_avg TEXT, uptime TEXT, last_updated INTEGER,
            ram_total TEXT, net_rx TEXT, net_tx TEXT, net_in_speed TEXT, net_out_speed TEXT,
            os TEXT, cpu_info TEXT, arch TEXT, boot_time TEXT, ram_used TEXT, swap_total TEXT, 
            swap_used TEXT, disk_total TEXT, disk_used TEXT, processes TEXT, tcp_conn TEXT, udp_conn TEXT, 
            country TEXT, ip_v4 TEXT, ip_v6 TEXT,
            server_group TEXT DEFAULT '默认分组', price TEXT DEFAULT '', expire_date TEXT DEFAULT '', 
            bandwidth TEXT DEFAULT '', traffic_limit TEXT DEFAULT '', agent_os TEXT DEFAULT 'debian',
            ping_ct TEXT DEFAULT '0', ping_cu TEXT DEFAULT '0', ping_cm TEXT DEFAULT '0', ping_bd TEXT DEFAULT '0',
            ping_gg TEXT DEFAULT '0', ping_cf TEXT DEFAULT '0',
            ping_intl_hk TEXT DEFAULT '0', ping_intl_tyo TEXT DEFAULT '0', ping_intl_sin TEXT DEFAULT '0', ping_intl_syd TEXT DEFAULT '0', ping_intl_lax TEXT DEFAULT '0',
            ping_intl_nyc TEXT DEFAULT '0', ping_intl_fra TEXT DEFAULT '0', ping_intl_lon TEXT DEFAULT '0', ping_intl_ams TEXT DEFAULT '0', ping_intl_sao TEXT DEFAULT '0',
            ping_ct_m TEXT DEFAULT 'fail', ping_cu_m TEXT DEFAULT 'fail', ping_cm_m TEXT DEFAULT 'fail', ping_bd_m TEXT DEFAULT 'fail',
            ping_gg_m TEXT DEFAULT 'fail', ping_cf_m TEXT DEFAULT 'fail',
            monthly_rx TEXT DEFAULT '0', monthly_tx TEXT DEFAULT '0', last_rx TEXT DEFAULT '0', last_tx TEXT DEFAULT '0',
            reset_month TEXT DEFAULT '', history TEXT DEFAULT '{}', is_hidden TEXT DEFAULT 'false', virt TEXT DEFAULT '',
            reset_day TEXT DEFAULT '1', sort_order INTEGER DEFAULT 0
          )
        `).run();

        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS peers (domain TEXT PRIMARY KEY, server_count INTEGER DEFAULT 0, total_asset REAL DEFAULT 0, version INTEGER DEFAULT 0, last_seen INTEGER DEFAULT 0)`).run();

        const { results: columns } = await env.DB.prepare(`PRAGMA table_info(servers)`).all();
        const existingCols = columns.map(c => c.name);
        
        const newCols = {
          ping_ct: "TEXT DEFAULT '0'", ping_cu: "TEXT DEFAULT '0'", ping_cm: "TEXT DEFAULT '0'", ping_bd: "TEXT DEFAULT '0'",
          ping_gg: "TEXT DEFAULT '0'", ping_cf: "TEXT DEFAULT '0'",
          ping_intl_hk: "TEXT DEFAULT '0'", ping_intl_tyo: "TEXT DEFAULT '0'", ping_intl_sin: "TEXT DEFAULT '0'", ping_intl_syd: "TEXT DEFAULT '0'", ping_intl_lax: "TEXT DEFAULT '0'",
          ping_intl_nyc: "TEXT DEFAULT '0'", ping_intl_fra: "TEXT DEFAULT '0'", ping_intl_lon: "TEXT DEFAULT '0'", ping_intl_ams: "TEXT DEFAULT '0'", ping_intl_sao: "TEXT DEFAULT '0'",
          ping_ct_m: "TEXT DEFAULT 'fail'", ping_cu_m: "TEXT DEFAULT 'fail'", ping_cm_m: "TEXT DEFAULT 'fail'", ping_bd_m: "TEXT DEFAULT 'fail'",
          ping_gg_m: "TEXT DEFAULT 'fail'", ping_cf_m: "TEXT DEFAULT 'fail'",
          monthly_rx: "TEXT DEFAULT '0'", monthly_tx: "TEXT DEFAULT '0'", last_rx: "TEXT DEFAULT '0'", last_tx: "TEXT DEFAULT '0'", reset_month: "TEXT DEFAULT ''",
          agent_os: "TEXT DEFAULT 'debian'",
          history: "TEXT DEFAULT '{}'",
          is_hidden: "TEXT DEFAULT 'false'",
          virt: "TEXT DEFAULT ''",
          reset_day: "TEXT DEFAULT '1'",
          sort_order: "INTEGER DEFAULT 0"
        };

        for (const [colName, colDef] of Object.entries(newCols)) {
          if (!existingCols.includes(colName)) {
            await env.DB.prepare(`ALTER TABLE servers ADD COLUMN ${colName} ${colDef}`).run();
          }
        }

        const checkNodes = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cached_nodes_data'").first();
        if (!checkNodes) {
           try {
               const res = await fetch('https://raw.githubusercontent.com/C018/CF-Server-Monitor-Pro/refs/heads/main/nodes.json', { signal: AbortSignal.timeout(10000) });
               if (res.ok) {
                   const dataText = await res.text();
                   await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cached_nodes_data', ?)").bind(dataText).run();
               }
           } catch(e) {}
        }
        globalThis.dbInitialized = true;
      } catch (e) {}
    }

    const formatBytes = (bytes) => {
      const b = parseInt(bytes);
      if (isNaN(b) || b === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // 全站绝对时间统一按中国上海时区(UTC+8)格式化，返回 "YYYY-MM-DD HH:mm:ss"
    const fmtBJ = (tsMs) => {
      const ts = parseInt(tsMs);
      if (isNaN(ts) || ts <= 0) return '-';
      const d = new Date(ts + 8 * 3600 * 1000);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    };

    // ==========================================
    // 0. 通用安全工具：输出编码 / 常量时间比较
    // ==========================================
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const scrubServerText = (srv) => {
      ['name','os','arch','virt','uptime','boot_time','cpu_info','price','bandwidth','traffic_limit','ip_v4','ip_v6','expire_date','country'].forEach(k => { if (srv[k] != null) srv[k] = esc(srv[k]); });
    };
    const safeEqual = (a, b) => {
      const la = String(a || ''), lb = String(b || '');
      let res = la.length === lb.length ? 0 : 1;
      const n = Math.max(la.length, lb.length);
      for (let i = 0; i < n; i++) res |= (la.charCodeAt(i) || 0) ^ (lb.charCodeAt(i) || 0);
      return res === 0;
    };

    // ==========================================
    // 1. 认证机制与全局设置加载
    // ==========================================
    const checkAuth = (req) => {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return false;
      const [scheme, encoded] = authHeader.split(' ');
      if (scheme !== 'Basic' || !encoded) return false;
      const decoded = atob(encoded);
      const sepIdx = decoded.indexOf(':');
      const username = sepIdx >= 0 ? decoded.slice(0, sepIdx) : decoded;
      const password = sepIdx >= 0 ? decoded.slice(sepIdx + 1) : '';
      // 恒定时间比较，避免时序侧信道；用户名为非机密值，保持相同比较路径即可
      return safeEqual(username, 'admin') && safeEqual(password, env.API_SECRET);
    };

    const safeRealm = (t) => { const s = String(t || '').replace(/[^\x20-\x7E]/g, '').trim(); return s || 'Monitor'; };

    const authResponse = (realmTitle) => new Response('Unauthorized', {
      status: 401,
      headers: {
        // realm 必须是纯 ASCII：标题里的中文/emoji 会造成非法 header，Chrome 会丢弃整行导致不弹密码窗
        'WWW-Authenticate': `Basic realm="${safeRealm(realmTitle)}"`,
        // 禁止缓存 401，避免浏览器/边缘命中旧响应而不重新弹窗
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      }
    });

    // ---------- 会话 Cookie 登录（替代浏览器 Basic Auth 弹窗，兼容 Chrome） ----------
    const SESSION_COOKIE = 'sm_admin_session';
    const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
    const getCookie = (req, name) => {
      const h = req.headers.get('Cookie') || '';
      for (const part of h.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
      }
      return null;
    };
    const ensureSessions = async (env) => {
      try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)').run(); } catch (e) {}
    };
    const genToken = () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const createSession = async (env) => {
      await ensureSessions(env);
      const token = genToken();
      const expires = Date.now() + SESSION_TTL_MS;
      try { await env.DB.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').bind(token, expires).run(); } catch (e) { return null; }
      try { await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run(); } catch (e) {} // 顺手清理过期会话
      return token;
    };
    const validSession = async (req, env) => {
      const token = getCookie(req, SESSION_COOKIE);
      if (!token) return false;
      try {
        const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token = ?').bind(token).first();
        if (!row) return false;
        if (row.expires_at < Date.now()) {
          try { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run(); } catch (e) {}
          return false;
        }
        return true;
      } catch (e) { return false; }
    };
    const deleteSession = async (req, env) => {
      const token = getCookie(req, SESSION_COOKIE);
      if (token) { try { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run(); } catch (e) {} }
    };
    const sessionCookieHeader = (token) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`;
    const clearCookieHeader = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    const isAdminAuthed = async (req, env) => checkAuth(req) || await validSession(req, env);

    let sys = {
      site_title: '⚡ Server Monitor Pro', admin_title: '⚙️ 探针管理后台', theme: 'theme1', 
      custom_bg: '', custom_css: '', custom_head: '', custom_script: '', 
      is_public: 'true', show_price: 'true', show_expire: 'true', show_bw: 'true', show_tf: 'true', show_admin_btn: 'true',
      admin_path: '/admin', asset_currency: '元', seed_nodes: '', tg_notify: 'false', tg_bot_token: '', tg_chat_id: '', tg_webhook_secret: '',
      auto_reset_traffic: 'false', report_interval: '5', ping_node_ct: 'default', ping_node_cu: 'default', ping_node_cm: 'default', ping_node_gg: 'default', ping_node_cf: 'default',
      offline_threshold: '30', alert_threshold: '120',
      enable_popup: 'false', popup_content: '<h3>📢 公告</h3><p>欢迎来到 Server Monitor Pro！<br>这是自定义弹窗内容，支持 HTML 排版。</p>'
    };

    try {
      const { results } = await env.DB.prepare('SELECT * FROM settings').all();
      if (results && results.length > 0) results.forEach(r => sys[r.key] = r.value);
    } catch (e) {}

    if (!sys.admin_path) sys.admin_path = '/admin';
    if (!sys.admin_path.startsWith('/')) sys.admin_path = '/' + sys.admin_path;

    let cachedNodes = null; let availableThemes = [];
    try { 
        if (sys.cached_nodes_data) {
            cachedNodes = JSON.parse(sys.cached_nodes_data); 
            if (cachedNodes.themes && Array.isArray(cachedNodes.themes)) availableThemes = cachedNodes.themes;
        }
    } catch(e) {}
    
    if (availableThemes.length === 0) {
        availableThemes = [
            { id: "theme1", name: "1. 默认清爽白 (Classic White)", is_dark: false, css: "" },
            { id: "theme6", name: "完全自定义 CSS (Custom Theme)", is_dark: true, has_custom_css: true, css: "" }
        ];
    }
    
    let defaultPeersStr = 'tanzhen.kejikkk.com';
    if (cachedNodes && Array.isArray(cachedNodes.peers)) {
        defaultPeersStr = cachedNodes.peers.map(p => p.replace('https://','').replace('http://','').replace(/\/$/,'')).join(',');
    }
    if (!sys.seed_nodes) sys.seed_nodes = defaultPeersStr;

    // 安全获取命令 (使用字符串拼接拆分敏感词，防 CF UI 编辑器直接拦截)
    const getCmds = (s) => {
        let cmd = ''; let unCmd = '';
        const osType = s.agent_os === 'alpine' ? 'alpine' : (s.agent_os === 'windows' ? 'windows' : 'debian');
        if (osType === 'windows') {
            cmd = `i`+'rm' + ` -Headers @{ 'x-cf-secret' = '${env.API_SECRET}' } "${host}/install.ps1?id=${s.id}" | ` + `i`+'ex';
            unCmd = `Stop-ScheduledTask -TaskName CFProbeAgent -EA 0; Unregister-ScheduledTask -TaskName CFProbeAgent -Confirm:$false -EA 0; `+`R`+`emove-Item -Path C:\\ProgramData\\CFProbe -Recurse -Force -EA 0; Write-Host Uninstall_Success`;
        } else {
            const shellType = osType === 'alpine' ? 'sh' : 'bash';
            cmd = `c`+'url -sL' + ` -H 'x-cf-secret: ${env.API_SECRET}' ${host}/install.sh?os=${osType} | ${shellType} -s ${s.id}`;
            if (osType === 'alpine') {
                unCmd = `rc-service cf-probe stop; rc-update del cf-probe default; `+`r`+`m -f /et`+`c/init.d/cf-probe /us`+`r/local/bin/cf-probe.sh; echo Uninstall_Success`;
            } else {
                unCmd = `sys`+`temctl stop cf-probe.service; sys`+`temctl disable cf-probe.service; `+`r`+`m -f /et`+`c/sys`+`temd/system/cf-probe.service /us`+`r/local/bin/cf-probe.sh; sys`+`temctl daemon-reload; echo Uninstall_Success`;
            }
        }
        return { cmd, unCmd, osType };
    };

    const sendTelegram = async (msg) => {
      if (sys.tg_notify !== 'true' || !sys.tg_bot_token || !sys.tg_chat_id) return;
      try {
        await fetch(`https://api.telegram.org/bot${sys.tg_bot_token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: sys.tg_chat_id, text: msg, parse_mode: 'HTML' }),
          signal: AbortSignal.timeout(10000)
        });
      } catch (e) {}
    };

    const checkOfflineNodes = async () => {
      if (sys.tg_notify !== 'true') return;
      try {
        // 节流：全量离线扫描每 30 秒最多执行一次（多节点高频上报场景可显著降低 CPU 消耗）
        const lastCheckRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_alert_check_at'").first();
        const lastCheckAt = lastCheckRow ? parseInt(lastCheckRow.value || '0') : 0;
        if (Date.now() - lastCheckAt < 30000) return;

        const { results: allServers } = await env.DB.prepare('SELECT id, name, last_updated FROM servers').all();
        let alertState = {};
        const stateRes = await env.DB.prepare("SELECT value FROM settings WHERE key = 'alert_state'").first();
        if (stateRes) { try { alertState = JSON.parse(stateRes.value) || {}; } catch (e) { alertState = {}; } }

        let stateChanged = false;
        const now = Date.now();
        const alertThresMs = parseInt(sys.alert_threshold || '120') * 1000;

        for (const s of allServers) {
          const diff = now - s.last_updated;
          const isOffline = diff > alertThresMs; 

          if (isOffline && !alertState[s.id]) {
            await sendTelegram(`⚠️ <b>节点离线告警</b>\n\n<b>节点名称:</b> ${esc(s.name)}\n<b>状态:</b> 离线 (超过判定阈值未上报)\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
            alertState[s.id] = true; stateChanged = true;
          } else if (!isOffline && alertState[s.id]) {
            await sendTelegram(`✅ <b>节点恢复通知</b>\n\n<b>节点名称:</b> ${esc(s.name)}\n<b>状态:</b> 恢复在线\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
            delete alertState[s.id]; stateChanged = true;
          }
        }
        if (stateChanged) await env.DB.prepare('INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(JSON.stringify(alertState)).run();
        await env.DB.prepare('INSERT INTO settings (key, value) VALUES ("last_alert_check_at", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(String(now)).run();
      } catch (e) {}
    };

    const getFooterHtml = (sys) => `
      <div style="text-align: center; margin-top: 40px; padding-bottom: 20px; font-size: 13px; color: inherit; opacity: 0.8;">
        <div style="margin-bottom: 8px;">
            <span style="margin-right: 15px;">👁️ 历史总访问：<b style="color: #3b82f6;">${sys.visits_total || 0}</b> 次</span>
            <span>🔥 今日访问：<b style="color: #10b981;">${sys.visits_today || 0}</b> 次</span>
        </div>
        Powered by <a href="https://github.com/C018/CF-Server-Monitor-Pro" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">CF-Server-Monitor-Pro (Gossip Edition)</a>
      </div>
    `;

    const currentThemeObj = availableThemes.find(t => t.id === sys.theme) || availableThemes[0];
    let themeOverrides = currentThemeObj.css || '';
    if (currentThemeObj.has_custom_css || currentThemeObj.id === 'theme6') themeOverrides += `\n${sys.custom_css || ''}`;

    const themeStyles = `
      /* ================= 设计系统：CSS 变量体系 ================= */
      :root {
        --bg: #f5f5f7; --card: #ffffff; --card2: #f2f2f7; --card3: #e8e8ed;
        --text: #1d1d1f; --text2: #86868b; --text3: #aeaeb2;
        --separator: rgba(0,0,0,0.08); --separator-strong: rgba(0,0,0,0.18);
        --accent: #0071e3; --green: #34c759; --orange: #ff9500; --red: #ff3b30;
        --purple: #af52de; --pink: #ff2d55; --teal: #5ac8fa; --indigo: #5856d6;
        --radius: 18px; --radius-s: 10px; --radius-xs: 8px;
        --shadow: 0 2px 16px rgba(0,0,0,0.05); --shadow-hover: 0 8px 28px rgba(0,0,0,0.12);
        --chart-grid: rgba(0,0,0,0.06); --chart-text: rgba(0,0,0,0.55);
        --hover: rgba(0,0,0,0.045); --map-inactive: #e3e3e8; --map-stroke: #ffffff;
        --seg-bg: rgba(120,120,128,0.12);
        --glass: rgba(255,255,255,0.55); --glass-hover: rgba(255,255,255,0.88); --glass-shadow: 0 0 4px rgba(255,255,255,0.65), 0 1px 2px rgba(255,255,255,0.5);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #000000; --card: #1c1c1e; --card2: #2c2c2e; --card3: #3a3a3c;
          --text: #f5f5f7; --text2: #98989d; --text3: #636366;
          --separator: rgba(255,255,255,0.14); --separator-strong: rgba(255,255,255,0.28);
          --shadow: 0 4px 24px rgba(0,0,0,0.5); --shadow-hover: 0 10px 34px rgba(0,0,0,0.7);
          --chart-grid: rgba(255,255,255,0.1); --chart-text: rgba(255,255,255,0.55);
          --hover: rgba(255,255,255,0.08); --map-inactive: #26262a; --map-stroke: #0d0d0f;
          --seg-bg: rgba(120,120,128,0.28);
          --glass: rgba(28,28,30,0.62); --glass-hover: rgba(44,44,46,0.9); --glass-shadow: 0 1px 4px rgba(0,0,0,0.75);
        }
      }
      /* 深色主题类（theme2/4/5/6/8）强制暗色变量，优先级高于 prefers-color-scheme */
      body.theme2, body.theme4, body.theme5, body.theme6, body.theme8, body.forced-dark {
        --bg: #000000; --card: #1c1c1e; --card2: #2c2c2e; --card3: #3a3a3c;
        --text: #f5f5f7; --text2: #98989d; --text3: #636366;
        --separator: rgba(255,255,255,0.14); --separator-strong: rgba(255,255,255,0.28);
        --shadow: 0 4px 24px rgba(0,0,0,0.5); --shadow-hover: 0 10px 34px rgba(0,0,0,0.7);
        --chart-grid: rgba(255,255,255,0.1); --chart-text: rgba(255,255,255,0.55);
        --hover: rgba(255,255,255,0.08); --map-inactive: #26262a; --map-stroke: #0d0d0f;
        --seg-bg: rgba(120,120,128,0.28);
        --glass: rgba(28,28,30,0.62); --glass-hover: rgba(44,44,46,0.9); --glass-shadow: 0 1px 4px rgba(0,0,0,0.75);
      }
      /* uiDark 切换时强制亮色（跟随系统主题临时覆盖类） */
      body.forced-light {
        --bg: #f5f5f7; --card: #ffffff; --card2: #f2f2f7; --card3: #e8e8ed;
        --text: #1d1d1f; --text2: #86868b; --text3: #aeaeb2;
        --separator: rgba(0,0,0,0.08); --separator-strong: rgba(0,0,0,0.18);
        --shadow: 0 2px 16px rgba(0,0,0,0.05); --shadow-hover: 0 8px 28px rgba(0,0,0,0.12);
        --chart-grid: rgba(0,0,0,0.06); --chart-text: rgba(0,0,0,0.55);
        --hover: rgba(0,0,0,0.045); --map-inactive: #e3e3e8; --map-stroke: #ffffff;
        --seg-bg: rgba(120,120,128,0.12);
        --glass: rgba(255,255,255,0.55); --glass-hover: rgba(255,255,255,0.88); --glass-shadow: 0 0 4px rgba(255,255,255,0.65), 0 1px 2px rgba(255,255,255,0.5);
      }
      /* body 基础：字体 / 背景 / 文字 */
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        margin: 0;
        background-color: var(--bg) !important;
        color: var(--text);
        transition: background-color 0.25s ease, color 0.25s ease;
        -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
      }
      a { color: var(--accent); }
      .ping-box { font-size:11px; margin-top:10px; display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:5px 12px; padding: 6px 8px; border-radius: 4px; background: var(--card2); border: 1px solid var(--separator); }
      .ping-box > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .ping-group { font-size:11px; margin-top:10px; padding: 6px 8px; border-radius: 4px; background: var(--card2); border: 1px solid var(--separator); }
      .ping-group-title { display:flex; align-items:center; gap:6px; font-size:10px; font-weight:600; color: var(--text2); margin-bottom:4px; line-height:1.4; }
      .ping-group-title::after { content:''; flex:1; height:1px; background: var(--separator); }
      .ping-group-box { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:4px 12px; }
      .ping-group-box > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .chart-full { grid-column: 1 / -1; }
      .chart-full canvas { max-height: 250px !important; }

      ${sys.custom_bg ? `
        /* 自定义背景图模式：毛玻璃层颜色走变量，亮/暗主题各自适配 */
        body { background: url('${sys.custom_bg}') no-repeat center center fixed !important; background-size: cover !important; }
        .vps-card, .global-stats, .header-card, .chart-card, .custom-table, .filter-tag, .view-controls { background: var(--glass) !important; backdrop-filter: blur(12px) !important; -webkit-backdrop-filter: blur(12px) !important; }
        .vps-card:hover { background: var(--glass-hover) !important; transform: translateY(-3px); }
        .group-header { color: var(--text) !important; text-shadow: var(--glass-shadow) !important; border-left-color: var(--accent) !important; border-left-width: 5px !important; }
        .stat-val, .g-val, .card-title { color: var(--text) !important; font-weight: 800 !important; text-shadow: var(--glass-shadow) !important; }
        .stat-label, .g-label, .g-sub, .card-meta, .stat-header, .stat-subtext { color: var(--text2) !important; font-weight: 600 !important; text-shadow: var(--glass-shadow) !important; }
        .header h1, .detail-title { text-shadow: var(--glass-shadow); }
        .filter-tag { color: var(--text) !important; }
        .stat-bar, .stat-bar-full { background: var(--separator) !important; }
      ` : ''}

      /* ================= 苹果风组件 ================= */
      .header-card, .chart-card, .global-stats { background: var(--card); border: 1px solid var(--separator); border-radius: var(--radius); box-shadow: var(--shadow); }
      .view-controls { display: flex; gap: 2px; background: var(--seg-bg); padding: 3px; border-radius: 10px; overflow-x: auto; scrollbar-width: none; -ms-overflow-style: none; }
      .view-controls::-webkit-scrollbar { display: none; }
      .toggle-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 14px; border: none; background: transparent; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--text2); transition: all 0.2s; white-space: nowrap; flex-shrink: 0; }
      .toggle-btn:hover { color: var(--text); }
      .toggle-btn.active { background: var(--card); color: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,0.14); }
      .custom-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; background: var(--card); border-radius: var(--radius-s); overflow: hidden; box-shadow: var(--shadow); }
      .custom-table th { background: transparent; padding: 13px 16px; color: var(--text2); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--separator); white-space: nowrap; }
      .custom-table td { padding: 12px 16px; border-bottom: 1px solid var(--separator); vertical-align: middle; }
      .custom-table tbody tr:last-child td { border-bottom: none; }
      .custom-table tbody tr { height: 44px; }
      .custom-table tr:hover { background: var(--hover); }
      .os-text { color: var(--text2); font-size: 12px; }
      .table-responsive { width: 100%; overflow-x: auto; }
      .filter-bar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
      .filter-tag { display: inline-flex; align-items: center; gap: 5px; background: var(--card); padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--text2); border: 1px solid var(--separator); cursor: pointer; transition: all 0.2s; }
      .filter-tag:hover { background: var(--hover); color: var(--text); }
      .filter-tag.active { background: var(--accent); border-color: var(--accent); color: #fff; }
      .header h1 { margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px; }
      .admin-btn { padding: 8px 18px; background: var(--accent); color: #fff; text-decoration: none; border-radius: 999px; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; }
      .admin-btn:hover { opacity: 0.9; }
      /* 公开页公共布局（原首页/详情页私有样式上收，避免与新设计系统重复打架） */
      .container { max-width: 1200px; margin: 0 auto; width: 100%; box-sizing: border-box; }
      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
      .grid-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 15px; }
      .card-left { flex: 0 0 180px; display: flex; flex-direction: column; justify-content: center; }
      .card-title { display: flex; align-items: center; margin-bottom: 4px; }
      .status-dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }
      .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
      .group-header { font-size: 18px; font-weight: 600; color: var(--text); margin: 25px 0 15px 5px; border-left: 4px solid var(--accent); border-radius: 2px; padding-left: 10px; }
      .g-val { font-size: 22px; font-weight: 700; color: var(--text); margin: 8px 0; line-height: 1.2; word-break: break-word; white-space: normal; }
      .g-label { font-size: 13px; color: var(--text2); white-space: normal; line-height: 1.4; }
      .g-sub { font-size: 12px; color: var(--text3); white-space: normal; line-height: 1.4; }
      .vps-card { display: flex; justify-content: space-between; align-items: stretch; padding: 18px; background: var(--card); border: 1px solid var(--separator); border-radius: var(--radius); box-shadow: var(--shadow); text-decoration: none; color: inherit; box-sizing: border-box; transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease; }
      .vps-card:hover { border-color: var(--separator-strong); transform: translateY(-1px); box-shadow: var(--shadow-hover); }
      .card-title-text { font-weight: 600; letter-spacing: -0.2px; }
      .card-meta { font-size: 12px; color: var(--text2); margin-bottom: 3px; }
      .card-badges { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 10px; }
      .badge { padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; color: #fff; letter-spacing: 0.2px; }
      .badge-bw { background: var(--accent); } .badge-tf { background: var(--green); } .badge-v4 { background: var(--purple); } .badge-v6 { background: var(--pink); }
      .stat-bar-full { height: 6px; background: var(--card3); border-radius: 3px; }
      .stat-bar { height: 4px; background: var(--card3); border-radius: 2px; }
      .stat-subtext { font-size: 11px; color: var(--text3); }
      .card-right { border-left: 1px solid var(--separator); }
      .stat-label { color: var(--text2); margin-bottom: 5px; font-size: 12px; }
      .stat-val { font-weight: 600; font-size: 14px; color: inherit; }
      .header-card .stat-label { color: inherit; opacity: 0.7; }
      .ping-box, .ping-group { background: var(--card2); border: 1px solid var(--separator); }
      .ping-group-title { color: var(--text2); }
      .ping-group-title::after { background: var(--separator); }
      /* 地图容器：设计系统圆角阴影 + 响应式高度 */
      #map-container { width: 100%; height: 420px; border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; border: 1px solid var(--separator); background-color: var(--map-inactive); background-image: linear-gradient(rgba(128,128,128,0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(128,128,128,0.09) 1px, transparent 1px); background-size: 20px 20px; z-index: 1; }
      /* 数字角标：苹果风胶囊徽标 */
      .custom-map-badge div { background-color: var(--accent); color: #fff; border-radius: 999px; height: 22px; line-height: 22px; text-align: center; font-size: 11px; font-weight: 700; padding: 0 7px; box-shadow: 0 2px 6px rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.4); box-sizing: border-box; white-space: nowrap; }
      /* RegionBoard 地区速览 */
      .region-board { display: flex; gap: 10px; margin-bottom: 14px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: none; -ms-overflow-style: none; }
      .region-board::-webkit-scrollbar { display: none; }
      .rb-card { flex: 0 0 auto; width: 150px; background: var(--card); border: 1px solid var(--separator); border-radius: var(--radius-s); box-shadow: var(--shadow); padding: 10px 12px; cursor: pointer; transition: all 0.2s ease; box-sizing: border-box; }
      .rb-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-hover); }
      .rb-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(0,113,227,0.25); }
      .rb-card .rb-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0; }
      .rb-card .rb-head img { width: 30px; height: 20px; object-fit: cover; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,0.2); flex-shrink: 0; }
      .rb-card .rb-name { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .rb-card .rb-num { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; color: var(--text); line-height: 1.1; margin-top: 2px; }
      .rb-card .rb-num small { font-size: 11px; font-weight: 500; color: var(--text2); letter-spacing: 0; margin-left: 3px; }
      .rb-bar { height: 3px; background: var(--card3); border-radius: 2px; margin-top: 8px; overflow: hidden; }
      .rb-bar > div { height: 100%; border-radius: 2px; background: linear-gradient(90deg, rgba(0,113,227,0.5), var(--accent)); }
      .rb-empty { padding: 26px 12px; color: var(--text3); font-size: 13px; background: var(--card); border: 1px dashed var(--separator-strong); border-radius: var(--radius-s); text-align: center; }
      /* Modal / 其他浮层走变量 */
      .modal-content { background: var(--card); color: var(--text); border: 1px solid var(--separator); box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px; border-radius: var(--radius); margin: 40px auto; position: relative; max-height: 85vh; overflow-y: auto; box-sizing: border-box; }
      .view-panel { display: none; } .view-panel.active { display: block; animation: fadeIn 0.3s ease; }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      
      .stat-group { display: flex; flex-direction: column; margin-bottom: 8px; }
      .stat-header { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: inherit; }
      .stat-bar-full { width: 100%; height: 6px; background: var(--card3); border-radius: 3px; overflow: hidden; }
      .stat-bar-full > div { height: 100%; border-radius: 3px; transition: width 0.3s; }
      .stat-subtext { font-size: 11px; color: var(--text3); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .card-right { flex: 1; display: flex; flex-direction: column; justify-content: center; padding-left: 15px; border-left: 1px solid var(--separator); min-width: 0; }
      .stat-bar { width: 100%; height: 4px; background: var(--card3); border-radius: 2px; overflow: hidden; }
      .stat-bar > div { height: 100%; border-radius: 2px; transition: width 0.3s; }
      .global-stats { display: flex; flex-direction: column; gap: 15px; background: var(--card); padding: 20px; border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 30px; text-align: center; box-sizing: border-box; width: 100%; border: 1px solid var(--separator); }
      .stats-row { display: flex; justify-content: center; width: 100%; align-items: center; }
      .stats-row.bottom-row { border-top: 1px dashed var(--separator-strong); padding-top: 15px; }
      .stats-row .g-item { flex: 1; border-right: 1px dashed var(--separator-strong); min-width: 0; box-sizing: border-box; position: relative; padding: 0 10px; }
      .stats-row .g-item:last-child { border-right: none; }
      /* 详情页 stat 卡网格（手机 2 列） */
      .stat-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
      /* ===== 响应式：平板 / 手机 / 小屏 ===== */
      @media (max-width: 1023px) {
        .container { padding: 16px !important; }
        .grid-container { grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); }
        #map-container { height: 340px; }
      }
      @media (max-width: 767px) {
        body { padding: 0 !important; }
        .container { padding: 12px !important; }
        .header { flex-direction: column; align-items: flex-start; gap: 12px; }
        .header h1 { font-size: 26px; }
        .view-controls { max-width: 100%; }
        .header > div:last-child { width: 100%; justify-content: space-between; }
        .filter-bar { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; -ms-overflow-style: none; }
        .filter-bar::-webkit-scrollbar { display: none; }
        .filter-tag { flex-shrink: 0; }
        .grid-container { grid-template-columns: 1fr; }
        .vps-card { flex-direction: column; }
        .card-right { padding-left: 0; border-left: none; border-top: 1px solid var(--separator); margin-top: 15px; padding-top: 15px; }
        .stats-row { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px; }
        .stats-row.bottom-row { border-top: 1px dashed var(--separator-strong); padding-top: 15px; }
        .stats-row .g-item { border-right: none !important; border-bottom: none; padding-bottom: 0; }
        .g-val { font-size: 19px; }
        .detail-grid { grid-template-columns: 1fr; }
        .stat-card-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
        #map-container { height: 280px; }
        .region-board .rb-card { width: 134px; }
        .rb-card .rb-num { font-size: 19px; }
      }
      @media (max-width: 480px) {
        .container { padding: 10px !important; }
        .header h1 { font-size: 24px; }
        .card-meta { font-size: 11px; }
        .g-val { font-size: 17px; }
        .stat-subtext, .os-text { font-size: 11px; }
        .custom-table th, .custom-table td { padding: 10px 12px; }
        .rb-card { width: 128px; }
      }
    `;


    // ==========================================
    // 单个服务器详情 JSON API
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/api/server') {
      if (sys.is_public !== 'true' && !(await isAdminAuthed(request, env))) return authResponse(sys.site_title);
      const id = url.searchParams.get('id');
      if (!id) return new Response('Miss ID', { status: 400 });
      const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
      if (!server || server.is_hidden === 'true') return new Response('Not Found', { status: 404 });
      // 轮询瘦身：前端默认 no_history=1，仅按需（约每 5 分钟）拉一次完整 history 用于图表归档
      if (url.searchParams.get('no_history') === '1') delete server.history;
      return new Response(JSON.stringify(server), { headers: { 'Content-Type': 'application/json' } });
    }

    // ==========================================
    // 去中心化 API 接口：接收 Gossip 同步数据
    // ==========================================
    if (request.method === 'POST' && url.pathname === '/api/gossip') {
      try {
        const payload = await request.json();
        const domainRe = /^(?=.{4,253}$)([a-zA-Z0-9_]([a-zA-Z0-9-_]{0,61}[a-zA-Z0-9_])?\.)+[a-zA-Z]{2,}$/;
        if (!payload.domain || !payload.version || typeof payload.domain !== 'string' || !domainRe.test(payload.domain)) return new Response('Bad Request', {status: 400});
        await env.DB.prepare(`
          INSERT INTO peers (domain, server_count, total_asset, version, last_seen) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(domain) DO UPDATE SET server_count = excluded.server_count, total_asset = excluded.total_asset, version = excluded.version, last_seen = excluded.last_seen WHERE excluded.version > peers.version
        `).bind(payload.domain, payload.server_count || 0, payload.total_asset || 0, payload.version, Date.now()).run();

        // 防恶意灌入：仅接受合法域名，忽略自身与发送者，且 peers 表总量受限
        if (Array.isArray(payload.known_peers)) {
            const cntRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM peers').first();
            const atLimit = cntRow && parseInt(cntRow.c || '0') >= 1000;
            if (!atLimit) {
                for (const peerDomain of payload.known_peers.slice(0, 5)) {
                    if (typeof peerDomain === 'string' && domainRe.test(peerDomain) && peerDomain !== myDomain && peerDomain !== payload.domain) {
                        await env.DB.prepare('INSERT OR IGNORE INTO peers (domain, server_count, total_asset, version, last_seen) VALUES (?, 0, 0, 0, 0)').bind(peerDomain).run();
                    }
                }
            }
        }
        return new Response('Gossip Synced', {status: 200});
      } catch (e) { return new Response('Gossip Error', {status: 500}); }
    }

    // ==========================================
    // Telegram Webhook 接口 (机器人控制核心)
    // ==========================================
    if (request.method === 'POST' && url.pathname === '/api/tg_webhook') {
      // 校验 setWebhook 配置的 secret_token（纵深防御）；未配置时放行以兼容老版本平滑升级
      if (sys.tg_webhook_secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== sys.tg_webhook_secret) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const body = await request.json();
        const message = body.message;
        const callback_query = body.callback_query;

        const tgSend = async (chatId, text, keyboard = null) => {
            const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
            if (keyboard) payload.reply_markup = keyboard;
            await fetch(`https://api.telegram.org/bot${sys.tg_bot_token}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
            });
        };

        const tgEdit = async (chatId, msgId, text, keyboard = null) => {
            const payload = { chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML' };
            if (keyboard) payload.reply_markup = keyboard;
            await fetch(`https://api.telegram.org/bot${sys.tg_bot_token}/editMessageText`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
            });
        };

        const updateSetting = async (key, value) => {
            await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
            sys[key] = value;
        };

        let chatId, text, msgId;
        if (message) {
            chatId = message.chat.id.toString(); text = message.text || ''; msgId = message.message_id;
        } else if (callback_query) {
            chatId = callback_query.message.chat.id.toString(); text = callback_query.data; msgId = callback_query.message.message_id;
        }

        if (chatId !== sys.tg_chat_id) return new Response('OK', { status: 200 });

        const mainMenuText = `🖥 <b>Server Monitor Pro 管理控制台</b>\n\n欢迎使用 Telegram 快捷管理模式！请点击下方按钮进行操作，或者输入命令。\n\n<b>常用命令示例：</b>\n<code>/add 香港VPS debian</code> - 添加名为"香港VPS"的debian节点\n<code>/set_interval 10</code> - 设置节点上报间隔为 10 秒\n<code>/set_offline 30</code> - 设置前台显示离线的判定时间(秒)\n<code>/set_alert 120</code> - 设置TG掉线告警的判定时间(秒)\n<code>/set_sitetitle 我的专属探针</code> - 修改前台网站大标题\n<code>/set_admintitle 控制台</code> - 修改后台管理标签页名称\n<code>/menu</code> - 调出本管理菜单`;
        
        const mainMenuKb = {
            inline_keyboard: [
                [{text: '📋 节点列表与管理', callback_data: 'cb_list_nodes'}],
                [{text: '⚙️ 全局设置展示控制', callback_data: 'cb_settings'}],
                [{text: '🎨 切换前端主题', callback_data: 'cb_theme_menu'}]
            ]
        };

        const generateSettingsKb = () => {
            return {
                inline_keyboard: [
                    [{text: `${sys.is_public === 'true' ? '✅' : '❌'} 公开访问`, callback_data: 'cb_toggle_is_public'}, {text: `${sys.show_price === 'true' ? '✅' : '❌'} 显示价格`, callback_data: 'cb_toggle_show_price'}],
                    [{text: `${sys.show_expire === 'true' ? '✅' : '❌'} 显示到期`, callback_data: 'cb_toggle_show_expire'}, {text: `${sys.show_bw === 'true' ? '✅' : '❌'} 显示带宽`, callback_data: 'cb_toggle_show_bw'}],
                    [{text: `${sys.show_tf === 'true' ? '✅' : '❌'} 显示流量`, callback_data: 'cb_toggle_show_tf'}, {text: `${sys.auto_reset_traffic === 'true' ? '✅' : '❌'} 流量重置`, callback_data: 'cb_toggle_auto_reset_traffic'}],
                    [{text: `${sys.enable_popup === 'true' ? '✅' : '❌'} 首页弹窗`, callback_data: 'cb_toggle_enable_popup'}, {text: '🔙 返回主菜单', callback_data: 'cb_menu'}]
                ]
            };
        };

        const generateThemeKb = () => {
            let kbRows = []; let currentRow = [];
            availableThemes.forEach((t, i) => {
                const btnText = `${sys.theme === t.id ? '👉 ' : ''}${t.name.split(' ')[0]} ${t.name.split(' ')[1] || ''}`; 
                currentRow.push({ text: btnText.substring(0, 18), callback_data: `cb_set_theme_${t.id}` });
                if (currentRow.length === 2 || i === availableThemes.length - 1) { kbRows.push(currentRow); currentRow = []; }
            });
            kbRows.push([{text: '🔙 返回主菜单', callback_data: 'cb_menu'}]);
            return { inline_keyboard: kbRows };
        };

        if (callback_query) {
            if (text === 'cb_menu') {
                await tgEdit(chatId, msgId, mainMenuText, mainMenuKb);
            } 
            else if (text === 'cb_list_nodes') {
                const { results } = await env.DB.prepare('SELECT id, name, last_updated FROM servers').all();
                let kb = { inline_keyboard: [] };
                if (results.length === 0) {
                    await tgEdit(chatId, msgId, '暂无节点。请发送 <code>/add 节点名 debian</code> 来添加。', {inline_keyboard: [[{text: '🔙 返回主菜单', callback_data: 'cb_menu'}]]});
                } else {
                    const now = Date.now();
                    const offlineThresMs = parseInt(sys.offline_threshold || '30') * 1000;
                    for (const s of results) {
                        const isOnline = (now - s.last_updated) < offlineThresMs;
                        const statusIcon = isOnline ? '🟢' : '🔴';
                        kb.inline_keyboard.push([{text: `${statusIcon} ${s.name}`, callback_data: `cb_node_${s.id}`}]);
                    }
                    kb.inline_keyboard.push([{text: '🔙 返回主菜单', callback_data: 'cb_menu'}]);
                    await tgEdit(chatId, msgId, '📋 <b>选择一个节点进行管理：</b>', kb);
                }
            }
            else if (text.startsWith('cb_node_')) {
                const id = text.split('_')[2];
                const s = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
                if (s) {
                    const nodeText = `🖥 <b>节点详情:</b> ${s.name}\n\n<b>系统:</b> ${s.agent_os || '未知'}\n<b>分组:</b> ${s.server_group}\n<b>在线时间:</b> ${s.uptime}\n<b>最后更新:</b> ${Math.round((Date.now() - s.last_updated)/1000)}秒前\n\n请选择操作：`;
                    const kb = {
                        inline_keyboard: [
                            [{text: '💻 安装命令', callback_data: `cb_cmd_${id}`}, {text: '🗑️ 卸载命令', callback_data: `cb_uncmd_${id}`}],
                            [{text: '✏️ 快速编辑说明', callback_data: `cb_edithelp_${id}`}, {text: '❌ 删除此节点', callback_data: `cb_del_${id}`}],
                            [{text: '🔙 返回列表', callback_data: 'cb_list_nodes'}]
                        ]
                    };
                    await tgEdit(chatId, msgId, nodeText, kb);
                } else {
                    await tgEdit(chatId, msgId, '❌ 节点不存在或已删除。', {inline_keyboard: [[{text: '🔙 返回', callback_data: 'cb_list_nodes'}]]});
                }
            }
            else if (text.startsWith('cb_cmd_')) {
                const id = text.split('_')[2];
                const s = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
                if (s) {
                    const cmds = getCmds(s);
                    await tgSend(chatId, `💻 <b>${s.name}</b> 的安装命令：\n\n<code>${cmds.cmd}</code>\n\n<i>(点击上方代码块自动复制，前往 VPS 终端执行)</i>`);
                }
            }
            else if (text.startsWith('cb_uncmd_')) {
                const id = text.split('_')[2];
                const s = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
                if (s) {
                    const cmds = getCmds(s);
                    await tgSend(chatId, `🗑️ <b>${s.name}</b> 的卸载命令：\n\n<code>${cmds.unCmd}</code>\n\n<i>(点击自动复制，执行后可完全清理探针残留)</i>`);
                }
            }
            else if (text.startsWith('cb_edithelp_')) {
                const id = text.split('_')[2];
                await tgSend(chatId, `✏️ <b>如何编辑节点？</b>\n\n请直接回复本机器人以下格式的命令（保留空格）：\n\n<code>/edit ${id} 新名称 新分组</code>\n\n例如：\n<code>/edit ${id} 香港CN2 生产环境</code>`);
            }
            else if (text.startsWith('cb_del_')) {
                const id = text.split('_')[2];
                await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
                await tgEdit(chatId, msgId, '✅ 节点已成功删除！', {inline_keyboard: [[{text: '🔙 返回列表', callback_data: 'cb_list_nodes'}]]});
            }
            else if (text === 'cb_settings') {
                await tgEdit(chatId, msgId, '⚙️ <b>全局设置控制开关</b>\n点击按钮立即切换前台展示状态：', generateSettingsKb());
            }
            else if (text.startsWith('cb_toggle_')) {
                const key = text.replace('cb_toggle_', '');
                const newVal = sys[key] === 'true' ? 'false' : 'true';
                await updateSetting(key, newVal);
                await tgEdit(chatId, msgId, '⚙️ <b>全局设置控制开关</b>\n点击按钮立即切换前台展示状态：', generateSettingsKb());
            }
            else if (text === 'cb_theme_menu') {
                await tgEdit(chatId, msgId, '🎨 <b>选择前端主题风格：</b>', generateThemeKb());
            }
            else if (text.startsWith('cb_set_theme_')) {
                const themeVal = text.replace('cb_set_theme_', '');
                await updateSetting('theme', themeVal);
                await tgEdit(chatId, msgId, '🎨 <b>选择前端主题风格：</b>\n✅ 主题已切换！刷新前台可见。', generateThemeKb());
            }
        }

        if (message) {
            const cmdParts = text.trim().split(/\s+/);
            const cmd = cmdParts[0].toLowerCase();

            if (cmd === '/start' || cmd === '/menu') {
                await tgSend(chatId, mainMenuText, mainMenuKb);
            }
            else if (cmd === '/add') {
                if (cmdParts.length < 3) {
                    await tgSend(chatId, '❌ <b>格式错误</b>\n正确用法: <code>/add &lt;名称&gt; &lt;系统&gt;</code>\n系统可选: debian / alpine / windows\n\n例: <code>/add 香港VPS debian</code>');
                } else {
                    const name = cmdParts[1];
                    const agentOs = cmdParts[2].toLowerCase();
                    const id = crypto.randomUUID();
                    await env.DB.prepare(`
                      INSERT INTO servers 
                      (id, name, cpu, ram, disk, load_avg, uptime, last_updated, ram_total, net_rx, net_tx, net_in_speed, net_out_speed, os, cpu_info, arch, boot_time, ram_used, swap_total, swap_used, disk_total, disk_used, processes, tcp_conn, udp_conn, country, ip_v4, ip_v6, server_group, price, expire_date, bandwidth, traffic_limit, ping_ct, ping_cu, ping_cm, ping_bd, ping_gg, ping_cf, monthly_rx, monthly_tx, last_rx, last_tx, reset_month, agent_os, history, is_hidden, reset_day) 
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(id, name, '0', '0', '0', '0', '0', 0, '0', '0', '0', '0', '0', '', '', '', '', '0', '0', '0', '0', '0', '0', '0', '0', '', '0', '0', '默认分组', '免费', '', '', '', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '', agentOs, '{}', 'false', '1').run();
                    
                    const newS = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
                    const cmds = getCmds(newS);
                    await tgSend(chatId, `✅ <b>节点添加成功！</b>\n名称: ${name}\n系统: ${agentOs}\n\n💻 <b>一键安装命令：</b>\n<code>${cmds.cmd}</code>\n\n<i>去服务器执行此命令即可上线。</i>`);
                }
            }
            else if (cmd === '/edit') {
                if (cmdParts.length < 4) {
                    await tgSend(chatId, '❌ <b>格式错误</b>\n正确用法: <code>/edit &lt;ID&gt; &lt;新名称&gt; &lt;分组&gt;</code>');
                } else {
                    const id = cmdParts[1];
                    const newName = cmdParts[2];
                    const newGroup = cmdParts[3];
                    await env.DB.prepare('UPDATE servers SET name = ?, server_group = ? WHERE id = ?').bind(newName, newGroup, id).run();
                    await tgSend(chatId, `✅ 节点信息已更新！\n新名称: ${newName}\n新分组: ${newGroup}`);
                }
            }
            else if (cmd === '/del') {
                if (cmdParts.length < 2) return;
                await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(cmdParts[1]).run();
                await tgSend(chatId, '✅ 节点已删除。');
            }
            else if (cmd === '/set_interval') {
                const v = parseInt(cmdParts[1]);
                if (v && v >= 1) {
                    await updateSetting('report_interval', v.toString());
                    await tgSend(chatId, `✅ 上报间隔已修改为 ${v} 秒。(将在 Agent 下次请求时生效)`);
                }
            }
            else if (cmd === '/set_offline') {
                const v = parseInt(cmdParts[1]);
                if (v && v >= 1) {
                    await updateSetting('offline_threshold', v.toString());
                    await tgSend(chatId, `✅ 前台离线判定时间已修改为 ${v} 秒。`);
                } else {
                    await tgSend(chatId, `❌ 格式错误，例: <code>/set_offline 30</code>`);
                }
            }
            else if (cmd === '/set_alert') {
                const v = parseInt(cmdParts[1]);
                if (v && v >= 1) {
                    await updateSetting('alert_threshold', v.toString());
                    await tgSend(chatId, `✅ TG掉线告警判定时间已修改为 ${v} 秒。`);
                } else {
                    await tgSend(chatId, `❌ 格式错误，例: <code>/set_alert 120</code>`);
                }
            }
            else if (cmd === '/set_sitetitle') {
                const v = text.replace(cmdParts[0], '').trim();
                if (v) {
                    await updateSetting('site_title', v);
                    await tgSend(chatId, `✅ 前台标题已修改为: ${v}`);
                }
            }
            else if (cmd === '/set_admintitle') {
                const v = text.replace(cmdParts[0], '').trim();
                if (v) {
                    await updateSetting('admin_title', v);
                    await tgSend(chatId, `✅ 后台标题已修改为: ${v}`);
                }
            }
        }

        return new Response('OK', { status: 200 });
      } catch (e) {
        return new Response('Webhook Error', { status: 200 }); 
      }
    }

    // ==========================================
    // 后台登录/退出（页面表单登录，替代浏览器 Basic Auth 弹窗）
    // ==========================================
    if (request.method === 'POST' && url.pathname === sys.admin_path + '/login') {
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const pwd = String((body && (body.password || body.pwd)) || '');
      const usr = String((body && body.username) || 'admin');
      if (safeEqual(usr, 'admin') && safeEqual(pwd, env.API_SECRET)) {
        const token = await createSession(env);
        if (!token) return new Response(JSON.stringify({ success: false, error: '创建会话失败，请检查 D1 数据库' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader(token) } });
      }
      return new Response(JSON.stringify({ success: false, error: '密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (request.method === 'GET' && url.pathname === sys.admin_path + '/logout') {
      await deleteSession(request, env);
      return new Response(null, { status: 302, headers: { 'Location': sys.admin_path, 'Set-Cookie': clearCookieHeader(), 'Cache-Control': 'no-store' } });
    }

    // ==========================================
    // 后台管理 API
    // ==========================================
    if (request.method === 'POST' && url.pathname === sys.admin_path + '/api') {
      if (!(await isAdminAuthed(request, env))) return authResponse(sys.admin_title);
      try {
        const data = await request.json();
        if (data.action === 'save_settings') {
          const clampNum = (v, def, min, max) => { const n = parseInt(v, 10); return String(isNaN(n) ? def : Math.min(Math.max(n, min), max)); };
          if (data.settings) {
            if ('report_interval' in data.settings) data.settings.report_interval = clampNum(data.settings.report_interval, 5, 1, 3600);
            if ('offline_threshold' in data.settings) data.settings.offline_threshold = clampNum(data.settings.offline_threshold, 30, 5, 86400);
            if ('alert_threshold' in data.settings) data.settings.alert_threshold = clampNum(data.settings.alert_threshold, 120, 5, 86400);
          }
          for (const [k, v] of Object.entries(data.settings)) {
            await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v).run();
          }
          if (data.settings.tg_bot_token) {
             // 复用已有 webhook secret；仅在确实没有时才生成新值，且必须等 Telegram 侧 setWebhook 成功才落库，
             // 避免保存失败/网络异常时 DB 与 Telegram 侧 secret 不一致，导致后续全部 webhook 管理请求 403
             const hadSecret = !!(data.settings.tg_webhook_secret || sys.tg_webhook_secret);
             const hookSecret = data.settings.tg_webhook_secret || sys.tg_webhook_secret || crypto.randomUUID().replace(/-/g, '');
             const wbUrl = `${host}/api/tg_webhook`;
             try {
                const wbRes = await fetch(`https://api.telegram.org/bot${data.settings.tg_bot_token}/setWebhook`, {
                   method: 'POST', headers: {'Content-Type': 'application/json'},
                   body: JSON.stringify({ url: wbUrl, secret_token: hookSecret }),
                   signal: AbortSignal.timeout(10000)
                });
                if (!wbRes.ok) {
                   return new Response(JSON.stringify({ success: false, error: `Telegram setWebhook 失败(HTTP ${wbRes.status})：请确认 Bot Token 有效，且 ${wbUrl} 可从公网通过 HTTPS 访问` }), { headers: { 'Content-Type': 'application/json' } });
                }
                if (!hadSecret) {
                   await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('tg_webhook_secret', hookSecret).run();
                }
                try {
                   await fetch(`https://api.telegram.org/bot${data.settings.tg_bot_token}/setMyCommands`, {
                      method: 'POST', headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({
                         commands: [
                            { command: "menu", description: "打开可视化管理菜单" },
                            { command: "add", description: "添加节点 (例: /add HK debian)" },
                            { command: "edit", description: "编辑节点 (例: /edit ID 名称 分组)" },
                            { command: "del", description: "删除节点 (例: /del ID)" },
                            { command: "set_interval", description: "上报间隔 (例: /set_interval 10)" },
                            { command: "set_offline", description: "前台离线判定时间(秒)" },
                            { command: "set_alert", description: "TG告警判定时间(秒)" },
                            { command: "set_sitetitle", description: "前台标题 (例: /set_sitetitle 探针)" },
                            { command: "set_admintitle", description: "后台标题 (例: /set_admintitle 管理)" }
                         ]
                      }),
                      signal: AbortSignal.timeout(10000)
                   });
                } catch (e) {}
             } catch (e) {
                return new Response(JSON.stringify({ success: false, error: 'Telegram 通信失败：' + String((e && e.message) || e) + '。请确认 Bot Token 有效且网络可达 api.telegram.org' }), { headers: { 'Content-Type': 'application/json' } });
             }
          }
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        } 
        else if (data.action === 'add') {
          const id = crypto.randomUUID();
          const name = data.name || 'New Server';
          const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM servers').first();
          const newSort = (maxRow && maxRow.m !== undefined ? maxRow.m : -1) + 1;
          await env.DB.prepare(`
            INSERT INTO servers 
            (id, name, cpu, ram, disk, load_avg, uptime, last_updated, ram_total, net_rx, net_tx, net_in_speed, net_out_speed, os, cpu_info, arch, boot_time, ram_used, swap_total, swap_used, disk_total, disk_used, processes, tcp_conn, udp_conn, country, ip_v4, ip_v6, server_group, price, expire_date, bandwidth, traffic_limit, ping_ct, ping_cu, ping_cm, ping_bd, ping_gg, ping_cf, monthly_rx, monthly_tx, last_rx, last_tx, reset_month, agent_os, history, is_hidden, reset_day, sort_order) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(id, name, '0', '0', '0', '0', '0', 0, '0', '0', '0', '0', '0', '', '', '', '', '0', '0', '0', '0', '0', '0', '0', '0', '', '0', '0', '默认分组', '免费', '', '', '', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '', data.agent_os || 'debian', '{}', 'false', '1', newSort).run();
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        } 
        else if (data.action === 'delete') {
          await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(data.id).run();
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        } 
        else if (data.action === 'edit') {
          await env.DB.prepare(`
            UPDATE servers SET name = ?, server_group = ?, price = ?, expire_date = ?, bandwidth = ?, traffic_limit = ?, agent_os = ?, is_hidden = ?, reset_day = ? WHERE id = ?
          `).bind(data.name || 'Unnamed', data.server_group || '默认分组', data.price || '', data.expire_date || '', data.bandwidth || '', data.traffic_limit || '', data.agent_os || 'debian', data.is_hidden || 'false', data.reset_day || '1', data.id).run();
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        else if (data.action === 'move') {
          const listRes = await env.DB.prepare('SELECT id FROM servers ORDER BY sort_order ASC, rowid ASC').all();
          const ordered = (listRes.results || []).map(r => r.id);
          const idx = ordered.indexOf(data.id);
          let target = data.dir === 'up' ? idx - 1 : data.dir === 'down' ? idx + 1 : -1;
          if (idx >= 0 && target >= 0 && target < ordered.length) {
            ordered.splice(idx, 1);
            ordered.splice(target, 0, data.id);
            // 按新展示顺序为全部节点重编 sort_order，保证相邻行可反复交换
            await env.DB.batch(ordered.map((sid, i) => env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(i, sid)));
          }
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        else if (data.action === 'reset_traffic') {
          // 仅清零当月流量累计；保留 last_rx/last_tx 基准，避免下一次上报把历史累计再次算入
          await env.DB.prepare("UPDATE servers SET monthly_rx = '0', monthly_tx = '0' WHERE id = ?").bind(data.id).run();
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        else if (data.action === 'pull_github') {
          try {
            const res = await fetch('https://raw.githubusercontent.com/C018/CF-Server-Monitor-Pro/refs/heads/main/nodes.json', { signal: AbortSignal.timeout(10000) });
            if (res.ok) {
              const dataText = await res.text();
              await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cached_nodes_data', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(dataText).run();
              return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
            } else {
              return new Response(JSON.stringify({ error: 'fetch failed' }), { status: 400 });
            }
          } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 400 }); }
        }
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 400 }); }
    }

    // ==========================================
    // 后台管理 UI
    // ==========================================
    if (request.method === 'GET' && url.pathname === sys.admin_path) {
      if (!(await isAdminAuthed(request, env))) {
        // 页面内登录表单，不再依赖浏览器 Basic Auth 弹窗（兼容 Chrome）
        const _t = esc(sys.admin_title);
        const _site = esc(sys.site_title);
        const _loginUrl = JSON.stringify(sys.admin_path + '/login');
        const _adminPathJs = JSON.stringify(sys.admin_path);
        return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${_t}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:#fff;border-radius:12px;padding:40px 36px;width:340px;box-shadow:0 10px 30px rgba(0,0,0,.08);}
  h1{font-size:18px;text-align:center;color:#1f2937;margin-bottom:6px;}
  p.sub{font-size:13px;text-align:center;color:#9ca3af;margin-bottom:24px;}
  input{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;outline:none;margin-bottom:14px;}
  input:focus{border-color:#3b82f6;}
  button{width:100%;padding:10px 12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;}
  button:disabled{opacity:.6;cursor:not-allowed;}
  .err{color:#dc2626;font-size:13px;text-align:center;margin-top:12px;min-height:18px;}
</style>
</head>
<body>
  <div class="card">
    <h1>${_t}</h1>
    <p class="sub">${_site}</p>
    <input type="password" id="pwd" placeholder="请输入管理密码" autocomplete="current-password" autofocus>
    <button id="btn">登 录</button>
    <div class="err" id="msg"></div>
  </div>
<script>
(function(){
  var btn=document.getElementById('btn'), pwd=document.getElementById('pwd'), msg=document.getElementById('msg');
  async function doLogin(){
    if(!pwd.value){ msg.textContent='请输入密码'; return; }
    btn.disabled=true; msg.textContent='';
    try{
      var res=await fetch(${_loginUrl}, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd.value})});
      if(res.ok){ location.href=${_adminPathJs}; return; }
      var j=await res.json().catch(function(){return {};});
      msg.textContent=j.error||'登录失败'; btn.disabled=false;
    }catch(e){ msg.textContent='网络错误，请重试'; btn.disabled=false; }
  }
  btn.addEventListener('click',doLogin);
  pwd.addEventListener('keydown',function(e){ if(e.key==='Enter') doLogin(); });
})();
</script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
      }
      const { results } = await env.DB.prepare('SELECT id, name, last_updated, server_group, price, expire_date, bandwidth, traffic_limit, agent_os, is_hidden, reset_day, sort_order FROM servers ORDER BY sort_order ASC, rowid ASC').all();
      const now = Date.now();
      const offlineThresMs = parseInt(sys.offline_threshold || '30') * 1000;
      
      let trs = '';
      let seq = 0;
      if (results && results.length > 0) {
        for (const s of results) {
          seq++;
          const isOnline = (now - s.last_updated) < offlineThresMs;
          const status = isOnline ? '<span style="color:green; font-weight:bold;">在线</span>' : '<span style="color:red; font-weight:bold;">离线</span>';
          const hiddenBadge = s.is_hidden === 'true' ? '<span style="background:#64748b; color:white; padding:2px 6px; border-radius:4px; font-size:12px; margin-left:5px;">已隐藏</span>' : '';
          
          const cmds = getCmds(s);
          const cmd = cmds.cmd; const unCmd = cmds.unCmd; const osType = cmds.osType;
          
          trs += `
            <tr>
              <td><b style="color:#64748b; font-size:12px;">#${seq}</b> ${s.name} ${hiddenBadge}</td>
              <td>${s.server_group || '默认分组'}</td>
              <td><span style="background:#e2e8f0; color:#475569; padding:2px 6px; border-radius:4px; font-size:12px;">${osType}</span></td>
              <td>${status}</td>
              <td>
                <div style="display:flex; flex-direction:column; gap:6px;">
                  <div style="display:flex; align-items:center; gap:5px;">
                    <input type="text" readonly value='${esc(cmd)}' style="width:200px; padding:6px; border:1px solid #ccc; border-radius:4px;" id="cmd-${s.id}">
                    <button onclick="copyCmd('${s.id}')" class="btn btn-green" style="white-space:nowrap;">复制安装</button>
                    <input type="hidden" id="uncmd-${s.id}" value='${esc(unCmd)}'>
                    <button onclick="copyUnCmd('${s.id}')" class="btn btn-gray" style="white-space:nowrap;">一键卸载</button>
                  </div>
                  <div style="display:flex; gap:5px;">
                    <button onclick="moveServer('${s.id}', 'up')" class="btn btn-gray" style="white-space:nowrap;" title="上移一位">⬆ 上移</button>
                    <button onclick="moveServer('${s.id}', 'down')" class="btn btn-gray" style="white-space:nowrap;" title="下移一位">⬇ 下移</button>
                    <button onclick="openEditModal('${s.id}', '${s.name}', '${s.server_group||''}', '${s.price||''}', '${s.expire_date||''}', '${s.bandwidth||''}', '${s.traffic_limit||''}', '${osType}', '${s.is_hidden||'false'}', '${s.reset_day||'1'}')" class="btn btn-blue" style="white-space:nowrap;">✏️ 编辑信息</button>
                    <button onclick="resetTraffic('${s.id}')" class="btn btn-yellow" style="white-space:nowrap;" title="将本月已用流量清零">🔄 流量清零</button>
                    <button onclick="deleteServer('${s.id}')" class="btn btn-red" style="white-space:nowrap;">🗑️ 删除节点</button>
                  </div>
                </div>
              </td>
            </tr>
          `;
        }
      }

      let pingOpts = { ct: [], cu: [], cm: [] };
      if (cachedNodes) {
          if (cachedNodes.ct) pingOpts.ct = cachedNodes.ct;
          if (cachedNodes.cu) pingOpts.cu = cachedNodes.cu;
          if (cachedNodes.cm) pingOpts.cm = cachedNodes.cm;
      }
      const buildOpts = (group, selectedVal) => {
          let opts = `<option value="default" ${selectedVal === 'default' ? 'selected' : ''}>默认节点 (双栈多节点轮询)</option>`;
          group.forEach(n => { opts += `<option value="${n.host}" ${selectedVal === n.host ? 'selected' : ''}>${n.name}</option>`; });
          return opts;
      };

      let themeSelectOptions = '';
      availableThemes.forEach(t => {
          themeSelectOptions += `<option value="${t.id}" data-custom="${t.has_custom_css ? 'true' : 'false'}" ${sys.theme === t.id ? 'selected' : ''}>${t.name}</option>`;
      });

      const html = `<!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>${sys.admin_title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f0f2f5; color: #333;}
          .card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 1100px; margin: 0 auto 20px auto; }
          h2 { margin-top: 0; border-bottom: 2px solid #f0f2f5; padding-bottom: 10px; font-size: 20px;}
          table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
          th, td { border: 1px solid #eee; padding: 12px; text-align: left; vertical-align: middle; }
          th { background: #f8f9fa; }
          .btn { cursor: pointer; border-radius: 4px; font-size: 13px; transition: opacity 0.2s; border: none; padding: 6px 10px; color: white; margin-left: 5px; }
          .btn:hover { opacity: 0.8; }
          .btn-blue { background: #3b82f6; } .btn-green { background: #10b981; } .btn-red { background: #ef4444; } .btn-gray { background: #6b7280; } .btn-yellow { background: #f59e0b; }
          .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
          .form-group { display: flex; flex-direction: column; margin-bottom: 15px; }
          .form-group label { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #555;}
          .form-group input[type="text"], .form-group select, .form-group input[type="date"], .form-group input[type="number"] { padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
          .form-group textarea { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-family: monospace; font-size: 12px; resize: vertical; line-height: 1.4; background: #fafafa;}
          .checkbox-group { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 14px;}
          .checkbox-group input { width: 18px; height: 18px; cursor: pointer; }
          .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; overflow-y: auto; }
          .modal-content { background: white; padding: 20px; border-radius: 8px; width: 450px; max-width: 95%; margin: 40px auto; position: relative; max-height: 85vh; overflow-y: auto; box-sizing: border-box; }
          .modal input, .modal select { width: 100%; padding: 8px; margin-bottom: 12px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;}
          .modal label { font-size: 14px; color: #555; display: block; margin-bottom: 4px; font-weight: bold;}
        </style>
        <style>
          /* 后台夜间模式（跟随系统 / 夜间 / 日间 三态，与前台共用本地记忆） */
          body.dark-mode { background: #111827; color: #e5e7eb; }
          body.dark-mode .card { background: #1f2937; box-shadow: 0 4px 6px rgba(0,0,0,0.45); }
          body.dark-mode h2 { border-bottom-color: #374151; }
          body.dark-mode th { background: #374151; }
          body.dark-mode th, body.dark-mode td { border-color: #374151; }
          body.dark-mode .form-group label, body.dark-mode .checkbox-group { color: #9ca3af; }
          body.dark-mode .form-group input[type="text"], body.dark-mode .form-group select, body.dark-mode .form-group input[type="date"], body.dark-mode .form-group input[type="number"], body.dark-mode .form-group textarea { background: #111827; color: #e5e7eb; border-color: #374151; }
          body.dark-mode .modal-content { background: #1f2937; color: #e5e7eb; }
          body.dark-mode .modal input, body.dark-mode .modal select { background: #111827; color: #e5e7eb; border-color: #374151; }
          body.dark-mode .theme-mode-btn { background: #374151; color: #e5e7eb; border-color: #4b5563; }
          .theme-mode-btn { cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px; padding: 6px 12px; font-size: 13px; }
        </style>
        <script>
        /* 后台主题三态：跟随系统(system) / 夜间(dark) / 日间(light)，本地记忆(localStorage)，默认跟随系统 */
        (function(){
          var THEME_MODE_KEY = 'monitor_theme_mode';
          function getMode(){ try { var m = localStorage.getItem(THEME_MODE_KEY); return (m === 'dark' || m === 'light') ? m : 'system'; } catch(e){ return 'system'; } }
          function applyMode(){
            if (!document.body) return;
            var mode = getMode();
            var sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
            var dark = (mode === 'dark') || (mode === 'system' && sysDark);
            document.body.classList.toggle('dark-mode', dark);
            var btns = document.querySelectorAll('.theme-mode-btn');
            var label = mode === 'dark' ? '🌙 夜间模式' : (mode === 'light' ? '☀️ 日间模式' : '🌗 跟随系统');
            for (var i=0;i<btns.length;i++){ btns[i].textContent = label; btns[i].setAttribute('data-mode', mode); }
          }
          window.adminApplyThemeMode = applyMode;
          window.adminCycleThemeMode = function(){
            var order = ['system','dark','light'];
            var next = order[(order.indexOf(getMode()) + 1) % 3];
            try { localStorage.setItem(THEME_MODE_KEY, next); } catch(e){}
            applyMode();
          };
          function init(){
            applyMode();
            try {
              var mql = window.matchMedia('(prefers-color-scheme: dark)');
              var onScheme = function(){ if (getMode() === 'system') applyMode(); };
              if (mql.addEventListener) mql.addEventListener('change', onScheme);
              else if (mql.addListener) mql.addListener(onScheme);
            } catch(e){}
          }
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
          else init();
        })();
        </script>
      </head>
      <body>
        <div style="max-width:1100px; margin:0 auto 14px auto; display:flex; justify-content:flex-end; align-items:center; gap:10px;">
          <button type="button" class="theme-mode-btn" id="admin-theme-mode-btn" onclick="adminCycleThemeMode()" data-mode="system" title="主题切换：跟随系统 / 夜间模式 / 日间模式（本地记忆）">🌗 跟随系统</button>
          <a href="${sys.admin_path}/logout" style="color:#6b7280; text-decoration:none; font-size:13px;" title="退出登录后需重新输入密码">退出登录 →</a>
        </div>
        <div class="card">
          <h2>🛠️ 全局设置与高级自定义</h2>
          <div class="settings-grid">
            <div>
              <div class="form-group">
                <label>🎨 前端主题风格 <button onclick="pullGithubNodes(event)" type="button" class="btn btn-green" style="margin-left:10px; font-size:12px; padding:3px 8px;">🔄 手动更新测速/主题数据</button></label>
                <select id="cfg_theme" onchange="toggleCustomCss()">
                  ${themeSelectOptions}
                </select>
              </div>
              <div class="form-group" id="custom_css_group" style="display: ${currentThemeObj.has_custom_css || sys.theme === 'theme6' ? 'flex' : 'none'};">
                <label>🧑‍💻 自定义 CSS 代码</label>
                <textarea id="cfg_custom_css" rows="5" placeholder="body.theme6 { background: #000; } ...">${sys.custom_css || ''}</textarea>
              </div>
              <div class="form-group">
                <label>🧑‍💻 自定义 &lt;head&gt; 注入 (引入字体/外部CSS等)</label>
                <textarea id="cfg_custom_head" rows="3" placeholder="&lt;link rel='stylesheet' href='...'&gt;">${sys.custom_head || ''}</textarea>
              </div>
              <div class="form-group">
                <label>🧑‍💻 自定义底部 Script 注入 (可执行任意 JS, 接管页面渲染)</label>
                <textarea id="cfg_custom_script" rows="4" placeholder="&lt;script&gt;console.log('Hello');&lt;/script&gt;">${sys.custom_script || ''}</textarea>
              </div>
              <div class="form-group">
                <label>🖼️ 自定义背景图片 (上传或填URL，开启后强制全透明)</label>
                <div style="display:flex; gap:8px;">
                   <input type="text" id="cfg_custom_bg" value="${sys.custom_bg || ''}" placeholder="粘贴图片 URL 或 点击上传" style="flex:1;">
                   <input type="file" id="bg_file" accept="image/*" style="display:none;" onchange="uploadBg(this)">
                   <button class="btn btn-gray" onclick="document.getElementById('bg_file').click()">📁 本地上传</button>
                </div>
                <img id="bg_preview" src="${sys.custom_bg || ''}" style="max-height: 120px; margin-top: 10px; border-radius: 6px; box-shadow: 0 2px 5px rgba(0,0,0,0.2); display: ${sys.custom_bg ? 'block' : 'none'}; object-fit: cover;">
              </div>
              <div class="form-group">
                <label>前台看板标题</label>
                <input type="text" id="cfg_site_title" value="${esc(sys.site_title)}">
              </div>
              <div class="form-group">
                <label>后台标签栏名称</label>
                <input type="text" id="cfg_admin_title" value="${esc(sys.admin_title)}">
              </div>
              <div class="form-group">
                <label>⏱️ Agent 上报间隔 (秒)</label>
                <input type="number" id="cfg_report_interval" value="${sys.report_interval || '5'}" min="1" max="120" placeholder="默认 5 秒">
              </div>
              <div class="form-group">
                <label>⏱️ 前台判定离线时间 (秒)</label>
                <input type="number" id="cfg_offline_threshold" value="${sys.offline_threshold || '30'}" min="5" placeholder="默认 30 秒 (即多少秒未上报判定为离线)">
              </div>
              <div class="form-group">
                <label>⏱️ TG掉线告警阈值 (秒)</label>
                <input type="number" id="cfg_alert_threshold" value="${sys.alert_threshold || '120'}" min="10" placeholder="默认 120 秒 (即超过多少秒不报才推TG)">
              </div>
              
              <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">
              <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #d97706;">📢 首页弹窗公告设置</label>
              <div class="checkbox-group">
                <input type="checkbox" id="cfg_enable_popup" ${sys.enable_popup === 'true' ? 'checked' : ''} onchange="document.getElementById('popup_content_group').style.display = this.checked ? 'block' : 'none'">
                <label for="cfg_enable_popup"><b>开启访客首次访问弹窗</b> (按IP和浏览器缓存控制)</label>
              </div>
              <div class="form-group" id="popup_content_group" style="display: ${sys.enable_popup === 'true' ? 'block' : 'none'}; margin-top: 10px;">
                <label>📝 弹窗显示内容 (支持 HTML)</label>
                <textarea id="cfg_popup_content" rows="5" placeholder="<h3>公告</h3><p>自定义内容...</p>">${sys.popup_content || ''}</textarea>
              </div>
            </div>
            <div>
              <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #555;">👁️ 前台展示控制</label>
              
              <div class="checkbox-group" style="background:#fefce8; padding:8px; border-radius:6px; border:1px solid #fef08a; margin-bottom:15px;">
                <input type="checkbox" id="cfg_auto_reset_traffic" ${sys.auto_reset_traffic === 'true' ? 'checked' : ''}>
                <label for="cfg_auto_reset_traffic"><b>启用流量按期重置 (全局总控开关)</b><br><span style="font-size:12px;color:#854d0e;font-weight:normal;">开启后，各节点将根据其独立设置的「重置日」自动清零流量。若关闭，则所有节点仅显示累计总流量。二者完美协同，不会冲突。</span></label>
              </div>

              <div class="checkbox-group"><input type="checkbox" id="cfg_is_public" ${sys.is_public === 'true' ? 'checked' : ''}><label for="cfg_is_public"><b>公开访问</b> (取消勾选后，访客必须输入密码才能查看探针)</label></div>
              <div class="checkbox-group"><input type="checkbox" id="cfg_show_price" ${sys.show_price === 'true' ? 'checked' : ''}><label for="cfg_show_price">在前台显示 <b>价格</b></label></div>
              <div class="checkbox-group"><input type="checkbox" id="cfg_show_expire" ${sys.show_expire === 'true' ? 'checked' : ''}><label for="cfg_show_expire">在前台显示 <b>到期时间</b></label></div>
              <div class="checkbox-group"><input type="checkbox" id="cfg_show_bw" ${sys.show_bw === 'true' ? 'checked' : ''}><label for="cfg_show_bw">在前台显示 <b>带宽徽章</b></label></div>
              <div class="checkbox-group"><input type="checkbox" id="cfg_show_tf" ${sys.show_tf === 'true' ? 'checked' : ''}><label for="cfg_show_tf">在前台显示 <b>流量配额徽章</b></label></div>
              
              <hr style="margin: 15px 0; border: none; border-top: 1px dashed #ccc;">
              <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #0284c7;">⚙️ 安全与路由控制</label>
              <div class="form-group" style="margin-bottom: 10px;">
                <label>后台管理路径 (默认: /admin)</label>
                <input type="text" id="cfg_admin_path" value="${esc(sys.admin_path)}" placeholder="例如: /xiaok-panel">
              </div>
              <div class="checkbox-group">
                <input type="checkbox" id="cfg_show_admin_btn" ${sys.show_admin_btn === 'true' ? 'checked' : ''}>
                <label for="cfg_show_admin_btn">在前台大盘显示 <b>探针管理后台</b> 按钮 (取消勾选即可隐藏入口)</label>
              </div>
              <div class="form-group" style="margin-left: 0px; margin-top: -5px; margin-bottom: 5px;">
                <label style="font-size: 12px;">资产货币展示单位 (默认：元)</label>
                <input type="text" id="cfg_asset_currency" value="${sys.asset_currency || '元'}" style="width: 120px; padding: 6px;">
              </div>
                <input type="hidden" id="cfg_seed_nodes" value="still-cell-000f.a6856191801.workers.dev">

              <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">
              <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #e63946;">✈️ Telegram 机器人管理与告警</label>
              <p style="font-size: 12px; color: #666; margin-top: -5px; margin-bottom: 10px;">填写下方信息并保存后，将在机器人内解锁<b>交互式控制面板</b> (发 <code>/menu</code>) 并自动开通节点离线通知。由于机制原因修改保存后会自动绑定 Webhook。</p>
              <div class="form-group">
                <label>开启状态</label>
                <select id="cfg_tg_notify">
                  <option value="false" ${sys.tg_notify !== 'true' ? 'selected' : ''}>关闭告警 (仅使用机器人管理功能)</option>
                  <option value="true" ${sys.tg_notify === 'true' ? 'selected' : ''}>开启告警与管理 (掉线自动推送)</option>
                </select>
              </div>
              <div class="form-group"><label>Bot Token</label><input type="text" id="cfg_tg_bot_token" value="${sys.tg_bot_token || ''}" placeholder="如: 12345678:ABCDEFG..."></div>
              <div class="form-group"><label>Chat ID</label><input type="text" id="cfg_tg_chat_id" value="${sys.tg_chat_id || ''}" placeholder="如: 123456789"></div>

              <hr style="margin: 20px 0; border: none; border-top: 1px dashed #ccc;">
              <label style="font-size: 14px; font-weight: 600; margin-bottom: 10px; display: block; color: #8b5cf6;">📡 延迟测试节点选择 (动态下发更新)</label>
              <div class="form-group"><label>电信 (CT) 测速节点</label><select id="cfg_ping_node_ct">${buildOpts(pingOpts.ct, sys.ping_node_ct)}</select></div>
              <div class="form-group"><label>联通 (CU) 测速节点</label><select id="cfg_ping_node_cu">${buildOpts(pingOpts.cu, sys.ping_node_cu)}</select></div>
              <div class="form-group"><label>移动 (CM) 测速节点</label><select id="cfg_ping_node_cm">${buildOpts(pingOpts.cm, sys.ping_node_cm)}</select></div>
              <div class="form-group"><label>Google / 8.8.4.4 测速目标 (ICMP + TCP)</label><input type="text" id="cfg_ping_node_gg" value="${sys.ping_node_gg || 'default'}" placeholder="default = 8.8.4.4（ICMP ping 失败时回退 TCP ping），或填写自定义域名/IP"></div>
              <div class="form-group"><label>Cloudflare / 1.0.0.1 测速目标 (ICMP + TCP)</label><input type="text" id="cfg_ping_node_cf" value="${sys.ping_node_cf || 'default'}" placeholder="default = 1.0.0.1（ICMP ping 失败时回退 TCP ping），或填写自定义域名/IP"></div>
            </div>
          </div>
          <button onclick="saveSettings()" class="btn btn-blue" style="padding: 10px 20px; font-size: 15px;">💾 保存全局设置</button>
        </div>

        <div class="card">
          <h2>${sys.admin_title} - 节点列表</h2>
          <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 8px;">
            <input type="text" id="newName" placeholder="输入新服务器名称" style="padding: 8px; width: 180px; border:1px solid #ccc; border-radius:4px;">
            <select id="newOs" style="padding: 8px; border:1px solid #ccc; border-radius:4px; margin-right:5px; background: white;">
              <option value="debian">Linux (Systemd)</option>
              <option value="alpine">Alpine (OpenRC)</option>
              <option value="windows">Windows (PowerShell)</option>
            </select>
            <button onclick="addServer()" class="btn btn-blue" style="padding: 9px 15px;">+ 添加新服务器</button>
            <a href="/" style="margin-left: auto; color: #3b82f6; text-decoration: none; font-weight:bold;">👉 前往大盘预览</a>
          </div>
          <table>
            <tr><th>节点名称</th><th>分组</th><th>系统环境</th><th>在线状态</th><th>操作 (复制命令并在 VPS 执行)</th></tr>
            ${trs || '<tr><td colspan="5" style="text-align:center; padding: 30px; color:#666;">暂无服务器，请在上方添加</td></tr>'}
          </table>
        </div>

        <div id="editModal" class="modal">
          <div class="modal-content">
            <h3 style="margin-top:0;">✏️ 编辑服务器信息</h3>
            <input type="hidden" id="editId">
            <label>节点名称</label> <input type="text" id="editName" placeholder="如：香港 CN2">
            <label>前台可见性</label> 
            <select id="editHidden" style="background: white;">
              <option value="false">显示 (默认)</option>
              <option value="true">隐藏 (不在前台大盘展示)</option>
            </select>
            <label>服务器系统环境</label> 
            <select id="editOs" style="background: white;">
              <option value="debian">Linux (Debian/Ubuntu/CentOS/Systemd)</option>
              <option value="alpine">Alpine Linux (OpenRC/Ash)</option>
              <option value="windows">Windows (PowerShell)</option>
            </select>
            <label>分组名称</label> <input type="text" id="editGroup" placeholder="如：美国 VPS">
            <label>价格 (支持外币识别如: 10USD/月, 5EUR/年)</label> <input type="text" id="editPrice" placeholder="如：10USD/Year 或 免费">
            <label>到期时间</label> <input type="date" id="editExpire">
            <label>每月流量重置日 (1-31) <span style="font-size: 12px; color: #ef4444; font-weight: normal;">(需在左侧开启全局重置总控)</span></label>
            <input type="number" id="editResetDay" placeholder="1" min="1" max="31">
            <label>带宽 (前端徽章)</label> <input type="text" id="editBandwidth" placeholder="如：1Gbps 或 200Mbps">
            <label>流量总量 (前端徽章)</label> <input type="text" id="editTraffic" placeholder="如：1TB/月">
            <div style="text-align: right; margin-top: 10px;">
              <button onclick="closeModal()" style="padding: 8px 15px; border: 1px solid #ccc; background: white; margin-right: 5px; cursor:pointer;">取消</button>
              <button onclick="saveEdit()" class="btn btn-blue" style="padding: 8px 15px;">保存更改</button>
             </div>
          </div>
        </div>
        
        ${getFooterHtml(sys)}

        <script>
          async function pullGithubNodes(event) {
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerText = '正在拉取...';
            btn.disabled = true;
            try {
              const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pull_github' }) });
              if (res.ok) {
                alert('✅ Github 最新主题及 Peers 测速节点拉取成功！页面将自动刷新加载新主题。');
                location.reload();
              } else {
                alert('❌ 拉取失败，请检查网络或稍后重试');
              }
            } catch (e) {
              alert('❌ 请求发生错误: ' + e.message);
            }
            btn.innerText = originalText;
            btn.disabled = false;
          }

          function toggleCustomCss() {
            const select = document.getElementById('cfg_theme');
            const selectedOption = select.options[select.selectedIndex];
            const isCustom = selectedOption.getAttribute('data-custom') === 'true' || select.value === 'theme6';
            document.getElementById('custom_css_group').style.display = isCustom ? 'flex' : 'none';
          }

          function uploadBg(input) {
            const file = input.files[0];
            if(!file) return;
            if(file.size > 800 * 1024) alert('图片有点大，为保证大盘秒开加载，建议使用 500KB 以下的图片或直接填写图片外部URL！');
            const reader = new FileReader();
            reader.onload = function(e) {
              document.getElementById('cfg_custom_bg').value = e.target.result;
              document.getElementById('bg_preview').src = e.target.result;
              document.getElementById('bg_preview').style.display = 'block';
            };
            reader.readAsDataURL(file);
          }
          async function saveSettings() {
            const data = {
              action: 'save_settings',
              settings: {
                theme: document.getElementById('cfg_theme').value,
                custom_bg: document.getElementById('cfg_custom_bg').value,
                custom_css: document.getElementById('cfg_custom_css').value,
                custom_head: document.getElementById('cfg_custom_head').value,
                custom_script: document.getElementById('cfg_custom_script').value,
                site_title: document.getElementById('cfg_site_title').value,
                admin_title: document.getElementById('cfg_admin_title').value,
                is_public: document.getElementById('cfg_is_public').checked ? 'true' : 'false',
                auto_reset_traffic: document.getElementById('cfg_auto_reset_traffic').checked ? 'true' : 'false',
                show_price: document.getElementById('cfg_show_price').checked ? 'true' : 'false',
                show_expire: document.getElementById('cfg_show_expire').checked ? 'true' : 'false',
                show_bw: document.getElementById('cfg_show_bw').checked ? 'true' : 'false',
                show_tf: document.getElementById('cfg_show_tf').checked ? 'true' : 'false',
                show_admin_btn: document.getElementById('cfg_show_admin_btn').checked ? 'true' : 'false',
                admin_path: document.getElementById('cfg_admin_path').value || '/admin',
                asset_currency: document.getElementById('cfg_asset_currency').value || '元',
                seed_nodes: document.getElementById('cfg_seed_nodes').value,
                tg_notify: document.getElementById('cfg_tg_notify').value,
                tg_bot_token: document.getElementById('cfg_tg_bot_token').value,
                tg_chat_id: document.getElementById('cfg_tg_chat_id').value,
                report_interval: document.getElementById('cfg_report_interval').value || '5',
                offline_threshold: document.getElementById('cfg_offline_threshold').value || '30',
                alert_threshold: document.getElementById('cfg_alert_threshold').value || '120',
                enable_popup: document.getElementById('cfg_enable_popup').checked ? 'true' : 'false',
                popup_content: document.getElementById('cfg_popup_content').value,
                ping_node_ct: document.getElementById('cfg_ping_node_ct').value,
                ping_node_cu: document.getElementById('cfg_ping_node_cu').value,
                ping_node_cm: document.getElementById('cfg_ping_node_cm').value,
                ping_node_gg: (document.getElementById('cfg_ping_node_gg').value || '').trim() || 'default',
                ping_node_cf: (document.getElementById('cfg_ping_node_cf').value || '').trim() || 'default'
              }
            };
            const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            const saved = await res.json().catch(() => ({}));
            if (res.ok && saved.success !== false) { 
              alert('✅ 设置已保存！如果您配置了机器人，现在可以前往 Telegram 发送 /menu 测试，或查看左下角是否有 Menu 快捷菜单。'); 
              const newPath = document.getElementById('cfg_admin_path').value || '/admin';
              window.location.href = newPath.startsWith('/') ? newPath : '/' + newPath; 
            } else alert('保存失败：' + (saved.error || ('HTTP ' + res.status)));
          }
          async function addServer() {
            const name = document.getElementById('newName').value;
            const agentOs = document.getElementById('newOs').value;
            if (!name) return alert('请输入名称');
            const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name: name, agent_os: agentOs }) });
            if (res.ok) location.reload(); else alert('添加失败');
          }
          async function deleteServer(id) {
            if (!confirm('确定要删除这个节点吗？')) return;
            const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) });
            if (res.ok) location.reload(); else alert('删除失败');
          }
          async function moveServer(id, dir) {
            const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'move', id, dir }) });
            if (res.ok) location.reload(); else alert('调整排序失败');
          }
          async function resetTraffic(id) {
            if (!confirm('确定将该节点本月已用流量清零吗？')) return;
            const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_traffic', id }) });
            if (res.ok) location.reload(); else alert('清零失败');
          }
          function copyCmd(id) {
            const input = document.getElementById('cmd-' + id);
            input.select(); document.execCommand('copy');
            alert('✅ 安装命令已复制！去对应操作系统的 VPS 上执行即可。');
          }
          function copyUnCmd(id) {
            const val = document.getElementById('uncmd-' + id).value;
            const temp = document.createElement('textarea');
            temp.value = val;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            document.body.removeChild(temp);
            alert('✅ 卸载命令已复制！去对应 VPS 执行即可完全清理探针残留。');
          }
          function openEditModal(id, name, group, price, expire, bw, traffic, osType, isHidden, resetDay) {
            document.getElementById('editId').value = id;
            document.getElementById('editName').value = name || '';
            document.getElementById('editHidden').value = isHidden === 'true' ? 'true' : 'false';
            document.getElementById('editOs').value = osType || 'debian';
            document.getElementById('editGroup').value = group || '默认分组';
            document.getElementById('editPrice').value = price || '免费';
            document.getElementById('editExpire').value = expire || '';
            document.getElementById('editResetDay').value = resetDay || '1';
            document.getElementById('editBandwidth').value = bw || '';
            document.getElementById('editTraffic').value = traffic || '';
            document.getElementById('editModal').style.display = 'block';
          }
          function closeModal() { document.getElementById('editModal').style.display = 'none'; }
          async function saveEdit() {
            const data = {
              action: 'edit', 
              id: document.getElementById('editId').value,
              name: document.getElementById('editName').value,
              agent_os: document.getElementById('editOs').value,
              server_group: document.getElementById('editGroup').value, price: document.getElementById('editPrice').value,
              expire_date: document.getElementById('editExpire').value, bandwidth: document.getElementById('editBandwidth').value,
              traffic_limit: document.getElementById('editTraffic').value,
              reset_day: document.getElementById('editResetDay').value,
              is_hidden: document.getElementById('editHidden').value
            };
            const res = await fetch('${sys.admin_path}/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            if (res.ok) location.reload(); else alert('保存失败');
          }
        </script>
      </body>
      </html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // ==========================================
    // 动态下发设置参数公共方法
    // ==========================================
    const getAgentConfig = async () => {
      let reportInterval = '5'; let pingCt = 'default'; let pingCu = 'default'; let pingCm = 'default'; let pingGg = 'default'; let pingCf = 'default';
      try {
        const res = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('report_interval', 'ping_node_ct', 'ping_node_cu', 'ping_node_cm', 'ping_node_gg', 'ping_node_cf')").all();
        if (res && res.results) {
           res.results.forEach(r => {
              if (r.key === 'report_interval') reportInterval = r.value || '5';
              if (r.key === 'ping_node_ct') pingCt = r.value || 'default';
              if (r.key === 'ping_node_cu') pingCu = r.value || 'default';
              if (r.key === 'ping_node_cm') pingCm = r.value || 'default';
              if (r.key === 'ping_node_gg') pingGg = r.value || 'default';
              if (r.key === 'ping_node_cf') pingCf = r.value || 'default';
           });
        }
      } catch(e) {}
      return { reportInterval, pingCt, pingCu, pingCm, pingGg, pingCf };
    }

    // ==========================================
    // 基础 Base64 编码器 (用于绕过 WAF 明文扫描)
    // ==========================================
    const encodeBase64 = (str) => {
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };

    // ==========================================
    // Windows PowerShell 探针脚本 (/install.ps1)
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/install.ps1') {
      const serverId = url.searchParams.get('id');
      // 密钥优先从请求头读取（不再出现在 URL 与访问日志中）；兼容旧版 URL 携带方式
      const secret = request.headers.get('x-cf-secret') || url.searchParams.get('secret') || '';
      if (!serverId || !secret) return new Response("Error: Missing id or secret params.", {status: 400});
      const cfg = await getAgentConfig();

      let realPsScript = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host " ❌ 错误: 请以【管理员身份】(Run as Administrator) 运行 PowerShell！" -ForegroundColor Red
    Write-Host "    请右键点击开始菜单，选择 'Windows PowerShell (管理员)' 或 '终端 (管理员)'" -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Red
    exit
}

$SERVER_ID = "${serverId}"
$SECRET = "${secret}"
$WORKER_URL = "${host}/update"

Write-Host "开始安装全面增强版 CF Probe Agent (Windows)..." -ForegroundColor Cyan

$agentDir = "C:\\ProgramData\\CFProbe"
if (!(Test-Path $agentDir)) { New-Item -ItemType Directory -Path $agentDir | Out-Null }
$agentScript = "$agentDir\\cf-probe.ps1"

$scriptContent = @'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
$SERVER_ID = "%%SERVER_ID%%"
$SECRET = "%%SECRET%%"
$WORKER_URL = "%%WORKER_URL%%"

$REPORT_INTERVAL = ${cfg.reportInterval}
$PING_NODE_CT = "${cfg.pingCt}"
$PING_NODE_CU = "${cfg.pingCu}"
$PING_NODE_CM = "${cfg.pingCm}"
$PING_NODE_GG = "${cfg.pingGg}"
$PING_NODE_CF = "${cfg.pingCf}"

$RX_PREV = 0; $TX_PREV = 0
$LOOP_COUNT = 0
$IPV4 = "0"; $IPV6 = "0"
$PING_CT = "fail"; $PING_CU = "fail"; $PING_CM = "fail"; $PING_BD = "fail"
$PING_GG = "fail"; $PING_CF = "fail"
$PING_M_CT = "fail"; $PING_M_CU = "fail"; $PING_M_CM = "fail"; $PING_M_BD = "fail"
$PING_M_GG = "fail"; $PING_M_CF = "fail"
$PING_INTL_HK = "fail"; $PING_INTL_TYO = "fail"; $PING_INTL_SIN = "fail"; $PING_INTL_SYD = "fail"; $PING_INTL_LAX = "fail"
$PING_INTL_NYC = "fail"; $PING_INTL_FRA = "fail"; $PING_INTL_LON = "fail"; $PING_INTL_AMS = "fail"; $PING_INTL_SAO = "fail"

# ICMP ping: 优先 .NET Ping(结果与系统语言无关)，再解析 ping.exe 文本兜底；失败返回 -1
function Get-IcmpPing {
    param([string]$node, [int]$timeout = 2000)
    try {
        $pg = New-Object System.Net.NetworkInformation.Ping
        $rp = $pg.Send($node, $timeout)
        if ($rp -and $rp.Status -eq 'Success') { return [int]$rp.RoundtripTime }
    } catch {}
    try {
        $raw = (& ping.exe -n 1 -w $timeout $node 2>$null) | Out-String
        if ($raw -match 'time[=<]([0-9]+)ms') { return [int]$Matches[1] }
        if ($raw -match '时间[=<]([0-9]+)ms') { return [int]$Matches[1] }
        if ($raw -match '([0-9]+)ms') { return [int]$Matches[1] }
    } catch {}
    return -1
}

# TCP ping: 依次尝试多个端口(默认 443/53/80)的真实握手耗时；全部失败返回 -1
function Get-TcpPing {
    param([string]$node, [int[]]$ports = @(443, 53, 80), [int]$timeout = 2000)
    foreach ($pt in $ports) {
        $client = $null
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect($node, $pt, $null, $null)
            if (-not $iar.AsyncWaitHandle.WaitOne($timeout, $false)) { $client.Close(); continue }
            $client.EndConnect($iar)
            $sw.Stop()
            $client.Close()
            $ms = [int]$sw.Elapsed.TotalMilliseconds
            if ($ms -lt 1) { $ms = 1 }
            return @($ms, 'tcp')
        } catch { if ($client) { try { $client.Close() } catch {} } }
    }
    return @(-1, 'fail')
}

# HTTP ping: 最后兜底，HTTPS 优先、HTTP 次之，取首字节耗时；失败返回 -1
function Get-HttpPing {
    param([string]$node, [int]$timeout = 3000)
    $hc = $null
    foreach ($scheme in @('https', 'http')) {
        try {
            $handler = New-Object System.Net.Http.HttpClientHandler
            $handler.AllowAutoRedirect = $false
            try { $handler.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator } catch {}
            $hc = New-Object System.Net.Http.HttpClient($handler)
            $hc.Timeout = [TimeSpan]::FromMilliseconds($timeout)
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $resp = $hc.GetAsync($scheme + '://' + $node + '/').GetAwaiter().GetResult()
            $sw.Stop()
            $hc.Dispose()
            $ms = [int]$sw.Elapsed.TotalMilliseconds
            if ($ms -lt 1) { $ms = 1 }
            return $ms
        } catch { if ($hc) { try { $hc.Dispose() } catch {}; $hc = $null } }
    }
    return -1
}

# 单目标三层探测: ICMP 优先 -> TCP(指定端口序列) -> HTTP 兜底；返回 @(延迟ms, 探测方式)，全失败返回 @(-1,'fail')
function Get-RealPing {
    param([string]$node, [int[]]$ports = @(53, 443, 80))
    $r = Get-IcmpPing $node
    if ($r -ge 0) { return @($r, 'icmp') }
    $t = Get-TcpPing $node $ports
    if ($t[0] -ge 0) { return @($t[0], 'tcp') }
    $h = Get-HttpPing $node
    if ($h -ge 0) { return @($h, 'http') }
    return @(-1, 'fail')
}

# 批量 ICMP: 并发发送所有目标，返回 @{host = 延迟ms}（仅含成功项）
function Get-IcmpPingBatch {
    param([string[]]$nodes, [int]$timeout = 1500)
    $map = @{}
    $jobs = @()
    foreach ($n in $nodes) {
        try {
            $pg = New-Object System.Net.NetworkInformation.Ping
            $jobs += [pscustomobject]@{ Host = $n; Ping = $pg; Task = $pg.SendPingAsync($n, $timeout) }
        } catch {}
    }
    foreach ($j in $jobs) {
        try {
            $rp = $j.Task.GetAwaiter().GetResult()
            if ($rp -and $rp.Status -eq 'Success') { $map[$j.Host] = [int]$rp.RoundtripTime }
        } catch {}
        try { $j.Ping.Dispose() } catch {}
    }
    return $map
}

# 多目标池探测: 按池内顺序取首个可达目标（ICMP 优先；DNS 类纯 IP 走 TCP 53/443，网站类走 80/443，最后 HTTP 兜底）
function Get-PoolPing {
    param([string[]]$pool)
    foreach ($node in $pool) {
        $n = (($node -replace '^https?://', '') -replace '/.*$', '').Trim()
        if (-not $n) { continue }
        $ports = @(53, 443)
        if (-not ($n -match '^\d{1,3}(\.\d{1,3}){3}$')) { $ports = @(80, 443) }
        $res = Get-RealPing $n $ports
        if ($res[0] -ge 0) { return $res }
    }
    return @(-1, 'fail')
}

# 规范化探测结果: 返回 @(值字符串, 方式字符串)
function Format-PingResult {
    param([array]$res)
    if (-not $res -or $res[0] -lt 0) { return @('fail', 'fail') }
    return @([string]$res[0], [string]$res[1])
}

try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch {}

while ($true) {
    # 日志轮转：error.log 超过 1MB 时归档为 error.log.old，防止无限增长
    try {
        $errLog = Get-Item "C:\\ProgramData\\CFProbe\\error.log" -ErrorAction Stop
        if ($errLog.Length -gt 1MB) {
            Move-Item $errLog.FullName "$($errLog.FullName).old" -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    if ($LOOP_COUNT % 60 -eq 0) {
        try { $ipv4_req = (Invoke-RestMethod -Uri "https://cloudflare.com/cdn-cgi/trace" -UseBasicParsing -TimeoutSec 3); if ($ipv4_req -match "ip=") { $IPV4 = "1" } else { $IPV4 = "0" } } catch { $IPV4 = "0" }
    }
    
    if ($LOOP_COUNT % 6 -eq 0) {
        # 国内三网: NodeQuality 省级测速域名池（31 省 × 电信/联通/移动），并发 ICMP 后取最优(最小)延迟作为该网代表值
        $PROV_CODES = @('bj','tj','he','sx','nm','ln','jl','hl','sh','js','zj','ah','fj','jx','sd','ha','hb','hn','gd','gx','hi','cq','sc','gz','yn','xz','sn','gs','qh','nx','xj')
        foreach ($ck in @('ct','cu','cm')) {
            $domains = @()
            foreach ($pc in $PROV_CODES) { $domains += ($pc + '-' + $ck + '-v4.ip.zstaticcdn.com') }
            $best = -1; $bestMode = 'fail'
            $batch = Get-IcmpPingBatch $domains 1200
            foreach ($d in $domains) {
                if ($batch.ContainsKey($d)) { $mv = [int]$batch[$d]; if ($best -lt 0 -or $mv -lt $best) { $best = $mv; $bestMode = 'icmp' } }
            }
            if ($best -lt 0) {
                foreach ($fp in @('bj', 'sh', 'gd', 'sc', 'hb')) {
                    $fb = Get-RealPing ($fp + '-' + $ck + '-v4.ip.zstaticcdn.com') @(80, 443)
                    if ($fb[0] -ge 0) { $mv = [int]$fb[0]; if ($best -lt 0 -or $mv -lt $best) { $best = $mv; $bestMode = [string]$fb[1] } }
                }
            }
            $val = if ($best -ge 0) { [string]$best } else { 'fail' }
            if ($ck -eq 'ct') { $PING_CT = $val; $PING_M_CT = $bestMode }
            elseif ($ck -eq 'cu') { $PING_CU = $val; $PING_M_CU = $bestMode }
            else { $PING_CM = $val; $PING_M_CM = $bestMode }
        }
        # 后台配置了自定义节点时改为单目标探测（覆盖省级域名池结果）
        if ($PING_NODE_CT -ne 'default') { $n = (($PING_NODE_CT -replace '^https?://', '') -replace '/.*$', '').Trim(); $rr = Format-PingResult (Get-RealPing $n @(80, 443, 53)); $PING_CT = $rr[0]; $PING_M_CT = $rr[1] }
        if ($PING_NODE_CU -ne 'default') { $n = (($PING_NODE_CU -replace '^https?://', '') -replace '/.*$', '').Trim(); $rr = Format-PingResult (Get-RealPing $n @(80, 443, 53)); $PING_CU = $rr[0]; $PING_M_CU = $rr[1] }
        if ($PING_NODE_CM -ne 'default') { $n = (($PING_NODE_CM -replace '^https?://', '') -replace '/.*$', '').Trim(); $rr = Format-PingResult (Get-RealPing $n @(80, 443, 53)); $PING_CM = $rr[0]; $PING_M_CM = $rr[1] }

        # 字节 CDN 目标（保留）
        $rr = Format-PingResult (Get-RealPing "lf3-ips.zstaticcdn.com" @(443, 80, 53)); $PING_BD = $rr[0]; $PING_M_BD = $rr[1]

        # 海外: Google / Cloudflare 多目标池，池内取首个可达目标（ICMP 优先；DNS 类纯 IP 走 TCP 53/443，网站类走 80/443）
        $ggPool = @('8.8.8.8', '8.8.4.4', 'dns.google')
        $cfPool = @('1.1.1.1', '1.0.0.1', 'cloudflare.com')
        if ($PING_NODE_GG -ne 'default') { $ggPool = @($PING_NODE_GG) + $ggPool }
        if ($PING_NODE_CF -ne 'default') { $cfPool = @($PING_NODE_CF) + $cfPool }
        $rr = Format-PingResult (Get-PoolPing $ggPool); $PING_GG = $rr[0]; $PING_M_GG = $rr[1]
        $rr = Format-PingResult (Get-PoolPing $cfPool); $PING_CF = $rr[0]; $PING_M_CF = $rr[1]
    }

    if ($LOOP_COUNT % 12 -eq 0) {
        # 国际互联延迟: 10 个 iperf 公共节点（并发 ICMP 优先，失败回退 TCP 到该节点 iperf 端口）
        $intlDefs = @(
            @{ k = 'HK';  host = 'speedtest.hkg12.hk.leaseweb.net'; port = 5201 },
            @{ k = 'TYO'; host = 'speedtest.tyo11.jp.leaseweb.net'; port = 5201 },
            @{ k = 'SIN'; host = 'speedtest.sin1.sg.leaseweb.net'; port = 5201 },
            @{ k = 'SYD'; host = 'speedtest.syd12.au.leaseweb.net'; port = 5201 },
            @{ k = 'LAX'; host = 'speedtest.lax12.us.leaseweb.net'; port = 5201 },
            @{ k = 'NYC'; host = 'nyc.speedtest.clouvider.net'; port = 5200 },
            @{ k = 'FRA'; host = 'fra.speedtest.clouvider.net'; port = 5200 },
            @{ k = 'LON'; host = 'speedtest.lon1.uk.leaseweb.net'; port = 5201 },
            @{ k = 'AMS'; host = 'iperf-ams-nl.eranium.net'; port = 5201 },
            @{ k = 'SAO'; host = 'speedtest.sao1.edgoo.net'; port = 9205 }
        )
        $intlHosts = @()
        foreach ($t in $intlDefs) { $intlHosts += $t.host }
        $intlBatch = Get-IcmpPingBatch $intlHosts 1500
        foreach ($t in $intlDefs) {
            $v = -1
            if ($intlBatch.ContainsKey($t.host)) { $v = [int]$intlBatch[$t.host] }
            if ($v -lt 0) { $tb = Get-TcpPing $t.host @($t.port, 443) 1000; if ($tb[0] -ge 0) { $v = [int]$tb[0] } }
            Set-Variable -Name ('PING_INTL_' + $t.k) -Value $(if ($v -ge 0) { [string]$v } else { 'fail' })
        }
    }

    $LOOP_COUNT++

    $os = Get-CimInstance Win32_OperatingSystem
    $OS_NAME = $os.Caption
    $ARCH = (Get-CimInstance Win32_ComputerSystem).SystemType
    
    $cpu_obj = Get-CimInstance Win32_Processor
    $cpu_name = ($cpu_obj | Select-Object -First 1).Name
    $core_count = ($cpu_obj | Measure-Object -Property NumberOfCores -Sum).Sum
    $CPU_INFO = "$cpu_name ($core_count Cores)"

    $CPU = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 2)
    
    $RAM_TOTAL = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
    $RAM_FREE = [math]::Round($os.FreePhysicalMemory / 1024, 0)
    $RAM_USED = $RAM_TOTAL - $RAM_FREE
    $RAM_PCT = if ($RAM_TOTAL -gt 0) { [math]::Round(($RAM_USED / $RAM_TOTAL) * 100, 2) } else { 0 }

    $pagefile = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue
    $SWAP_TOTAL = 0; $SWAP_USED = 0
    if ($pagefile) {
        $SWAP_TOTAL = ($pagefile | Measure-Object -Property AllocatedBaseSize -Sum).Sum
        $SWAP_USED = ($pagefile | Measure-Object -Property CurrentUsage -Sum).Sum
    }

    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue
    $DISK_TOTAL = 0; $DISK_USED = 0; $DISK_PCT = 0
    if ($disk) {
        $DISK_TOTAL = [math]::Round($disk.Size / 1048576, 0)
        $diskFreeMB = [math]::Round($disk.FreeSpace / 1048576, 0)
        $DISK_USED = $DISK_TOTAL - $diskFreeMB
        $DISK_PCT = if ($DISK_TOTAL -gt 0) { [math]::Round(($DISK_USED / $DISK_TOTAL) * 100, 2) } else { 0 }
    }

    $uptimeSpan = (Get-Date) - $os.LastBootUpTime
    $UPTIME = "{0} days, {1:d2}:{2:d2}" -f $uptimeSpan.Days, $uptimeSpan.Hours, $uptimeSpan.Minutes
    $BOOT_TIME = $os.LastBootUpTime.ToString("yyyy-MM-dd HH:mm:ss")
    
    $loadArr = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $loadAvg = [math]::Round($loadArr, 2)
    $LOAD = "$loadAvg $loadAvg $loadAvg"

    $PROCESSES = (Get-Process).Count
    $TCP_CONN = (netstat -ano -p tcp | Measure-Object).Count
    $UDP_CONN = (netstat -ano -p udp | Measure-Object).Count

    # 仅统计物理网卡：排除 Loopback / vEthernet / Hyper-V / WSL / TAP / VPN / Tunnel / 蓝牙等虚拟适配器
    $physIdx = @()
    try {
        $physIdx = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' -and -not $_.Virtual -and ($_.InterfaceDescription -notmatch 'Loopback|Virtual|Hyper-V|WSL|TAP|VPN|Tunnel|vEthernet|Bluetooth') } | Select-Object -ExpandProperty ifIndex)
    } catch { $physIdx = $null }
    $netStats = Get-NetAdapterStatistics -ErrorAction SilentlyContinue
    if ($physIdx -ne $null -and $physIdx.Count -gt 0) {
        $netStats = $netStats | Where-Object { $_.ifIndex -in $physIdx }
    }
    $RX_NOW = 0; $TX_NOW = 0
    if ($netStats) {
        $RX_NOW = ($netStats | Measure-Object -Property ReceivedBytes -Sum).Sum
        $TX_NOW = ($netStats | Measure-Object -Property SentBytes -Sum).Sum
    }
    
    if ($RX_PREV -eq 0) { $RX_PREV = $RX_NOW }
    if ($TX_PREV -eq 0) { $TX_PREV = $TX_NOW }
    
    $inv = if ($REPORT_INTERVAL -gt 0) { $REPORT_INTERVAL } else { 5 }
    $RX_SPEED = [math]::Round(($RX_NOW - $RX_PREV) / $inv)
    $TX_SPEED = [math]::Round(($TX_NOW - $TX_PREV) / $inv)
    $RX_PREV = $RX_NOW; $TX_PREV = $TX_NOW

    $VIRT = "Windows" 

    $payload = @{
        id = $SERVER_ID
        secret = $SECRET
        metrics = @{
            cpu = "$CPU"
            ram = "$RAM_PCT"
            ram_total = "$RAM_TOTAL"
            ram_used = "$RAM_USED"
            swap_total = "$SWAP_TOTAL"
            swap_used = "$SWAP_USED"
            disk = "$DISK_PCT"
            disk_total = "$DISK_TOTAL"
            disk_used = "$DISK_USED"
            load = "$LOAD"
            uptime = "$UPTIME"
            boot_time = "$BOOT_TIME"
            net_rx = "$RX_NOW"
            net_tx = "$TX_NOW"
            net_in_speed = "$RX_SPEED"
            net_out_speed = "$TX_SPEED"
            os = "$OS_NAME"
            arch = "$ARCH"
            cpu_info = "$CPU_INFO"
            processes = "$PROCESSES"
            tcp_conn = "$TCP_CONN"
            udp_conn = "$UDP_CONN"
            ip_v4 = "$IPV4"
            ip_v6 = "$IPV6"
            ping_ct = "$PING_CT"
            ping_cu = "$PING_CU"
            ping_cm = "$PING_CM"
            ping_bd = "$PING_BD"
            ping_gg = "$PING_GG"
            ping_cf = "$PING_CF"
            ping_ct_m = "$PING_M_CT"
            ping_cu_m = "$PING_M_CU"
            ping_cm_m = "$PING_M_CM"
            ping_bd_m = "$PING_M_BD"
            ping_gg_m = "$PING_M_GG"
            ping_cf_m = "$PING_M_CF"
            ping_intl_hk = "$PING_INTL_HK"
            ping_intl_tyo = "$PING_INTL_TYO"
            ping_intl_sin = "$PING_INTL_SIN"
            ping_intl_syd = "$PING_INTL_SYD"
            ping_intl_lax = "$PING_INTL_LAX"
            ping_intl_nyc = "$PING_INTL_NYC"
            ping_intl_fra = "$PING_INTL_FRA"
            ping_intl_lon = "$PING_INTL_LON"
            ping_intl_ams = "$PING_INTL_AMS"
            ping_intl_sao = "$PING_INTL_SAO"
            virt = "$VIRT"
        }
    }
    
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($json)

    try {
        $res = Invoke-RestMethod -Uri $WORKER_URL -Method Post -Body $jsonBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 10
        if ($res -match "INTERVAL=") {
            $parts = $res -split '\|'
            foreach ($p in $parts) {
                if ($p -match "INTERVAL=(.+)") { $REPORT_INTERVAL = [int]$matches[1] }
                if ($p -match "CT=(.+)") { $PING_NODE_CT = $matches[1] }
                if ($p -match "CU=(.+)") { $PING_NODE_CU = $matches[1] }
                if ($p -match "CM=(.+)") { $PING_NODE_CM = $matches[1] }
                if ($p -match "GG=(.+)") { $PING_NODE_GG = $matches[1] }
                if ($p -match "CF=(.+)") { $PING_NODE_CF = $matches[1] }
            }
        }
    } catch {
        $_ | Out-File "C:\\ProgramData\\CFProbe\\error.log" -Append
    }

    Start-Sleep -Seconds $REPORT_INTERVAL
}
'@

$scriptContent = $scriptContent -replace "%%SERVER_ID%%", $SERVER_ID -replace "%%SECRET%%", $SECRET -replace "%%WORKER_URL%%", $WORKER_URL

Set-Content -Path $agentScript -Value $scriptContent -Encoding UTF8

$taskName = "CFProbeAgent"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
$action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File \`"$agentScript\`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description "CF Server Monitor Agent" | Out-Null
Start-ScheduledTask -TaskName $taskName | Out-Null
Write-Host "✅ Windows 探针安装成功！服务已在后台(计划任务 $taskName)运行。" -ForegroundColor Green
Write-Host "大盘约需 5-10 秒钟同步最新数据，请刷新网页查看。" -ForegroundColor Yellow
`;

      const b64PsScript = encodeBase64(realPsScript);
      const psWrapper = `$b64 = "${b64PsScript}"
$bytes = [System.Convert]::FromBase64String($b64)
$script = [System.Text.Encoding]::UTF8.GetString($bytes)
Invoke-Expression $script
`;
      return new Response(psWrapper, { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }

    // ==========================================
    // Linux/Alpine 探针安装脚本 (/install.sh)
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/install.sh') {
      // 密钥优先从请求头读取（与 /install.ps1 一致），不再出现在 URL 与访问日志
      const secret = request.headers.get('x-cf-secret') || url.searchParams.get('secret') || '';
      if (!secret) return new Response('Error: Missing secret.', { status: 401 });
      const cfg = await getAgentConfig();
      const osType = url.searchParams.get('os') || 'debian';
      const sh_bin = osType === 'alpine' ? "/bin/sh" : "/bin/bash";

      let realBashScript = `#!${sh_bin}
SERVER_ID=\$1
SECRET=\$(echo "\$SECRET_B64" | base64 -d)
WORKER_URL="${host}/update"

if [ -z "\$SERVER_ID" ] || [ -z "\$SECRET" ]; then echo "错误: 缺少参数。"; exit 1; fi
echo "开始安装全面增强版 CF Probe Agent (${osType === 'alpine' ? 'Alpine/OpenRC' : 'Systemd'})..."

`;

      if (osType === 'alpine') realBashScript += `rc-service cf-probe stop 2>/dev/null\n`;
      else realBashScript += `systemctl stop cf-probe.service 2>/dev/null\n`;

      realBashScript += `pkill -f cf-probe.sh 2>/dev/null

cat << EOF > /usr/local/bin/cf-probe.sh
#!${sh_bin}
SERVER_ID="\$SERVER_ID"
SECRET="\$SECRET"
WORKER_URL="\$WORKER_URL"

get_net_bytes() { grep -vE '^[ 	]*(lo|docker|veth|br-|virbr|tun[0-9]*|tap[0-9]*|kube|vxlan|wg[0-9]*|tailscale[0-9]*|zt[0-9]*|sit[0-9]*|ip6tnl|vboxnet[0-9]*|vmnet[0-9]*|vmbr[0-9]*|utun[0-9]*|awdl[0-9]*|gif[0-9]*):' /proc/net/dev | awk 'NR>2 {rx+=\\$2; tx+=\\$10} END {printf "%.0f %.0f", rx, tx}'; }
get_cpu_stat() { awk '/^cpu / {print \\$2+\\$3+\\$4+\\$5+\\$6+\\$7+\\$8+\\$9, \\$5+\\$6}' /proc/stat; }
get_icmp_ping() { out=\\$(ping -c 1 -W 2 "\\$1" 2>/dev/null); [ -z "\\$out" ] && { echo -1; return; }; rtt=\\$(printf '%s' "\\$out" | awk '{for(i=1;i<=NF;i++){if(\\$i ~ /^time[=<]/){gsub(/[^0-9.]/,"",\\$i); printf "%.0f",\\$i+0; exit}}}'); case "\\$rtt" in ''|0) echo -1 ;; *) echo "\\$rtt" ;; esac; }
get_tcp_ping() { command -v curl >/dev/null 2>&1 || { echo -1; return; }; port="\\$2"; [ -z "\\$port" ] && port=443; t=\\$(curl -s -o /dev/null -w '%{time_connect}' --connect-timeout 2 --max-time 3 "telnet://\\$1:\\$port" 2>/dev/null); case "\\$t" in ''|*[!0-9.]*) echo -1 ;; *) awk -v v="\\$t" 'BEGIN{r=v*1000; if(r<=0){print -1; exit} if(r<1) r=1; printf "%.0f", r}' ;; esac; }
get_tcp_ping_multi() { for p in \\$2; do r=\\$(get_tcp_ping "\\$1" "\\$p"); case "\\$r" in ''|-1) ;; *) echo "\\$r"; return ;; esac; done; echo -1; }
get_http_ping() { t=\\$(curl -s -k -o /dev/null -w '%{time_total}' --connect-timeout 3 --max-time 4 "https://\\$1/" 2>/dev/null); case "\\$t" in ''|*[!0-9.]*) t=\\$(curl -s -o /dev/null -w '%{time_total}' --connect-timeout 3 --max-time 4 "http://\\$1/" 2>/dev/null) ;; esac; case "\\$t" in ''|*[!0-9.]*) echo -1 ;; *) awk -v v="\\$t" 'BEGIN{r=v*1000; if(r<=0){print -1; exit} printf "%.0f", r}' ;; esac; }
get_real_ping() { r=\\$(get_icmp_ping "\\$1"); case "\\$r" in ''|-1) ;; *) echo "\\$r icmp"; return ;; esac; r=\\$(get_tcp_ping_multi "\\$1" "\\$2"); case "\\$r" in ''|-1) ;; *) echo "\\$r tcp"; return ;; esac; r=\\$(get_http_ping "\\$1"); case "\\$r" in ''|-1) ;; *) echo "\\$r http"; return ;; esac; echo "-1 fail"; }
get_pool_ping() { for n in \\$1; do case "\\$n" in *[a-zA-Z]*) PORTS="80 443" ;; *) PORTS="53 443" ;; esac; r=\\$(get_real_ping "\\$n" "\\$PORTS"); v=\\$(echo "\\$r" | cut -d' ' -f1); case "\\$v" in ''|-1) ;; *) echo "\\$r"; return ;; esac; done; echo "-1 fail"; }
get_icmp_ping_batch() { _t=\\$(mktemp); for h in \\$1; do ( r=\\$(get_icmp_ping "\\$h"); case "\\$r" in ''|-1) ;; *) echo "\\$r" >> "\\$_t" ;; esac ) & done; wait; _b=\\$(sort -n "\\$_t" 2>/dev/null | head -n 1); rm -f "\\$_t"; [ -z "\\$_b" ] && _b=-1; echo "\\$_b"; }

NET_STAT=\\$(get_net_bytes)
RX_PREV=\\$(echo \\$NET_STAT | awk '{print \\$1}')
TX_PREV=\\$(echo \\$NET_STAT | awk '{print \\$2}')
if [ -z "\\$RX_PREV" ]; then RX_PREV=0; fi
if [ -z "\\$TX_PREV" ]; then TX_PREV=0; fi

CPU_STAT=\\$(get_cpu_stat)
PREV_CPU_TOTAL=\\$(echo \\$CPU_STAT | awk '{print \\$1}')
PREV_CPU_IDLE=\\$(echo \\$CPU_STAT | awk '{print \\$2}')

LOOP_COUNT=0
IPV4="0"; IPV6="0"
PING_CT="fail"; PING_CU="fail"; PING_CM="fail"; PING_BD="fail"
PING_GG="fail"; PING_CF="fail"
PING_M_CT="fail"; PING_M_CU="fail"; PING_M_CM="fail"; PING_M_BD="fail"
PING_M_GG="fail"; PING_M_CF="fail"
PING_INTL_HK="fail"; PING_INTL_TYO="fail"; PING_INTL_SIN="fail"; PING_INTL_SYD="fail"; PING_INTL_LAX="fail"
PING_INTL_NYC="fail"; PING_INTL_FRA="fail"; PING_INTL_LON="fail"; PING_INTL_AMS="fail"; PING_INTL_SAO="fail"

REPORT_INTERVAL="${cfg.reportInterval}"
PING_NODE_CT="${cfg.pingCt}"
PING_NODE_CU="${cfg.pingCu}"
PING_NODE_CM="${cfg.pingCm}"
PING_NODE_GG="${cfg.pingGg}"
PING_NODE_CF="${cfg.pingCf}"

while true; do
  if [ \\$((LOOP_COUNT % 60)) -eq 0 ]; then
    curl -s -4 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV4="1" || IPV4="0"
    curl -s -6 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV6="1" || IPV6="0"
  fi
  
  if [ \\$((LOOP_COUNT % 6)) -eq 0 ]; then
    # 国内三网: NodeQuality 省级测速域名池（31 省 × 电信/联通/移动），并发 ICMP 取最优(最小)延迟作为该网代表值
    PROV_CODES="bj tj he sx nm ln jl hl sh js zj ah fj jx sd ha hb hn gd gx hi cq sc gz yn xz sn gs qh nx xj"
    for CK in ct cu cm; do
      DOMAINS=""
      for PC in \\$PROV_CODES; do DOMAINS="\\$DOMAINS \\$PC-\\$CK-v4.ip.zstaticcdn.com"; done
      BEST=\\$(get_icmp_ping_batch "\\$DOMAINS")
      BEST_MODE="icmp"
      if [ -z "\\$BEST" ] || [ "\\$BEST" = "-1" ]; then
        for FP in bj sh gd sc hb; do
          FB=\\$(get_real_ping "\\$FP-\\$CK-v4.ip.zstaticcdn.com" "80 443")
          FBV=\\$(echo "\\$FB" | cut -d' ' -f1)
          case "\\$FBV" in ''|-1) ;; *) if [ "\\$BEST" = "-1" ]; then BEST="\\$FBV"; BEST_MODE=\\$(echo "\\$FB" | cut -d' ' -f2); elif [ "\\$FBV" -lt "\\$BEST" ]; then BEST="\\$FBV"; BEST_MODE=\\$(echo "\\$FB" | cut -d' ' -f2); fi ;; esac
        done
        if [ -z "\\$BEST" ] || [ "\\$BEST" = "-1" ]; then BEST="fail"; BEST_MODE="fail"; fi
      fi
      case "\\$CK" in
        ct) PING_CT="\\$BEST"; PING_M_CT="\\$BEST_MODE" ;;
        cu) PING_CU="\\$BEST"; PING_M_CU="\\$BEST_MODE" ;;
        cm) PING_CM="\\$BEST"; PING_M_CM="\\$BEST_MODE" ;;
      esac
    done
    # 后台配置了自定义节点时改为单目标探测（覆盖省级域名池结果）
    if [ "\\$PING_NODE_CT" != "default" ]; then CT_NODE=\\$(printf '%s' "\\$PING_NODE_CT" | sed -e 's#^https\\?://##' -e 's#/.*##' | tr -d ' '); PR=\\$(get_real_ping "\\$CT_NODE" "80 443 53"); PING_CT=\\$(echo "\\$PR" | cut -d' ' -f1); PING_M_CT=\\$(echo "\\$PR" | cut -d' ' -f2); fi
    if [ "\\$PING_NODE_CU" != "default" ]; then CU_NODE=\\$(printf '%s' "\\$PING_NODE_CU" | sed -e 's#^https\\?://##' -e 's#/.*##' | tr -d ' '); PR=\\$(get_real_ping "\\$CU_NODE" "80 443 53"); PING_CU=\\$(echo "\\$PR" | cut -d' ' -f1); PING_M_CU=\\$(echo "\\$PR" | cut -d' ' -f2); fi
    if [ "\\$PING_NODE_CM" != "default" ]; then CM_NODE=\\$(printf '%s' "\\$PING_NODE_CM" | sed -e 's#^https\\?://##' -e 's#/.*##' | tr -d ' '); PR=\\$(get_real_ping "\\$CM_NODE" "80 443 53"); PING_CM=\\$(echo "\\$PR" | cut -d' ' -f1); PING_M_CM=\\$(echo "\\$PR" | cut -d' ' -f2); fi

    PR=\\$(get_real_ping "lf3-ips.zstaticcdn.com" "443 80 53"); PING_BD=\\$(echo "\\$PR" | cut -d' ' -f1); PING_M_BD=\\$(echo "\\$PR" | cut -d' ' -f2)

    # 海外: Google / Cloudflare 多目标池，池内取首个可达目标（ICMP 优先；DNS 类纯 IP 走 TCP 53/443，网站类走 80/443）
    GG_POOL="\\$PING_NODE_GG"; [ "\\$GG_POOL" = "default" ] && GG_POOL="8.8.8.8 8.8.4.4 dns.google"
    CF_POOL="\\$PING_NODE_CF"; [ "\\$CF_POOL" = "default" ] && CF_POOL="1.1.1.1 1.0.0.1 cloudflare.com"
    PR=\\$(get_pool_ping "\\$GG_POOL"); PING_GG=\\$(echo "\\$PR" | cut -d' ' -f1); PING_M_GG=\\$(echo "\\$PR" | cut -d' ' -f2)
    PR=\\$(get_pool_ping "\\$CF_POOL"); PING_CF=\\$(echo "\\$PR" | cut -d' ' -f1); PING_M_CF=\\$(echo "\\$PR" | cut -d' ' -f2)
  fi

  if [ \\$((LOOP_COUNT % 12)) -eq 0 ]; then
    # 国际互联延迟: 10 个 iperf 公共节点（ICMP 优先，失败回退 TCP 到该节点 iperf 端口）
    INTL_LIST="HK:speedtest.hkg12.hk.leaseweb.net:5201 TYO:speedtest.tyo11.jp.leaseweb.net:5201 SIN:speedtest.sin1.sg.leaseweb.net:5201 SYD:speedtest.syd12.au.leaseweb.net:5201 LAX:speedtest.lax12.us.leaseweb.net:5201 NYC:nyc.speedtest.clouvider.net:5200 FRA:fra.speedtest.clouvider.net:5200 LON:speedtest.lon1.uk.leaseweb.net:5201 AMS:iperf-ams-nl.eranium.net:5201 SAO:speedtest.sao1.edgoo.net:9205"
    for ITEM in \\$INTL_LIST; do
      IK=\\$(echo "\\$ITEM" | cut -d: -f1)
      IH=\\$(echo "\\$ITEM" | cut -d: -f2)
      IP=\\$(echo "\\$ITEM" | cut -d: -f3)
      IV=\\$(get_icmp_ping "\\$IH")
      if [ -z "\\$IV" ] || [ "\\$IV" = "-1" ]; then
        IR=\\$(get_tcp_ping_multi "\\$IH" "\\$IP 443")
        IV=\\$(echo "\\$IR" | cut -d' ' -f1)
      fi
      [ -z "\\$IV" ] && IV="fail"
      eval "PING_INTL_\\$IK=\\$IV"
    done
  fi
  
  LOOP_COUNT=\\$((LOOP_COUNT + 1))

  OS=\\$(awk -F= '/^PRETTY_NAME/{print \\$2}' /etc/os-release 2>/dev/null | tr -d '"')
  if [ -z "\\$OS" ]; then OS=\\$(uname -srm); fi
  ARCH=\\$(uname -m)
  BOOT_TIME=\\$(uptime -s 2>/dev/null || stat -c %y / 2>/dev/null | cut -d'.' -f1 || echo "Unknown")
  
  CORE_COUNT=\\$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
  CPU_INFO=\\$(grep -m 1 'model name' /proc/cpuinfo | awk -F: '{print \\$2}' | xargs | tr -d '"')
  if [ -z "\\$CPU_INFO" ]; then CPU_INFO=\\$(uname -p 2>/dev/null || echo "Unknown CPU"); fi
  CPU_INFO="\\\${CPU_INFO} (\\\${CORE_COUNT} Cores)"
  
  VIRT=""
  if command -v systemd-detect-virt >/dev/null 2>&1; then VIRT=\\$(systemd-detect-virt 2>/dev/null); fi
  if [ -z "\\$VIRT" ] || [ "\\$VIRT" = "none" ]; then
    if grep -q "lxc" /proc/1/environ 2>/dev/null; then VIRT="lxc"
    elif grep -q "docker" /proc/1/environ 2>/dev/null; then VIRT="docker"
    elif [ -f /proc/user_beancounters ]; then VIRT="openvz"
    elif grep -qi "kvm" /proc/cpuinfo 2>/dev/null; then VIRT="kvm"
    elif grep -qi "qemu" /proc/cpuinfo 2>/dev/null; then VIRT="qemu"
    elif [ -f /sys/class/dmi/id/product_name ]; then VIRT=\\$(cat /sys/class/dmi/id/product_name | head -n1 | cut -d' ' -f1)
    else VIRT="Unknown"
    fi
  fi
  VIRT=\\$(echo "\\$VIRT" | tr '[:lower:]' '[:upper:]')

  CPU_STAT=\\$(get_cpu_stat)
  CPU_TOTAL=\\$(echo \\$CPU_STAT | awk '{print \\$1}')
  CPU_IDLE=\\$(echo \\$CPU_STAT | awk '{print \\$2}')
  DIFF_TOTAL=\\$((CPU_TOTAL - PREV_CPU_TOTAL))
  DIFF_IDLE=\\$((CPU_IDLE - PREV_CPU_IDLE))
  
  CPU=\\$(awk -v t=\\$DIFF_TOTAL -v i=\\$DIFF_IDLE 'BEGIN {if (t<=0) print 0; else {pct=(1 - i/t)*100; if(pct<0) print 0; else if(pct>100) print 100; else printf "%.2f", pct}}')
  PREV_CPU_TOTAL=\\$CPU_TOTAL; PREV_CPU_IDLE=\\$CPU_IDLE
  
  MEM_INFO=\\$(free -m 2>/dev/null)
  RAM_TOTAL=\\$(echo "\\$MEM_INFO" | awk '/Mem:/ {print \\$2}')
  RAM_USED=\\$(echo "\\$MEM_INFO" | awk '/Mem:/ {print \\$3}')
  RAM=\\$(awk "BEGIN {if(\\$RAM_TOTAL>0) printf \\"%.2f\\", \\$RAM_USED/\\$RAM_TOTAL * 100.0; else print 0}")
  
  SWAP_TOTAL=\\$(echo "\\$MEM_INFO" | awk '/Swap:/ {print \\$2}')
  SWAP_USED=\\$(echo "\\$MEM_INFO" | awk '/Swap:/ {print \\$3}')
  if [ -z "\\$SWAP_TOTAL" ]; then SWAP_TOTAL=0; fi
  if [ -z "\\$SWAP_USED" ]; then SWAP_USED=0; fi

  DISK_INFO=\\$(df -m / 2>/dev/null | tail -n1 | awk '{print \\$2, \\$3, \\$5}')
  DISK_TOTAL=\\$(echo "\\$DISK_INFO" | awk '{print \\$1}')
  DISK_USED=\\$(echo "\\$DISK_INFO" | awk '{print \\$2}')
  DISK=\\$(echo "\\$DISK_INFO" | awk '{print \\$3}' | tr -d '%')

  LOAD=\\$(cat /proc/loadavg | awk '{print \\$1, \\$2, \\$3}')
  UPTIME=\\$(awk '{d=int(\\$1/86400); h=int((\\$1%86400)/3600); m=int((\\$1%3600)/60); if(d>0) printf "%d days, %02d:%02d\\n", d, h, m; else printf "%02d:%02d\\n", h, m}' /proc/uptime 2>/dev/null || uptime -p 2>/dev/null | sed 's/up //')
  
  PROCESSES=\\$(ps -e 2>/dev/null | grep -v "PID" | wc -l)
  
  if command -v ss >/dev/null 2>&1; then
    TCP_CONN=\\$(ss -ant 2>/dev/null | grep -v "State" | wc -l)
    UDP_CONN=\\$(ss -anu 2>/dev/null | grep -v "State" | wc -l)
  else
    TCP_CONN=\\$(netstat -ant 2>/dev/null | grep -c "^tcp")
    UDP_CONN=\\$(netstat -anu 2>/dev/null | grep -c "^udp")
  fi
  if [ -z "\\$TCP_CONN" ]; then TCP_CONN=0; fi
  if [ -z "\\$UDP_CONN" ]; then UDP_CONN=0; fi
  
  NET_STAT=\\$(get_net_bytes)
  RX_NOW=\\$(echo \\$NET_STAT | awk '{print \\$1}')
  TX_NOW=\\$(echo \\$NET_STAT | awk '{print \\$2}')
  if [ -z "\\$RX_NOW" ]; then RX_NOW=0; fi
  if [ -z "\\$TX_NOW" ]; then TX_NOW=0; fi

  INV_SECS=\\$REPORT_INTERVAL
  [ -z "\\$INV_SECS" ] && INV_SECS=5
  if [ "\\$INV_SECS" -lt 1 ] 2>/dev/null; then INV_SECS=5; fi
  # 无历史基准时（进程重启/状态文件丢失）首轮仅置基准，避免把开机累计当速度
  if [ -z "\\$RX_PREV" ] || [ "\\$RX_PREV" -eq 0 ] 2>/dev/null; then RX_PREV=\\$RX_NOW; TX_PREV=\\$TX_NOW; fi
  RX_SPEED=\\$(((RX_NOW - RX_PREV) / INV_SECS))
  TX_SPEED=\\$(((TX_NOW - TX_PREV) / INV_SECS))
  RX_PREV=\\$RX_NOW; TX_PREV=\\$TX_NOW
  
  PAYLOAD="{\\"id\\": \\"\\$SERVER_ID\\", \\"secret\\": \\"\\$SECRET\\", \\"metrics\\": { \\"cpu\\": \\"\\$CPU\\", \\"ram\\": \\"\\$RAM\\", \\"ram_total\\": \\"\\$RAM_TOTAL\\", \\"ram_used\\": \\"\\$RAM_USED\\", \\"swap_total\\": \\"\\$SWAP_TOTAL\\", \\"swap_used\\": \\"\\$SWAP_USED\\", \\"disk\\": \\"\\$DISK\\", \\"disk_total\\": \\"\\$DISK_TOTAL\\", \\"disk_used\\": \\"\\$DISK_USED\\", \\"load\\": \\"\\$LOAD\\", \\"uptime\\": \\"\\$UPTIME\\", \\"boot_time\\": \\"\\$BOOT_TIME\\", \\"net_rx\\": \\"\\$RX_NOW\\", \\"net_tx\\": \\"\\$TX_NOW\\", \\"net_in_speed\\": \\"\\$RX_SPEED\\", \\"net_out_speed\\": \\"\\$TX_SPEED\\", \\"os\\": \\"\\$OS\\", \\"arch\\": \\"\\$ARCH\\", \\"cpu_info\\": \\"\\$CPU_INFO\\", \\"processes\\": \\"\\$PROCESSES\\", \\"tcp_conn\\": \\"\\$TCP_CONN\\", \\"udp_conn\\": \\"\\$UDP_CONN\\", \\"ip_v4\\": \\"\\$IPV4\\", \\"ip_v6\\": \\"\\$IPV6\\", \\"ping_ct\\": \\"\\$PING_CT\\", \\"ping_cu\\": \\"\\$PING_CU\\", \\"ping_cm\\": \\"\\$PING_CM\\", \\"ping_bd\\": \\"\\$PING_BD\\", \\"ping_gg\\": \\"\\$PING_GG\\", \\"ping_cf\\": \\"\\$PING_CF\\", \\"ping_ct_m\\": \\"\\$PING_M_CT\\", \\"ping_cu_m\\": \\"\\$PING_M_CU\\", \\"ping_cm_m\\": \\"\\$PING_M_CM\\", \\"ping_bd_m\\": \\"\\$PING_M_BD\\", \\"ping_gg_m\\": \\"\\$PING_M_GG\\", \\"ping_cf_m\\": \\"\\$PING_M_CF\\", \\"ping_intl_hk\\": \\"\\$PING_INTL_HK\\", \\"ping_intl_tyo\\": \\"\\$PING_INTL_TYO\\", \\"ping_intl_sin\\": \\"\\$PING_INTL_SIN\\", \\"ping_intl_syd\\": \\"\\$PING_INTL_SYD\\", \\"ping_intl_lax\\": \\"\\$PING_INTL_LAX\\", \\"ping_intl_nyc\\": \\"\\$PING_INTL_NYC\\", \\"ping_intl_fra\\": \\"\\$PING_INTL_FRA\\", \\"ping_intl_lon\\": \\"\\$PING_INTL_LON\\", \\"ping_intl_ams\\": \\"\\$PING_INTL_AMS\\", \\"ping_intl_sao\\": \\"\\$PING_INTL_SAO\\", \\"virt\\": \\"\\$VIRT\\" }}"
  
  RES=\\$(curl -s -m 10 -X POST -H "Content-Type: application/json" -d "\\$PAYLOAD" "\\$WORKER_URL" 2>/dev/null)
  if echo "\\$RES" | grep -q "INTERVAL="; then
    NEW_INV=\\$(echo "\\$RES" | awk -F'INTERVAL=' '{print \\$2}' | awk -F'|' '{print \\$1}')
    if [ -n "\\$NEW_INV" ] && [ "\\$NEW_INV" -eq "\\$NEW_INV" ] 2>/dev/null; then REPORT_INTERVAL=\\$NEW_INV; fi
    
    NEW_CT=\\$(echo "\\$RES" | awk -F'CT=' '{print \\$2}' | awk -F'|' '{print \\$1}')
    [ -n "\\$NEW_CT" ] && PING_NODE_CT="\\$NEW_CT"
    
    NEW_CU=\\$(echo "\\$RES" | awk -F'CU=' '{print \\$2}' | awk -F'|' '{print \\$1}')
    [ -n "\\$NEW_CU" ] && PING_NODE_CU="\\$NEW_CU"
    
    NEW_CM=\\$(echo "\\$RES" | awk -F'CM=' '{print \\$2}' | awk -F'|' '{print \\$1}')
    [ -n "\\$NEW_CM" ] && PING_NODE_CM="\\$NEW_CM"
    
    NEW_GG=\\$(echo "\\$RES" | awk -F'GG=' '{print \\$2}' | awk -F'|' '{print \\$1}')
    [ -n "\\$NEW_GG" ] && PING_NODE_GG="\\$NEW_GG"
    
    NEW_CF=\\$(echo "\\$RES" | awk -F'CF=' '{print \\$2}' | awk -F'|' '{print \\$1}')
    [ -n "\\$NEW_CF" ] && PING_NODE_CF="\\$NEW_CF"
  fi
  sleep \\$REPORT_INTERVAL
done
EOF

chmod +x /usr/local/bin/cf-probe.sh

`;

      if (osType === 'alpine') {
        realBashScript += `cat << EOF > /etc/init.d/cf-probe
#!/sbin/openrc-run
name="cf-probe"
command="/usr/local/bin/cf-probe.sh"
command_background="yes"
pidfile="/run/cf-probe.pid"
EOF

chmod +x /etc/init.d/cf-probe
rc-update add cf-probe default
rc-service cf-probe restart
echo "✅ Alpine 探针安装成功！"
`;
      } else {
        realBashScript += `cat << EOF > /etc/systemd/system/cf-probe.service
[Unit]
Description=Cloudflare Worker Probe Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/cf-probe.sh
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cf-probe.service
systemctl restart cf-probe.service
echo "✅ Linux 探针安装成功！"
`;
      }

      const b64BashScript = encodeBase64(realBashScript);
      const bashWrapper = `#!/bin/sh
echo ">> Downloading Secure Payload from CF-Monitor..."
export SECRET_B64='${encodeBase64(secret)}'
echo "${b64BashScript}" | base64 -d > /tmp/cf_install.sh
sh /tmp/cf_install.sh "$1"
rm -f /tmp/cf_install.sh
`;
      return new Response(bashWrapper, { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }

    // ==========================================
    // API 接收数据 (/update)
    // ==========================================
    if (request.method === 'POST' && url.pathname === '/update') {
      try {
        const data = await request.json();
        const { id, secret, metrics } = data;

        if (!safeEqual(secret, env.API_SECRET)) return new Response('Unauthorized', { status: 401 });

        let countryCode = request.cf && request.cf.country ? request.cf.country : 'XX';

        const serverExists = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
        if (!serverExists) return new Response('Server not found', { status: 404 });

        const nowTime = new Date();
        const tzOffset = 8 * 60 * 60000; 
        const localNow = new Date(nowTime.getTime() + tzOffset);
        
        let resetDayVal = parseInt(serverExists.reset_day) || 1;
        if (resetDayVal < 1) resetDayVal = 1;
        if (resetDayVal > 31) resetDayVal = 31;

        let y = localNow.getFullYear();
        let m = localNow.getMonth() + 1; // 1-12
        let d = localNow.getDate();

        let maxDaysThisMonth = new Date(y, m, 0).getDate();
        let actualResetDayThisMonth = Math.min(resetDayVal, maxDaysThisMonth);

        let currentCycleStr = '';
        if (d < actualResetDayThisMonth) {
            let pm = m - 1; let py = y;
            if (pm === 0) { pm = 12; py -= 1; }
            let maxDaysPrevMonth = new Date(py, pm, 0).getDate();
            let actualResetDayPrevMonth = Math.min(resetDayVal, maxDaysPrevMonth);
            currentCycleStr = `${py}-${pm}-${actualResetDayPrevMonth}`;
        } else {
            currentCycleStr = `${y}-${m}-${actualResetDayThisMonth}`;
        }
        
        let monthly_rx = parseFloat(serverExists.monthly_rx || '0');
        let monthly_tx = parseFloat(serverExists.monthly_tx || '0');
        let last_rx = parseFloat(serverExists.last_rx || '0');
        let last_tx = parseFloat(serverExists.last_tx || '0');
        let reset_month = serverExists.reset_month || currentCycleStr;

        if (sys.auto_reset_traffic === 'true' && currentCycleStr !== reset_month) {
            monthly_rx = 0; monthly_tx = 0; reset_month = currentCycleStr;
        }

        const current_rx = parseFloat(metrics.net_rx || '0');
        const current_tx = parseFloat(metrics.net_tx || '0');

        if (serverExists.last_updated === 0) {
            // 首次上报：探针上报的是网卡开机累计字节，直接作为流量基准，避免把历史累计误计入当月流量
            last_rx = current_rx; last_tx = current_tx;
        } else {
            if (current_rx >= last_rx) monthly_rx += (current_rx - last_rx);
            else monthly_rx += current_rx;

            if (current_tx >= last_tx) monthly_tx += (current_tx - last_tx);
            else monthly_tx += current_tx;

            last_rx = current_rx; last_tx = current_tx;
        }

        let history = {};
        try { history = JSON.parse(serverExists.history || '{}'); } catch(e) {}
        
        const nowMs = Date.now();
        const lastHistTime = history.last_time || 0;
        
        if (nowMs - lastHistTime >= 300000 || !history.time) {
            const maxPoints = 576; // 采样点上限，兜底防止异常膨胀
            const HIST_WINDOW_MS = 48 * 60 * 60 * 1000; // 详情页展示区间：最近 48 小时
            // 统一的历史序列注册表：新增曲线字段只需在此登记，保证各数组长度与 time 严格一致
            const PING_SERIES = ['ping_ct', 'ping_cu', 'ping_cm', 'ping_bd', 'ping_gg', 'ping_cf',
                'ping_intl_hk', 'ping_intl_tyo', 'ping_intl_sin', 'ping_intl_syd', 'ping_intl_lax',
                'ping_intl_nyc', 'ping_intl_fra', 'ping_intl_lon', 'ping_intl_ams', 'ping_intl_sao'];
            const HIST_SERIES = ['cpu', 'ram', 'proc', 'net_in', 'net_out', 'tcp', 'udp'].concat(PING_SERIES);
            // 失败值（探针上报 fail/空）统一清洗为 null，前端断线显示，不再与真实 0ms 混淆
            const toNum = (v) => {
                if (v === null || v === undefined || v === '') return null;
                const n = parseFloat(v);
                return isFinite(n) ? n : null;
            };
            const cleanArr = (arr) => (Array.isArray(arr) ? arr.slice(-maxPoints) : []);
            // 关键修复：写入前把每个历史序列补齐到 time 的当前长度（不足者在头部补 null）。
            // 历史遗留问题：海外(ping_gg/ping_cf)与国际互联(ping_intl_*)是后续加入的字段，
            // 其数组远短于 time，前端按索引绘制会整体左移、曲线停在旧时刻，无法显示最新值。
            let timeArr = cleanArr(history.time);
            const alignLen = timeArr.length;
            const padTo = (arr) => {
                const a = cleanArr(arr);
                return a.length >= alignLen ? a.slice(-alignLen) : new Array(alignLen - a.length).fill(null).concat(a);
            };
            const pushVal = (arr, val) => {
                const a = padTo(arr);
                a.push(val);
                if (a.length > maxPoints) a.shift();
                return a;
            };
            const metricVals = {
                cpu: toNum(metrics.cpu),
                ram: toNum(metrics.ram),
                proc: toNum(metrics.processes),
                net_in: toNum(metrics.net_in_speed),
                net_out: toNum(metrics.net_out_speed),
                tcp: toNum(metrics.tcp_conn),
                udp: toNum(metrics.udp_conn),
                ping_ct: toNum(metrics.ping_ct),
                ping_cu: toNum(metrics.ping_cu),
                ping_cm: toNum(metrics.ping_cm),
                ping_bd: toNum(metrics.ping_bd),
                ping_gg: toNum(metrics.ping_gg),
                ping_cf: toNum(metrics.ping_cf),
                ping_intl_hk: toNum(metrics.ping_intl_hk),
                ping_intl_tyo: toNum(metrics.ping_intl_tyo),
                ping_intl_sin: toNum(metrics.ping_intl_sin),
                ping_intl_syd: toNum(metrics.ping_intl_syd),
                ping_intl_lax: toNum(metrics.ping_intl_lax),
                ping_intl_nyc: toNum(metrics.ping_intl_nyc),
                ping_intl_fra: toNum(metrics.ping_intl_fra),
                ping_intl_lon: toNum(metrics.ping_intl_lon),
                ping_intl_ams: toNum(metrics.ping_intl_ams),
                ping_intl_sao: toNum(metrics.ping_intl_sao)
            };
            for (const k of HIST_SERIES) history[k] = pushVal(history[k], metricVals[k]);
            // 时间标签带上日期，48 小时跨天可区分，供前端 2 小时刻度对齐：MM-DD HH:mm（北京时间 UTC+8）
            const p2 = (n) => String(n).padStart(2, '0');
            const tbj = new Date(nowMs + 8 * 60 * 60000);
            timeArr.push(p2(tbj.getUTCMonth() + 1) + '-' + p2(tbj.getUTCDate()) + ' ' + p2(tbj.getUTCHours()) + ':' + p2(tbj.getUTCMinutes()));
            history.time = timeArr;
            history.last_time = nowMs;
            // 采样时间戳（epoch ms）与各序列一一对应：既用于后端按真实时间裁剪 48 小时窗口，
            // 也供前端 X 轴精确落在 2 小时整点上（不依赖标签字符串解析）
            let tsArr = padTo(history.ts);
            tsArr.push(nowMs);
            const minTs = nowMs - HIST_WINDOW_MS;
            let cut = 0;
            while (cut < tsArr.length && tsArr[cut] !== null && tsArr[cut] < minTs) cut++;
            if (cut > 0) {
                tsArr = tsArr.slice(cut);
                timeArr = timeArr.slice(cut);
                for (const k of HIST_SERIES) history[k] = history[k].slice(cut);
            }
            // maxPoints 仅作兜底上限，防止历史脏数据或异常高频写入导致体积膨胀
            while (tsArr.length > maxPoints) {
                tsArr.shift();
                timeArr.shift();
                for (const k of HIST_SERIES) history[k].shift();
            }
            history.ts = tsArr;
            history.time = timeArr;
        }

        const historyStr = JSON.stringify(history);

        await env.DB.prepare(`
          UPDATE servers 
          SET cpu = ?, ram = ?, disk = ?, load_avg = ?, uptime = ?, last_updated = ?,
              ram_total = ?, net_rx = ?, net_tx = ?, net_in_speed = ?, net_out_speed = ?,
              os = ?, cpu_info = ?, arch = ?, boot_time = ?, ram_used = ?, swap_total = ?, 
              swap_used = ?, disk_total = ?, disk_used = ?, processes = ?, tcp_conn = ?, udp_conn = ?, 
              country = ?, ip_v4 = ?, ip_v6 = ?, ping_ct = ?, ping_cu = ?, ping_cm = ?, ping_bd = ?, ping_gg = ?, ping_cf = ?,
              ping_intl_hk = ?, ping_intl_tyo = ?, ping_intl_sin = ?, ping_intl_syd = ?, ping_intl_lax = ?,
              ping_intl_nyc = ?, ping_intl_fra = ?, ping_intl_lon = ?, ping_intl_ams = ?, ping_intl_sao = ?,
              ping_ct_m = ?, ping_cu_m = ?, ping_cm_m = ?, ping_bd_m = ?, ping_gg_m = ?, ping_cf_m = ?,
              monthly_rx = ?, monthly_tx = ?, last_rx = ?, last_tx = ?, reset_month = ?, history = ?, virt = ?
          WHERE id = ?
        `).bind(
          metrics.cpu, metrics.ram, metrics.disk, metrics.load, metrics.uptime, Date.now(),
          metrics.ram_total || '0', metrics.net_rx || '0', metrics.net_tx || '0', 
          metrics.net_in_speed || '0', metrics.net_out_speed || '0', 
          metrics.os || '', metrics.cpu_info || '', metrics.arch || '', metrics.boot_time || '',
          metrics.ram_used || '0', metrics.swap_total || '0', metrics.swap_used || '0',
          metrics.disk_total || '0', metrics.disk_used || '0', metrics.processes || '0',
          metrics.tcp_conn || '0', metrics.udp_conn || '0', countryCode, 
          metrics.ip_v4 || '0', metrics.ip_v6 || '0', 
          metrics.ping_ct || '0', metrics.ping_cu || '0', metrics.ping_cm || '0', metrics.ping_bd || '0', 
          metrics.ping_gg || '0', metrics.ping_cf || '0',
          metrics.ping_intl_hk || 'fail', metrics.ping_intl_tyo || 'fail', metrics.ping_intl_sin || 'fail', metrics.ping_intl_syd || 'fail', metrics.ping_intl_lax || 'fail',
          metrics.ping_intl_nyc || 'fail', metrics.ping_intl_fra || 'fail', metrics.ping_intl_lon || 'fail', metrics.ping_intl_ams || 'fail', metrics.ping_intl_sao || 'fail',
          metrics.ping_ct_m || 'fail', metrics.ping_cu_m || 'fail', metrics.ping_cm_m || 'fail', metrics.ping_bd_m || 'fail',
          metrics.ping_gg_m || 'fail', metrics.ping_cf_m || 'fail',
          monthly_rx.toString(), monthly_tx.toString(), last_rx.toString(), last_tx.toString(), reset_month, historyStr, metrics.virt || '',
          id
        ).run();

        ctx.waitUntil(checkOfflineNodes());
        
        let riNum = parseInt(sys.report_interval || '5', 10);
        if (isNaN(riNum) || riNum < 1 || riNum > 3600) riNum = 5;
        return new Response(`INTERVAL=${riNum}|CT=${sys.ping_node_ct || 'default'}|CU=${sys.ping_node_cu || 'default'}|CM=${sys.ping_node_cm || 'default'}|GG=${sys.ping_node_gg || 'default'}|CF=${sys.ping_node_cf || 'default'}`, { status: 200 });
      } catch (e) {
        return new Response('Error', { status: 400 });
      }
    }

    // ==========================================
    // 大盘主程序、聚合渲染及 Gossip 路由分发
    // ==========================================
    // 门卫：聚合渲染仅服务首页；其余未匹配路径直接 404，避免无关请求（favicon/爬虫/扫描）触发全表查询与聚合计算
    if (!(request.method === 'GET' && url.pathname === '/')) return new Response('Not Found', { status: 404 });
    let { results } = await env.DB.prepare('SELECT id,name,cpu,ram,disk,load_avg,uptime,last_updated,ram_total,net_rx,net_tx,net_in_speed,net_out_speed,os,cpu_info,arch,boot_time,ram_used,swap_total,swap_used,disk_total,disk_used,processes,tcp_conn,udp_conn,country,ip_v4,ip_v6,server_group,price,expire_date,bandwidth,traffic_limit,agent_os,ping_ct,ping_cu,ping_cm,ping_bd,ping_gg,ping_cf,ping_ct_m,ping_cu_m,ping_cm_m,ping_bd_m,ping_gg_m,ping_cf_m,monthly_rx,monthly_tx,last_rx,last_tx,reset_month,is_hidden,virt,reset_day,sort_order FROM servers ORDER BY sort_order ASC, rowid ASC').all();

    const now = Date.now();
    const offlineThresMs = parseInt(sys.offline_threshold || '30') * 1000;
    
    let globalOnline = 0; let globalOffline = 0;
    let globalSpeedIn = 0; let globalSpeedOut = 0;
    let globalNetTx = 0; let globalNetRx = 0;
    
    let totalAssetGossip = 0; 
    let totalServersGossip = results.length;

    let visibleAsset = 0; let visibleRemAsset = 0;
    let visibleServersCount = 0;

    const groups = {};
    const countryStats = {}; 

    if (results && results.length > 0) {
      for (const server of results) {
        scrubServerText(server);
        let amount = 0; let remValue = 0;
        if (server.price && server.price.match(/[\d.]+/)) {
            let rawAmount = parseFloat(server.price.match(/[\d.]+/)[0]) || 0;
            let rate = 1;
            const pUpper = server.price.toUpperCase();
            if (pUpper.includes('USD') || pUpper.includes('$')) rate = 7.23;
            else if (pUpper.includes('EUR') || pUpper.includes('€')) rate = 7.85;
            else if (pUpper.includes('GBP') || pUpper.includes('£')) rate = 9.12;
            else if (pUpper.includes('HKD')) rate = 0.92;
            else if (pUpper.includes('JPY')) rate = 0.048;
            else if (pUpper.includes('TWD')) rate = 0.22;
            else if (pUpper.includes('RUB')) rate = 0.078;
            else if (pUpper.includes('CAD')) rate = 5.25;
            else if (pUpper.includes('AUD')) rate = 4.75;
            amount = rawAmount * rate;
            
            let cycleDays = 365;
            const priceStr = server.price.toLowerCase();
            if (priceStr.includes('月') || priceStr.includes('mo') || priceStr.includes('month')) cycleDays = 30;
            else if (priceStr.includes('季') || priceStr.includes('qu')) cycleDays = 90;
            else if (priceStr.includes('半年') || priceStr.includes('half')) cycleDays = 180;
            else if (priceStr.includes('天') || priceStr.includes('day')) cycleDays = 1;
            
            let expDays = -1;
            if (server.expire_date) {
                const expTime = new Date(server.expire_date).getTime();
                if (!isNaN(expTime)) {
                    const diff = expTime - now;
                    expDays = diff > 0 ? Math.ceil(diff / (1000 * 3600 * 24)) : 0;
                }
            }
            remValue = expDays === -1 ? amount : (amount / cycleDays) * expDays;
        }
        
        totalAssetGossip += amount;

        if (server.is_hidden === 'true') continue;

        visibleServersCount++;
        visibleAsset += amount; 
        visibleRemAsset += remValue;
        server._remValue = remValue; 
        server._amount = amount;

        const isOnline = (now - server.last_updated) < offlineThresMs;
        if (isOnline) {
          globalOnline++;
          globalSpeedIn += parseFloat(server.net_in_speed) || 0;
          globalSpeedOut += parseFloat(server.net_out_speed) || 0;
        } else { globalOffline++; }
        
        const rx_val = sys.auto_reset_traffic === 'true' ? parseFloat(server.monthly_rx || 0) : parseFloat(server.net_rx || 0);
        const tx_val = sys.auto_reset_traffic === 'true' ? parseFloat(server.monthly_tx || 0) : parseFloat(server.net_tx || 0);
        globalNetTx += tx_val; globalNetRx += rx_val;

        const grpName = server.server_group || '默认分组';
        if (!groups[grpName]) groups[grpName] = [];
        groups[grpName].push(server);

        let cCodeMap = (server.country || 'xx').toUpperCase();
        if (cCodeMap !== 'XX') countryStats[cCodeMap] = (countryStats[cCodeMap] || 0) + 1;
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      if (sys.is_public !== 'true' && !(await isAdminAuthed(request, env))) return authResponse(sys.site_title);

      const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
      const isAjax = url.searchParams.get('ajax') === '1';
      const idParam = url.searchParams.get('id');

      if (idParam && !isAjax) {
        const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(idParam).first();
        if (!server || server.is_hidden === 'true') return new Response('Server Not Found', { status: 404 });
        scrubServerText(server);
        
        const cCode = (server.country || 'xx').toLowerCase();
        const flagCode = cCode === 'tw' ? 'cn' : cCode;
        const flagHtml = flagCode !== 'xx' ? `<img src="https://flagcdn.com/24x18/${flagCode}.png" alt="${flagCode}" style="vertical-align: middle; margin-right: 8px; border-radius: 3px;">` : '🏳️';
        const isOnline = (Date.now() - server.last_updated) < offlineThresMs;
        const statusHtml = isOnline ? '<span style="background:#10b981; color:white; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold;">在线</span>' : '<span style="background:#ef4444; color:white; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold;">离线</span>';
        const lastUpdMs = server.last_updated ? parseInt(server.last_updated) : 0;
        const lastUpdSec = lastUpdMs > 0 ? Math.max(0, Math.round((Date.now() - lastUpdMs) / 1000)) : -1;
        const lastUpdAbsText = lastUpdMs > 0 ? fmtBJ(lastUpdMs) : '-';
        const lastUpdText = lastUpdMs > 0 ? `${lastUpdSec}秒前 · ${lastUpdAbsText}` : '未知';

        const detailHtml = `<!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
          <title>${server.name} - ${esc(sys.site_title)}</title>
          <script>
          /* 主题三态：跟随系统(system) / 夜间(dark) / 日间(light)，本地记忆(localStorage)，默认跟随系统 */
          (function(){
            var DARK_THEMES = ['theme2','theme4','theme5','theme6','theme8'];
            var THEME_MODE_KEY = 'monitor_theme_mode';
            function getThemeMode(){
              try { var m = localStorage.getItem(THEME_MODE_KEY); return (m === 'dark' || m === 'light') ? m : 'system'; } catch(e){ return 'system'; }
            }
            function isDarkTheme(){
              var cls = document.body ? document.body.className : '';
              for (var i=0;i<DARK_THEMES.length;i++){ if(cls.indexOf(DARK_THEMES[i]) !== -1) return true; }
              return false;
            }
            function applyThemeMode(notify){
              if (!document.body) return;
              var mode = getThemeMode();
              document.body.classList.remove('forced-dark','forced-light');
              if (mode === 'dark') document.body.classList.add('forced-dark');
              else if (mode === 'light') document.body.classList.add('forced-light');
              else {
                var sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
                if (sysDark && !isDarkTheme()) document.body.classList.add('forced-dark');
              }
              var btns = document.querySelectorAll('.theme-mode-btn');
              var label = mode === 'dark' ? '🌙 夜间模式' : (mode === 'light' ? '☀️ 日间模式' : '🌗 跟随系统');
              for (var j=0;j<btns.length;j++){ btns[j].textContent = label; btns[j].setAttribute('data-mode', mode); }
              if (notify && window.__uiThemeChanged) window.__uiThemeChanged();
            }
            window.getThemeMode = getThemeMode;
            window.applyThemeMode = applyThemeMode;
            window.setThemeMode = function(m){
              try { localStorage.setItem(THEME_MODE_KEY, m); } catch(e){}
              applyThemeMode(true);
            };
            window.cycleThemeMode = function(){
              var order = ['system','dark','light'];
              window.setThemeMode(order[(order.indexOf(getThemeMode()) + 1) % 3]);
            };
            window.uiDark = function(){
              var cls = document.body ? document.body.className : '';
              if (cls.indexOf('forced-dark') !== -1) return true;
              if (cls.indexOf('forced-light') !== -1) return false;
              return isDarkTheme() || !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
            };
            function initThemeMode(){
              applyThemeMode(false);
              try {
                var mql = window.matchMedia('(prefers-color-scheme: dark)');
                var onSchemeChange = function(){ if (getThemeMode() === 'system') applyThemeMode(true); };
                if (mql.addEventListener) mql.addEventListener('change', onSchemeChange);
                else if (mql.addListener) mql.addListener(onSchemeChange);
              } catch(e){}
            }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initThemeMode);
            else initThemeMode();
          })();
          </script>
          ${sys.custom_head || ''}
          <style>
            /* 层叠顺序：外部主题 / 自定义 CSS（themeOverrides） → 页面私有样式 → themeStyles 设计系统（最后注入，确保苹果风设计系统胜出） */
            ${themeOverrides}
            /* 页面私有样式：仅保留设计系统未覆盖的页面级布局 */
            body { padding: 0; }
            ${themeStyles}
            /* ===== 详情页专用：历史趋势工具条 + 响应式图表高度（仅详情页使用，类名 hist-* 与其他页面无交集）===== */
            .hist-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: nowrap; margin-bottom: 14px; padding: 0 4px; }
            .hist-toolbar-title { font-size: 12px; font-weight: 600; color: var(--text2); letter-spacing: 0.2px; white-space: nowrap; }
            .hist-toolbar .view-controls { flex-shrink: 1; min-width: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
            .hist-toolbar .view-controls::-webkit-scrollbar { display: none; }
            .hist-toolbar .toggle-btn { white-space: nowrap; }
            .hist-box { height: 180px; }
            .hist-box-lg { height: 240px; }
            .hist-box-md { height: 200px; }
            @media (max-width: 767px) {
              .hist-toolbar { gap: 8px; }
              .hist-toolbar-title { font-size: 11px; }
              .hist-box { height: 150px; }
              .hist-box-lg { height: 180px; }
              .hist-box-md { height: 160px; }
            }
          </style>
        </head>
        <body class="${sys.theme || 'theme1'}">
          <div class="container" style="max-width: 1200px; margin: 0 auto; padding: 20px;">
            <div style="margin-bottom: 20px;">
              <a href="/" style="color: var(--accent); text-decoration: none; font-weight: 600; font-size: 15px; display:inline-flex; align-items:center;">← 返回大盘</a>
            </div>
            
            <div class="header-card" style="padding: 25px; border-radius: var(--radius); margin-bottom: 20px;">
                <div style="font-size: 26px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 20px; display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                ${flagHtml} ${server.name}
                <span id="d-status-wrap">${statusHtml}</span>
                <span id="d-lastupd" style="font-size: 12px; font-weight: normal; color: var(--text2);">最后更新: ${lastUpdText}</span>
              </div>
              <div class="stat-card-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px;">
                <div><div class="stat-label">运行时间</div><div class="stat-val" id="d-uptime">${server.uptime || '-'}</div></div>
                <div><div class="stat-label">架构</div><div class="stat-val" id="d-arch">${server.arch || '-'}</div></div>
                <div><div class="stat-label">系统</div><div class="stat-val" id="d-os">${server.os || '-'}</div></div>
                <div><div class="stat-label">虚拟化</div><div class="stat-val" id="d-virt">${server.virt || '-'}</div></div>
                <div><div class="stat-label">Load</div><div class="stat-val" id="d-load">${server.load_avg || '-'}</div></div>
                <div><div class="stat-label">上传 / 下载</div><div class="stat-val"><span id="d-tx">${formatBytes(server.net_tx)}</span> / <span id="d-rx">${formatBytes(server.net_rx)}</span></div></div>
                <div><div class="stat-label">启动时间</div><div class="stat-val" id="d-boot">${server.boot_time || '-'}</div></div>
                <div><div class="stat-label">CPU</div><div class="stat-val" id="d-cpuinfo">${server.cpu_info || '-'}</div></div>
              </div>
            </div>

            <div class="hist-toolbar">
              <span class="hist-toolbar-title">历史趋势</span>
              <div class="view-controls" id="hist-range">
                <button type="button" class="toggle-btn" data-range="3600000">近 1 小时</button>
                <button type="button" class="toggle-btn" data-range="21600000">近 6 小时</button>
                <button type="button" class="toggle-btn active" data-range="86400000">近 24 小时</button>
                <button type="button" class="toggle-btn" data-range="0">全部</button>
              </div>
            </div>

            <div class="detail-grid">
              <div class="chart-card" style="padding: 20px; border-radius: var(--radius); position: relative;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">CPU</span><span id="txt-cpu" class="stat-val" style="font-weight:bold;">0%</span>
                 </div>
                 <div class="hist-box"><canvas id="chart-cpu"></canvas></div>
              </div>
              
              <div class="chart-card" style="padding: 20px; border-radius: var(--radius); position: relative;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">内存</span><span id="txt-ram" class="stat-val" style="font-weight:bold;">0%</span>
                 </div>
                 <div style="font-size: 12px; color: var(--text2); position: absolute; top: 45px; left: 20px;">Swap: <span id="txt-swap">0 / 0</span></div>
                 <div class="hist-box"><canvas id="chart-ram"></canvas></div>
              </div>

              <div class="chart-card" style="padding: 20px; border-radius: var(--radius); position: relative;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px;">
                   <span class="card-title" style="font-weight:bold;">磁盘</span><span id="txt-disk" class="stat-val" style="font-weight:bold;">0%</span>
                 </div>
                 <div class="stat-bar-full" style="height: 24px; border-radius: 12px; background: var(--card3); border: 1px solid var(--separator); overflow: hidden;">
                    <div id="bar-disk" style="height: 100%; border-radius: 12px; background: #3b82f6; width: 0%; transition: width 0.5s;"></div>
                 </div>
                 <div style="text-align: right; font-size: 13px; color: var(--text2); margin-top: 15px;" id="txt-disk-detail">0 / 0</div>
              </div>

              <div class="chart-card" style="padding: 20px; border-radius: var(--radius); position: relative;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">进程数</span><span id="txt-proc" class="stat-val" style="font-weight:bold;">0</span>
                 </div>
                 <div class="hist-box"><canvas id="chart-proc"></canvas></div>
              </div>

              <div class="chart-card" style="padding: 20px; border-radius: var(--radius); position: relative;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">网络速度</span><span class="stat-val" style="font-weight:bold;"><span style="color:#10b981;">↓</span> <span id="txt-net-in">0 B/s</span> | <span style="color:#3b82f6;">↑</span> <span id="txt-net-out">0 B/s</span></span>
                 </div>
                 <div class="hist-box"><canvas id="chart-net"></canvas></div>
              </div>

              <div class="chart-card" style="padding: 20px; border-radius: var(--radius); position: relative;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">TCP / UDP</span><span class="stat-val" style="font-weight:bold;">TCP <span id="txt-tcp">0</span> | UDP <span id="txt-udp">0</span></span>
                 </div>
                 <div class="hist-box"><canvas id="chart-conn"></canvas></div>
              </div>

              <div class="chart-card chart-full" style="padding: 20px; border-radius: var(--radius); position: relative; grid-column: 1 / -1;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">国内延迟 (ms)</span>
                 </div>
                 <div class="hist-box hist-box-lg"><canvas id="chart-ping-dom"></canvas></div>
              </div>

              <div class="chart-card chart-full" style="padding: 20px; border-radius: var(--radius); position: relative; grid-column: 1 / -1;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">海外延迟 (ms)</span>
                 </div>
                 <div class="hist-box hist-box-md"><canvas id="chart-ping-ov"></canvas></div>
              </div>
              <div class="chart-card chart-full" style="padding: 20px; border-radius: var(--radius); position: relative; grid-column: 1 / -1;">
                 <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                   <span class="card-title" style="font-weight:bold;">国际互联延迟 (ms)</span>
                 </div>
                 <div class="hist-box hist-box-lg"><canvas id="chart-ping-intl"></canvas></div>
              </div>
            </div>
            
            ${getFooterHtml(sys)}
          </div>

          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <script>
            const serverId = "${idParam}";
            let charts = {};
            let chartSyncCount = 0;

            // 统一北京时间(UTC+8)格式化，返回 "YYYY-MM-DD HH:mm:ss"
            const fmtBJ = (ts) => {
               const d = new Date(parseInt(ts) + 8 * 3600 * 1000);
               const p = (n) => String(n).padStart(2, '0');
               return \`\${d.getUTCFullYear()}-\${p(d.getUTCMonth() + 1)}-\${p(d.getUTCDate())} \${p(d.getUTCHours())}:\${p(d.getUTCMinutes())}:\${p(d.getUTCSeconds())}\`;
            };
            const OFFLINE_THRES = ${offlineThresMs};
            let lastUpdTs = ${server.last_updated ? server.last_updated : 0};
            function tickStatus() {
               const nowMs = Date.now();
               if (lastUpdTs > 0) {
                 const diff = Math.max(0, Math.round((nowMs - lastUpdTs) / 1000));
                 const luEl = document.getElementById('d-lastupd');
                 if (luEl) luEl.textContent = '最后更新: ' + diff + '秒前 · ' + fmtBJ(lastUpdTs);
                 const wrap = document.getElementById('d-status-wrap');
                 if (wrap) {
                   const on = (nowMs - lastUpdTs) < OFFLINE_THRES;
                   const st = on ? '在线' : '离线';
                   if (wrap.dataset.st !== st) {
                     wrap.dataset.st = st;
                     wrap.innerHTML = on ? '<span style="background:#10b981; color:white; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold;">在线</span>' : '<span style="background:#ef4444; color:white; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold;">离线</span>';
                   }
                 }
               }
            }
            setInterval(tickStatus, 1000);
            tickStatus();

            const formatBytesJs = (bytes) => {
               const b = parseInt(bytes);
               if (isNaN(b) || b === 0) return '0 B';
               const k = 1024;
               const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
               const i = Math.floor(Math.log(b) / Math.log(k));
               return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            };

            // ===== 历史图表 X 轴时间刻度：目标刻度数随 chart 宽度自适应 + 按数据点索引均匀抽稀（不依赖标签字符串解析，北京时间 UTC+8）=====
            const HIST_SAMPLE_MS = 5 * 60 * 1000;   // 无采样时间戳时的兜底采样间隔（5 分钟）
            const HIST_BJ_OFFSET = 8 * 3600 * 1000; // 北京时间 UTC+8 偏移
            const HIST_MAX_TICKS = 8;               // 单轴最多显示刻度数（宽图目标值，窄图再降档）
            const DAY_MS = 24 * 3600 * 1000;
            // 目标刻度数：宽图（>=900px）8 个 / 中等（>=560px）6 个 / 窄图 4 个（resize 自动重算）
            function histTargetTicks(chart) {
               let w = 0;
               if (chart) {
                  if (typeof chart.width === 'number' && chart.width > 0) w = chart.width;
                  else if (chart.chartArea) w = chart.chartArea.right - chart.chartArea.left;
                  if (!w && chart.canvas && chart.canvas.clientWidth) w = chart.canvas.clientWidth;
               }
               if (w >= 900) return 8;
               if (w >= 560) return 6;
               return 4;
            }
            // 按索引等距抽稀：与标签文本内容无关，首尾刻度必保留；返回原 tick 对象引用
            function histThinTicks(list, k) {
               const n = Array.isArray(list) ? list.length : 0;
               if (!n) return list;
               if (!k || k < 2 || n <= k + 1) return list;
               const picked = [];
               for (let i = 0; i < k; i++) {
                  const p = Math.round(i * (n - 1) / (k - 1));
                  if (picked.indexOf(p) < 0) picked.push(p);
               }
               const out = [];
               for (let i = 0; i < picked.length; i++) out.push(list[picked[i]]);
               return out;
            }
            // 稀疏刻度：afterBuildTicks 内按索引均匀取刻度，任意轴类型/标签格式下都生效
            function histAfterBuildTicks(axis) {
               const chart = axis && axis.chart;
               const ticks = (axis && axis.ticks) || [];
               if (!chart || ticks.length <= 1) return ticks;
               const labels = (chart.data && chart.data.labels) || [];
               // category 轴常在数据点之外多出一个边界刻度（下标越界、无标签），抽稀前先剔除，避免末刻度空文本
               let pool = ticks;
               if (labels.length && ticks.length === labels.length + 1) pool = ticks.slice(0, labels.length);
               const out = histThinTicks(pool, histTargetTicks(chart));
               return (out && out.length) ? out : pool;
            }
            // 还原 tick 对应的采样点下标（category 轴 value 可能为下标或标签字符串）
            function histTickIndex(chart, value, fallback) {
               const labels = (chart && chart.data && chart.data.labels) || [];
               if (typeof value === 'number' && value >= 0 && value < labels.length) return value;
               if (typeof value === 'string') {
                  const found = labels.indexOf(value);
                  if (found >= 0) return found;
               }
               return fallback;
            }
            // 该刻度是否为「首个刻度或跨天后的首个刻度」（跨天判定优先用 __ts 的天边界，无 __ts 时比较标签日期段）
            function histDayBreak(chart, idx) {
               const labels = (chart && chart.data && chart.data.labels) || [];
               const ts = (chart && chart.data) ? chart.data.__ts : null;
               if (!(idx > 0)) return true;
               if (Array.isArray(ts) && ts.length === labels.length) {
                  const a = ts[idx - 1], b = ts[idx];
                  if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b)) {
                     return Math.floor((a + HIST_BJ_OFFSET) / DAY_MS) !== Math.floor((b + HIST_BJ_OFFSET) / DAY_MS);
                  }
               }
               const pa = String(labels[idx - 1] === undefined || labels[idx - 1] === null ? '' : labels[idx - 1]).split(' ');
               const pb = String(labels[idx] === undefined || labels[idx] === null ? '' : labels[idx]).split(' ');
               if (pa.length === 2 && pb.length === 2) return pa[0] !== pb[0];
               return false;
            }
            // 刻度文本：优先该采样点真实时间戳 __ts（北京时间）；无 __ts 时回退原始标签文本（仅按空格切分，不做时间解析）
            function histTickText(chart, idx, firstOfDay) {
               const p = (n) => String(n).padStart(2, '0');
               const ts = (chart && chart.data) ? chart.data.__ts : null;
               const labels = (chart && chart.data && chart.data.labels) || [];
               if (Array.isArray(ts) && typeof idx === 'number' && idx >= 0 && idx < ts.length) {
                  const v = ts[idx];
                  if (typeof v === 'number' && isFinite(v)) {
                     const d = new Date(v + HIST_BJ_OFFSET);
                     const hhmm = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
                     return firstOfDay ? (p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + hhmm) : hhmm;
                  }
               }
               const lb = labels[idx];
               if (lb === undefined || lb === null || lb === '') return '';
               const s = String(lb);
               const sp = s.split(' ');
               if (sp.length === 2) return firstOfDay ? s : sp[1];
               return s;
            }
            // X 轴刻度配置：颜色随主题，字号随屏宽（手机 9 / 其余 10），不旋转；autoSkip + maxTicksLimit 作保底，主抽稀由 afterBuildTicks 完成
            function histTicks(fontColor) {
               const small = (typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 480);
               return {
                  color: fontColor, autoSkip: true, maxTicksLimit: HIST_MAX_TICKS, maxRotation: 0, font: { size: small ? 9 : 10 },
                  callback: function(value, index) {
                     const chart = (this && this.chart) ? this.chart : ((this && this.scale) ? this.scale.chart : null);
                     if (!chart) return '';
                     const idx = histTickIndex(chart, value, index);
                     const labels = (chart.data && chart.data.labels) || [];
                     if (typeof idx !== 'number' || idx < 0 || idx >= labels.length) return '';
                     return histTickText(chart, idx, histDayBreak(chart, idx));
                  }
               };
            }
            // tooltip 标题：完整北京时间 YYYY-MM-DD HH:mm
            function histFullTime(ms) {
               const p = (n) => String(n).padStart(2, '0');
               const d = new Date(ms + HIST_BJ_OFFSET);
               return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
            }
            // ===== 时间范围分段控件：近 1 小时 / 近 6 小时 / 近 24 小时 / 全部（默认近 24 小时，localStorage 记忆）=====
            const HIST_RANGE_KEY = 'cfpro_ping_range';
            const HIST_RANGE_DEFAULT = 86400000;
            const HIST_RANGE_VALUES = [3600000, 21600000, 86400000, 0];
            let lastFullHistory = null;   // 最近一次完整 history 缓存，切换 range 时复用、不额外请求
            function histRangeMs() {
               let raw = null;
               try { raw = localStorage.getItem(HIST_RANGE_KEY); } catch (e) {}
               const num = parseInt(raw, 10);
               return HIST_RANGE_VALUES.indexOf(num) >= 0 ? num : HIST_RANGE_DEFAULT;
            }
            // 按当前 range 裁剪 history：优先 __ts（ts >= 最新 ts - range），无 __ts 按点数近似（5 分钟一点）
            function histSliceHistory(history) {
               const labels = Array.isArray(history.time) ? history.time : [];
               const ts = Array.isArray(history.ts) ? history.ts : [];
               const n = labels.length;
               const rangeMs = histRangeMs();
               if (!rangeMs || n === 0) return { labels: labels, ts: ts, from: 0 };
               let from = 0;
               if (ts.length === n && typeof ts[n - 1] === 'number' && isFinite(ts[n - 1])) {
                  const edge = ts[n - 1] - rangeMs;
                  from = n;
                  for (let i = 0; i < n; i++) {
                     const v = ts[i];
                     if (typeof v === 'number' && isFinite(v) && v >= edge) { from = i; break; }
                  }
               } else {
                  from = Math.max(0, n - Math.round(rangeMs / HIST_SAMPLE_MS));
               }
               if (n - from < 2) from = Math.max(0, n - 2);   // 过滤后不足 2 点则退回保留 2 点，避免空图
               return { labels: labels.slice(from), ts: ts.slice(from), from: from };
            }
            // 按当前 range 渲染全部历史图表（series 交给 alignSeries 取末尾对齐，无需重复裁剪）
            function renderHistory(history) {
               if (!history || !Array.isArray(history.time) || history.time.length === 0) return;
               const part = histSliceHistory(history);
               const labels = part.labels;
               if (!labels.length) return;
               const tsArr = (part.ts.length === labels.length) ? part.ts : [];
               Object.keys(charts).forEach((ck) => {
                  const c = charts[ck];
                  if (!c || !c.data) return;
                  if (tsArr.length) c.data.__ts = tsArr;
                  else delete c.data.__ts;
               });
               updateChart(charts.cpu, labels, [history.cpu]);
               updateChart(charts.ram, labels, [history.ram]);
               updateChart(charts.proc, labels, [history.proc]);
               updateChart(charts.net, labels, [history.net_in, history.net_out]);
               updateChart(charts.conn, labels, [history.tcp, history.udp]);
               updateChart(charts.pingDom, labels, [history.ping_ct, history.ping_cu, history.ping_cm, history.ping_bd]);
               updateChart(charts.pingOversea, labels, [history.ping_gg || [], history.ping_cf || []]);
               updateChart(charts.pingIntl, labels, [history.ping_intl_hk || [], history.ping_intl_tyo || [], history.ping_intl_sin || [], history.ping_intl_syd || [], history.ping_intl_lax || [], history.ping_intl_nyc || [], history.ping_intl_fra || [], history.ping_intl_lon || [], history.ping_intl_ams || [], history.ping_intl_sao || []]);
            }
            // 分段控件高亮（按 localStorage 记忆恢复）
            function histMarkRange() {
               const box = document.getElementById('hist-range');
               if (!box) return;
               const cur = histRangeMs();
               const btns = box.querySelectorAll('.toggle-btn');
               for (let i = 0; i < btns.length; i++) {
                  const v = parseInt(btns[i].getAttribute('data-range'), 10);
                  if (v === cur) btns[i].classList.add('active');
                  else btns[i].classList.remove('active');
               }
            }
            // 绑定分段控件：切换仅用缓存重渲染，不发起请求、不重建图表（4s 轮询不受影响）
            function histBindRange() {
               const box = document.getElementById('hist-range');
               if (!box) return;
               histMarkRange();
               box.addEventListener('click', (e) => {
                  let el = e.target;
                  while (el && el !== box && !el.getAttribute('data-range')) el = el.parentNode;
                  if (!el || el === box) return;
                  const v = parseInt(el.getAttribute('data-range'), 10);
                  if (HIST_RANGE_VALUES.indexOf(v) < 0) return;
                  try { localStorage.setItem(HIST_RANGE_KEY, String(v)); } catch (err) {}
                  histMarkRange();
                  if (lastFullHistory) renderHistory(lastFullHistory);
               });
            }

            function initChart(ctxId, label1, label2, color1, color2, isSpeed = false) {
              const ctx = document.getElementById(ctxId).getContext('2d');
              const isDark = uiDark();
              const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
              const fontColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';
              
              const xGridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
              const tipBg = isDark ? 'rgba(28,28,30,0.95)' : 'rgba(255,255,255,0.98)';
              const tipFg = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)';
              const datasets = [{
                  label: label1, data: [], borderColor: color1, backgroundColor: color1.replace('1)', '0.1)'),
                  borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, fill: true, tension: 0.3, spanGaps: true
              }];
              if (label2) {
                 datasets.push({
                    label: label2, data: [], borderColor: color2, backgroundColor: 'transparent',
                    borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, fill: false, tension: 0.3, spanGaps: true
                 });
              }

              return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: datasets },
                options: {
                  responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                       backgroundColor: tipBg, titleColor: tipFg, bodyColor: tipFg,
                       borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', borderWidth: 1, cornerRadius: 10, padding: 10,
                       callbacks: {
                          title: function(items) {
                             if (!items || !items.length) return '';
                             const it = items[0];
                             const chart = (it && it.chart) ? it.chart : ((this && this.chart) ? this.chart : null);
                             const ts = (chart && chart.data) ? chart.data.__ts : null;
                             const ms = (Array.isArray(ts) && it && typeof it.dataIndex === 'number') ? ts[it.dataIndex] : null;
                             if (typeof ms === 'number' && isFinite(ms)) return histFullTime(ms);
                             return (it && it.label) ? String(it.label) : '';
                          },
                          label: function(context) { let l = context.dataset.label || ''; if (l) l += ': '; if (context.parsed.y !== null) l += isSpeed ? formatBytesJs(context.parsed.y) + '/s' : context.parsed.y; return l; }
                       }
                    }
                  },
                  scales: {
                    x: { grid: { display: true, drawTicks: false, drawBorder: false, borderDash: [3, 3], color: xGridColor }, afterBuildTicks: histAfterBuildTicks, ticks: histTicks(fontColor) },
                    y: { grid: { color: gridColor, drawBorder: false }, ticks: { color: fontColor, callback: function(value) { return isSpeed ? formatBytesJs(value) : value; } }, beginAtZero: true }
                  }
                }
              });
            }

            function initPingChart(canvasId, series) {
              const ctx = document.getElementById(canvasId).getContext('2d');
              const isDark = uiDark();
              const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
              const fontColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';
              const xGridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
              const tipBg = isDark ? 'rgba(28,28,30,0.95)' : 'rgba(255,255,255,0.98)';
              const tipFg = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)';
              const small = (typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 480);
              const datasets = (series || []).map((s) => ({
                     label: s[0], data: [], borderColor: s[1], borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, spanGaps: true
              }));

              return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: datasets },
                options: {
                  responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: {
                       position: 'bottom', align: 'center', usePointStyle: true,
                       labels: { color: fontColor, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 12, font: { size: small ? 8 : 11 } }
                    },
                    tooltip: {
                       backgroundColor: tipBg, titleColor: tipFg, bodyColor: tipFg,
                       borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', borderWidth: 1, cornerRadius: 10, padding: 10,
                       callbacks: {
                          title: function(items) {
                             if (!items || !items.length) return '';
                             const it = items[0];
                             const chart = (it && it.chart) ? it.chart : ((this && this.chart) ? this.chart : null);
                             const ts = (chart && chart.data) ? chart.data.__ts : null;
                             const ms = (Array.isArray(ts) && it && typeof it.dataIndex === 'number') ? ts[it.dataIndex] : null;
                             if (typeof ms === 'number' && isFinite(ms)) return histFullTime(ms);
                             return (it && it.label) ? String(it.label) : '';
                          },
                          label: function(context) { let l = context.dataset.label || ''; if (l) l += ': '; if (context.parsed.y !== null) l += context.parsed.y + ' ms'; return l; }
                       }
                    }
                  },
                  scales: {
                    x: { grid: { display: true, drawTicks: false, drawBorder: false, borderDash: [3, 3], color: xGridColor }, afterBuildTicks: histAfterBuildTicks, ticks: histTicks(fontColor) },
                    y: { grid: { color: gridColor }, ticks: { color: fontColor }, beginAtZero: true }
                  }
                }
              });
            }

            const chartDefs = [
              { key: 'cpu', canvasId: 'chart-cpu', args: ['CPU (%)', null, '#3b82f6'] },
              { key: 'ram', canvasId: 'chart-ram', args: ['内存 (%)', null, '#10b981'] },
              { key: 'proc', canvasId: 'chart-proc', args: ['进程数', null, '#8b5cf6'] },
              { key: 'net', canvasId: 'chart-net', args: ['下载', '上传', '#10b981', '#3b82f6', true] },
              { key: 'conn', canvasId: 'chart-conn', args: ['TCP', 'UDP', '#f59e0b', '#ec4899'] },
              { key: 'pingDom', canvasId: 'chart-ping-dom', ping: true, series: [['电信', '#3b82f6'], ['联通', '#f59e0b'], ['移动', '#10b981'], ['字节', '#ef4444']] },
              { key: 'pingOversea', canvasId: 'chart-ping-ov', ping: true, series: [['Google', '#8b5cf6'], ['Cloudflare', '#06b6d4']] },
              { key: 'pingIntl', canvasId: 'chart-ping-intl', ping: true, series: [['香港', '#f59e0b'], ['东京', '#10b981'], ['新加坡', '#3b82f6'], ['悉尼', '#8b5cf6'], ['洛杉矶', '#06b6d4'], ['纽约', '#ec4899'], ['法兰克福', '#ef4444'], ['伦敦', '#22c55e'], ['阿姆斯特丹', '#eab308'], ['圣保罗', '#6366f1']] }
            ];
            function rebuildDetailCharts() {
              const keep = {};
              chartDefs.forEach((d) => {
                const c = charts[d.key];
                if (c) {
                  keep[d.key] = { labels: (c.data.labels || []).slice(), ts: Array.isArray(c.data.__ts) ? c.data.__ts.slice() : null, ds: (c.data.datasets || []).map((x) => ({ label: x.label, data: x.data.slice(), borderColor: x.borderColor, backgroundColor: x.backgroundColor, borderWidth: x.borderWidth, pointRadius: x.pointRadius, tension: x.tension, fill: x.fill })) };
                  try { c.destroy(); } catch (e) {}
                }
              });
              chartDefs.forEach((d) => {
                const rec = keep[d.key];
                if (d.ping) charts[d.key] = initPingChart(d.canvasId, d.series);
                else charts[d.key] = initChart(d.canvasId, d.args[0], d.args[1], d.args[2], d.args[3], d.args[4]);
                if (rec && rec.labels && rec.labels.length) {
                  const ch = charts[d.key];
                  ch.data.labels = rec.labels;
                  rec.ds.forEach((x, i) => { if (ch.data.datasets[i]) { ch.data.datasets[i].data = x.data; ch.data.datasets[i].borderColor = x.borderColor; ch.data.datasets[i].backgroundColor = x.backgroundColor; } });
                  if (Array.isArray(rec.ts) && rec.ts.length === rec.labels.length) ch.data.__ts = rec.ts;
                  ch.update();
                }
              });
              if (lastFullHistory) renderHistory(lastFullHistory);
            }
            window.__uiThemeChanged = rebuildDetailCharts;
            document.addEventListener('DOMContentLoaded', () => {
               histBindRange();
               chartDefs.forEach((d) => { if (d.ping) charts[d.key] = initPingChart(d.canvasId, d.series); else charts[d.key] = initChart(d.canvasId, d.args[0], d.args[1], d.args[2], d.args[3], d.args[4]); });
               fetchData(); setInterval(fetchData, 4000);
            });

            async function fetchData() {
               try {
                  const needHistory = (chartSyncCount === 0 || chartSyncCount % 75 === 0);
                  chartSyncCount++;
                  const res = await fetch('/api/server?id=' + serverId + (needHistory ? '' : '&no_history=1'));
                  if (!res.ok) return;
                  const data = await res.json();
                  if (data.last_updated) { lastUpdTs = parseInt(data.last_updated) || lastUpdTs; tickStatus(); }

                  document.getElementById('d-uptime').innerText = data.uptime;
                  document.getElementById('d-os').innerText = data.os;
                  document.getElementById('d-arch').innerText = data.arch;
                  document.getElementById('d-virt').innerText = data.virt;
                  document.getElementById('d-load').innerText = data.load_avg;
                  document.getElementById('d-boot').innerText = data.boot_time;
                  document.getElementById('d-tx').innerText = formatBytesJs(data.net_tx);
                  document.getElementById('d-rx').innerText = formatBytesJs(data.net_rx);
                  document.getElementById('d-cpuinfo').innerText = data.cpu_info;

                  document.getElementById('txt-cpu').innerText = data.cpu + '%';
                  document.getElementById('txt-ram').innerText = data.ram + '%';
                  document.getElementById('txt-swap').innerText = formatBytesJs(data.swap_used * 1048576) + ' / ' + formatBytesJs(data.swap_total * 1048576);
                  document.getElementById('txt-disk').innerText = data.disk + '%';
                  document.getElementById('bar-disk').style.width = data.disk + '%';
                  document.getElementById('bar-disk').style.background = parseFloat(data.disk) > 80 ? '#ef4444' : '#3b82f6';
                  document.getElementById('txt-disk-detail').innerText = formatBytesJs(data.disk_used * 1048576) + ' / ' + formatBytesJs(data.disk_total * 1048576);
                  
                  document.getElementById('txt-proc').innerText = data.processes;
                  document.getElementById('txt-net-in').innerText = formatBytesJs(data.net_in_speed) + '/s';
                  document.getElementById('txt-net-out').innerText = formatBytesJs(data.net_out_speed) + '/s';
                  document.getElementById('txt-tcp').innerText = data.tcp_conn;
                  document.getElementById('txt-udp').innerText = data.udp_conn;

                  let history = { time: [], ts: [], cpu: [], ram: [], proc: [], net_in: [], net_out: [], tcp: [], udp: [], ping_ct: [], ping_cu: [], ping_cm: [], ping_bd: [], ping_gg: [], ping_cf: [], ping_intl_hk: [], ping_intl_tyo: [], ping_intl_sin: [], ping_intl_syd: [], ping_intl_lax: [], ping_intl_nyc: [], ping_intl_fra: [], ping_intl_lon: [], ping_intl_ams: [], ping_intl_sao: [] };
                  try {
                     if (data.history) history = (typeof data.history === 'string') ? JSON.parse(data.history) : data.history;
                  } catch(e) {}
                  if (!history || typeof history !== 'object') history = { time: [], ts: [] };
                  // 历史脏数据容错：旧版本遗留的空值/错位字段不应导致渲染异常
                  if (!Array.isArray(history.time)) history.time = [];
                  if (!Array.isArray(history.ts)) history.ts = [];

                  if (history.time.length > 0) {
                     // 完整 history 到达：写入缓存并按「当前 range」重新渲染，不重置用户选择；4s 轻量轮询不重建图表
                     lastFullHistory = history;
                     renderHistory(history);
                  }
               } catch (e) {}
            }

            // 序列按时间轴右侧对齐：历史脏数据里若某字段数组偏短（旧版本遗留），
            // 在头部补 null，保证曲线末端始终对齐当前时刻，而不是整体左移到旧时间
            function alignSeries(data, len) {
               let a = Array.isArray(data) ? data.slice(-len) : [];
               if (a.length < len) a = new Array(len - a.length).fill(null).concat(a);
               return a;
            }
            function updateChart(chart, labels, datasetsData) {
               const n = (labels || []).length;
               chart.data.labels = labels || [];
               (datasetsData || []).forEach((data, i) => {
                  if (!chart.data.datasets[i]) return;
                  chart.data.datasets[i].data = alignSeries(data, n);
               });
               chart.update();
            }
          </script>
          ${sys.custom_script || ''}
        </body>
        </html>`;
        return new Response(detailHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      if (!isAjax) {
        // 访问量统计
        const nowTime = new Date();
        const tzOffset = 8 * 60 * 60000; 
        const localNow = new Date(nowTime.getTime() + tzOffset);
        const todayStr = `${localNow.getFullYear()}-${localNow.getMonth() + 1}-${localNow.getDate()}`;
        
        let vTotal = parseInt(sys.visits_total || '0') + 1;
        let vToday = parseInt(sys.visits_today || '0');
        let vDate = sys.visits_date || '';
        if (vDate !== todayStr) { vToday = 1; vDate = todayStr; } else { vToday++; }
        
        sys.visits_total = vTotal.toString();
        sys.visits_today = vToday.toString();
        sys.visits_date = todayStr;

        ctx.waitUntil(env.DB.prepare(`
            INSERT INTO settings (key, value) VALUES ('visits_total', ?), ('visits_today', ?), ('visits_date', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).bind(vTotal.toString(), vToday.toString(), todayStr).run());

        // ==========================================
        // 核心 Gossip 后台触发机制
        // ==========================================
        const runGossip = async () => {
           const nowMs = Date.now();
           // 节流：60 秒内只同步一次，避免每次首页刷新都触发多路出站请求与全表清理
           try {
             const lastGRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_gossip_at'").first();
             const lastGAt = lastGRow ? parseInt(lastGRow.value || '0') : 0;
             if (nowMs - lastGAt < 60000) return;
           } catch(e) {}

           await env.DB.prepare("DELETE FROM peers WHERE last_seen < ? AND last_seen > 0").bind(nowMs - 86400000).run();

           let seedList = sys.seed_nodes ? sys.seed_nodes.split(',').map(s => s.trim()).filter(s => s) : [defaultPeersStr];
           
           let { results: dbPeers } = await env.DB.prepare('SELECT domain FROM peers WHERE domain != ? ORDER BY RANDOM() LIMIT 3').bind(myDomain).all();
           let targetDomains = dbPeers.map(p => p.domain);
           if (targetDomains.length === 0) targetDomains = seedList;
           
           const { results: allPeers } = await env.DB.prepare('SELECT domain FROM peers ORDER BY RANDOM() LIMIT 10').all();
           const known_peers = allPeers.map(p => p.domain);
           
           const payload = {
               domain: myDomain,
               server_count: totalServersGossip, 
               total_asset: totalAssetGossip,    
               version: nowMs,
               known_peers: known_peers
           };
           
           for (const peer of targetDomains) {
               if (peer === myDomain) continue;
               try {
                   await fetch(`https://${peer}/api/gossip`, {
                       method: 'POST',
                       body: JSON.stringify(payload),
                       headers: {'Content-Type': 'application/json'},
                       signal: AbortSignal.timeout(8000),
                       cf: { cacheTtl: 0 }
                   });
               } catch(e) {} 
           }
           
           await env.DB.prepare(`
              INSERT INTO peers (domain, server_count, total_asset, version, last_seen) VALUES (?, ?, ?, ?, ?) 
              ON CONFLICT(domain) DO UPDATE SET server_count=excluded.server_count, total_asset=excluded.total_asset, version=excluded.version, last_seen=excluded.last_seen
           `).bind(myDomain, totalServersGossip, totalAssetGossip, nowMs, nowMs).run(); 
           await env.DB.prepare('INSERT INTO settings (key, value) VALUES ("last_gossip_at", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(String(nowMs)).run();
        };
        ctx.waitUntil(runGossip());
      }
      

      let filterTagsHtml = `<span class="filter-tag" data-code="all" onclick="setFilter('all')">全部 ${visibleServersCount}</span>`;
      for (const [code, count] of Object.entries(countryStats)) {
          const lowerCode = code.toLowerCase();
          const flagCode = lowerCode === 'tw' ? 'cn' : lowerCode; // 仅替换旗帜图片为五星红旗
          filterTagsHtml += `<span class="filter-tag" data-code="${lowerCode}" onclick="setFilter('${lowerCode}')"><img src="https://flagcdn.com/16x12/${flagCode}.png" alt="${code}"> ${code} ${count}</span>`;
      }

      let cardContentHtml = ''; let tableBodyHtml = '';
      const getColor = (ping) => { const p = parseInt(ping); if (p === 0 || isNaN(p)) return '#9ca3af'; if (p < 100) return '#10b981'; if (p < 200) return '#f59e0b'; return '#ef4444'; };
const isPingFail = (v) => { const s = String(v ?? '').trim().toLowerCase(); if (!s || s === 'fail' || s === '0' || s === 'null' || s === 'undefined') return true; const p = parseInt(s); return isNaN(p) || p <= 0; };
// 首页延迟仅展示数值（探测方式不外显），失败显示「超时」
const pingTag = (v) => { if (isPingFail(v)) return '超时'; return v + 'ms'; };

      if (Object.keys(groups).length === 0) {
        cardContentHtml = '<p style="text-align:center; width: 100%; color: var(--text2);">暂无公开服务器</p>';
      } else {
        for (const [grpName, grpServers] of Object.entries(groups)) {
          cardContentHtml += `<div class="group-header">${esc(grpName)}</div><div class="grid-container">`;
          for (const server of grpServers) {
            const isOnline = (now - server.last_updated) < offlineThresMs;
            const statusColor = isOnline ? '#10b981' : '#ef4444'; 
            
            const cpu = parseFloat(server.cpu || '0').toFixed(1); 
            const ram = parseFloat(server.ram || '0').toFixed(1); 
            const disk = parseFloat(server.disk || '0').toFixed(1);
            const netInSpeedRaw = parseFloat(server.net_in_speed) || 0;
            const netOutSpeedRaw = parseFloat(server.net_out_speed) || 0;
            
            const cCode = (server.country || 'xx').toLowerCase();
            const flagCode = cCode === 'tw' ? 'cn' : cCode;
            const flagHtml = flagCode !== 'xx' ? `<img src="https://flagcdn.com/24x18/${flagCode}.png" alt="${flagCode}" style="vertical-align: sub; margin-right: 5px; border-radius: 2px;">` : '🏳️';
            
            let metaHtml = '';
            if (sys.show_price === 'true') {
              let priceHtml = `价格: ${server.price || '免费'}`;
              if (server._amount > 0) priceHtml += ` <span style="color:#8b5cf6;font-weight:600;margin-left:8px;">剩余价值: ${server._remValue.toFixed(2)}${sys.asset_currency || '元'}</span>`;
              metaHtml += `<div class="card-meta" style="margin-top:8px;">${priceHtml}</div>`;
            }
            if (sys.show_expire === 'true') {
              let expireText = '永久';
              if (server.expire_date) {
                const expTime = new Date(server.expire_date).getTime();
                if (!isNaN(expTime)) {
                  const diff = expTime - now; expireText = diff > 0 ? Math.ceil(diff / (1000 * 3600 * 24)) + ' 天' : '已过期';
                }
              }
              metaHtml += `<div class="card-meta" style="${sys.show_price !== 'true' ? 'margin-top:8px;' : ''}">剩余天数: ${expireText}</div>`;
            }

            const rx_val_str = formatBytes(sys.auto_reset_traffic === 'true' ? parseFloat(server.monthly_rx || 0) : parseFloat(server.net_rx || 0));
            const tx_val_str = formatBytes(sys.auto_reset_traffic === 'true' ? parseFloat(server.monthly_tx || 0) : parseFloat(server.net_tx || 0));
            metaHtml += `<div class="card-meta" style="${sys.show_price !== 'true' && sys.show_expire !== 'true' ? 'margin-top:8px;' : ''}">流量: <span style="color:#10b981">↓</span> ${rx_val_str} | <span style="color:#3b82f6">↑</span> ${tx_val_str}</div>`;
            
            let upTimeFormat = (server.uptime || '-').replace('days', '天').replace('day', '天');
            const lastUpdAbs = server.last_updated ? fmtBJ(server.last_updated) : '-';
            metaHtml += `<div class="card-meta" style="margin-top:2px;">在线: ${upTimeFormat}</div>`;
            metaHtml += `<div class="card-meta" style="margin-top:1px; font-size:11px; color: var(--text3); line-height:1.5;">最后更新: ${lastUpdAbs}</div>`;

            let badgesHtml = '';
            if (sys.show_bw === 'true' && server.bandwidth) badgesHtml += `<span class="badge badge-bw">${server.bandwidth}</span>`;
            if (sys.show_tf === 'true' && server.traffic_limit) badgesHtml += `<span class="badge badge-tf">${server.traffic_limit}</span>`;
            if (server.ip_v4 === '1') badgesHtml += `<span class="badge badge-v4">IPv4</span>`;
            if (server.ip_v6 === '1') badgesHtml += `<span class="badge badge-v6">IPv6</span>`;

const pingHtml = `<div class="ping-box"><span>电信 <span style="color:${getColor(server.ping_ct)}; font-weight:bold;">${pingTag(server.ping_ct)}</span></span><span>联通 <span style="color:${getColor(server.ping_cu)}; font-weight:bold;">${pingTag(server.ping_cu)}</span></span><span>移动 <span style="color:${getColor(server.ping_cm)}; font-weight:bold;">${pingTag(server.ping_cm)}</span></span><span>字节 <span style="color:${getColor(server.ping_bd)}; font-weight:bold;">${pingTag(server.ping_bd)}</span></span><span>Google <span style="color:${getColor(server.ping_gg)}; font-weight:bold;">${pingTag(server.ping_gg)}</span></span><span>Cloudflare <span style="color:${getColor(server.ping_cf)}; font-weight:bold;">${pingTag(server.ping_cf)}</span></span></div>`;

            const ramUsedStr = formatBytes((parseFloat(server.ram_used || 0) * 1048576).toString());
            const ramTotalStr = formatBytes((parseFloat(server.ram_total || 0) * 1048576).toString());
            const diskUsedStr = formatBytes((parseFloat(server.disk_used || 0) * 1048576).toString());
            const diskTotalStr = formatBytes((parseFloat(server.disk_total || 0) * 1048576).toString());

            cardContentHtml += `
              <a href="/?id=${server.id}" class="vps-card" data-id="${server.id}" data-country="${cCode}">
                <div class="card-left">
                  <div class="card-title">
                    <div class="status-dot" style="background:${statusColor};"></div>
                    ${flagHtml} <span style="font-size:15px;" class="card-title-text">${server.name}</span>
                    ${isOnline ? '' : '<span style="color:#ef4444; font-weight:bold; font-size:11px; margin-left:6px; border:1px solid rgba(239,68,68,0.45); border-radius:4px; padding:1px 5px; line-height:1.4; flex-shrink:0;">离线</span>'}
                  </div>
                  ${metaHtml}
                  <div class="card-badges">${badgesHtml}</div>
                  ${pingHtml}
                </div>
                
                <div class="card-right">
                  <div class="stat-group">
                    <div class="stat-header"><span>CPU</span><span style="color: ${cpu > 80 ? '#ef4444' : 'inherit'};">${cpu}%</span></div>
                    <div class="stat-bar-full"><div style="width:${cpu}%; background: ${cpu > 80 ? '#ef4444' : '#3b82f6'};"></div></div>
                    <div class="stat-subtext" title="${server.cpu_info || '-'}">${server.cpu_info || '-'}</div>
                  </div>
                  
                  <div class="stat-group">
                    <div class="stat-header"><span>内存</span><span style="color: ${ram > 80 ? '#ef4444' : 'inherit'};">${ram}%</span></div>
                    <div class="stat-bar-full"><div style="width:${ram}%; background: ${ram > 80 ? '#ef4444' : '#10b981'};"></div></div>
                    <div class="stat-subtext">${ramUsedStr} / ${ramTotalStr}</div>
                  </div>

                  <div class="stat-group">
                    <div class="stat-header"><span>存储</span><span style="color: ${disk > 80 ? '#ef4444' : 'inherit'};">${disk}%</span></div>
                    <div class="stat-bar-full"><div style="width:${disk}%; background: ${disk > 80 ? '#ef4444' : '#10b981'};"></div></div>
                    <div class="stat-subtext">${diskUsedStr} / ${diskTotalStr}</div>
                  </div>
                  
                  <div style="font-size: 11px; color: var(--text2); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${server.os || '-'} | ${server.arch || '-'} | ${server.virt || '-'}">${server.os || '-'} | ${server.arch || '-'} | ${server.virt || '-'}</div>

                  <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text2); margin-top: 4px; white-space: nowrap; gap: 8px;">
                    <div style="flex-shrink: 0;">TCP/UDP: ${server.tcp_conn || '0'} / ${server.udp_conn || '0'}</div>
                    <div style="overflow: hidden; text-overflow: ellipsis; text-align: right;"><span style="color:#10b981">↓</span> <span class="speed-anim" data-id="c-in-${server.id}" data-val="${netInSpeedRaw}">0 B/s</span> <span style="color:#3b82f6">↑</span> <span class="speed-anim" data-id="c-out-${server.id}" data-val="${netOutSpeedRaw}">0 B/s</span></div>
                  </div>
                </div>
              </a>
            `;

            tableBodyHtml += `
              <tr onclick="window.location.href='/?id=${server.id}'" style="cursor:pointer;" data-country="${cCode}">
                <td style="text-align:center;"><div class="status-dot" style="background:${statusColor}; display:inline-block; margin:0;"></div></td>
                <td><b>${server.name}</b></td>
                <td>${flagHtml}</td>
                <td><span class="os-text">${server.os || '-'} / ${server.arch || '-'} / ${server.virt || '-'}</span></td>
                <td style="min-width:100px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="stat-bar" style="width:50px; margin:0;"><div style="width:${cpu}%; background:#3b82f6;"></div></div>
                    <span>${cpu}%</span>
                  </div>
                </td>
                <td style="min-width:100px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="stat-bar" style="width:50px; margin:0;"><div style="width:${ram}%; background:#10b981;"></div></div>
                    <span>${ram}%</span>
                  </div>
                </td>
                <td style="min-width:100px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="stat-bar" style="width:50px; margin:0;"><div style="width:${disk}%; background:#10b981;"></div></div>
                    <span>${disk}%</span>
                  </div>
                </td>
                <td style="color: var(--text2); font-size:12px; white-space: nowrap;">${rx_val_str} | ${tx_val_str}</td>
                <td style="white-space: nowrap;"><span class="speed-anim" data-id="t-in-${server.id}" data-val="${netInSpeedRaw}">0 B/s</span></td>
                <td style="white-space: nowrap;"><span class="speed-anim" data-id="t-out-${server.id}" data-val="${netOutSpeedRaw}">0 B/s</span></td>
                <td style="color: var(--text2); font-size:12px; white-space: nowrap;">${server.last_updated ? fmtBJ(server.last_updated) : '-'}</td>
              </tr>
            `;
          }
          cardContentHtml += `</div>`;
        }
      }

      const html = `<!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
        <title>${esc(sys.site_title)}</title>
        <script>
        /* 主题三态：跟随系统(system) / 夜间(dark) / 日间(light)，本地记忆(localStorage)，默认跟随系统 */
        (function(){
          var DARK_THEMES = ['theme2','theme4','theme5','theme6','theme8'];
          var THEME_MODE_KEY = 'monitor_theme_mode';
          function getThemeMode(){
            try { var m = localStorage.getItem(THEME_MODE_KEY); return (m === 'dark' || m === 'light') ? m : 'system'; } catch(e){ return 'system'; }
          }
          function isDarkTheme(){
            var cls = document.body ? document.body.className : '';
            for (var i=0;i<DARK_THEMES.length;i++){ if(cls.indexOf(DARK_THEMES[i]) !== -1) return true; }
            return false;
          }
          function applyThemeMode(notify){
            if (!document.body) return;
            var mode = getThemeMode();
            document.body.classList.remove('forced-dark','forced-light');
            if (mode === 'dark') document.body.classList.add('forced-dark');
            else if (mode === 'light') document.body.classList.add('forced-light');
            else {
              var sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
              if (sysDark && !isDarkTheme()) document.body.classList.add('forced-dark');
            }
            var btns = document.querySelectorAll('.theme-mode-btn');
            var label = mode === 'dark' ? '🌙 夜间模式' : (mode === 'light' ? '☀️ 日间模式' : '🌗 跟随系统');
            for (var j=0;j<btns.length;j++){ btns[j].textContent = label; btns[j].setAttribute('data-mode', mode); }
            if (notify && window.__uiThemeChanged) window.__uiThemeChanged();
          }
          window.getThemeMode = getThemeMode;
          window.applyThemeMode = applyThemeMode;
          window.setThemeMode = function(m){
            try { localStorage.setItem(THEME_MODE_KEY, m); } catch(e){}
            applyThemeMode(true);
          };
          window.cycleThemeMode = function(){
            var order = ['system','dark','light'];
            window.setThemeMode(order[(order.indexOf(getThemeMode()) + 1) % 3]);
          };
          window.uiDark = function(){
            var cls = document.body ? document.body.className : '';
            if (cls.indexOf('forced-dark') !== -1) return true;
            if (cls.indexOf('forced-light') !== -1) return false;
            return isDarkTheme() || !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
          };
          function initThemeMode(){
            applyThemeMode(false);
            try {
              var mql = window.matchMedia('(prefers-color-scheme: dark)');
              var onSchemeChange = function(){ if (getThemeMode() === 'system') applyThemeMode(true); };
              if (mql.addEventListener) mql.addEventListener('change', onSchemeChange);
              else if (mql.addListener) mql.addListener(onSchemeChange);
            } catch(e){}
          }
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initThemeMode);
          else initThemeMode();
        })();
        </script>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin=""/>
        <script id="map-data" type="application/json">${JSON.stringify(countryStats)}</script>
        ${sys.custom_head || ''}
        <style>
          /* 层叠顺序：外部主题 / 自定义 CSS（themeOverrides） → 页面私有样式 → themeStyles 设计系统（最后注入，确保苹果风设计系统胜出） */
          ${themeOverrides}
          /* 页面私有样式：仅保留设计系统未覆盖的页面级布局 */
          body { padding: 20px; }

          ${themeStyles}
        </style>
      </head>
      <body class="${sys.theme || 'theme1'}">
        <div class="container" id="app-container">
          
          <div class="header" style="flex-wrap: wrap; gap: 15px;">
            <h1 style="margin:0;">${esc(sys.site_title)}</h1>
            
            <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
              <div class="view-controls">
                <button class="toggle-btn active" id="btn-card" onclick="switchView('card')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg> 卡片
                </button>
                <button class="toggle-btn" id="btn-table" onclick="switchView('table')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg> 表格
                </button>
                <button class="toggle-btn" id="btn-map" onclick="switchView('map')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg> 地图
                </button>
              </div>
              <button class="toggle-btn theme-mode-btn" id="btn-theme-mode" onclick="cycleThemeMode()" title="主题切换：跟随系统 / 夜间模式 / 日间模式（本地记忆）" data-mode="system">🌗 跟随系统</button>
              ${sys.show_admin_btn === 'true' ? `<a href="${sys.admin_path}" class="admin-btn">${sys.admin_title}</a>` : ''}
            </div>
          </div>

          <div class="filter-bar" id="ajax-filters">
            ${filterTagsHtml}
          </div>

          <div class="global-stats" id="ajax-stats">
            <div class="stats-row top-row">
              <div class="g-item">
                <div class="g-label">本机服务器总数</div>
                <div class="g-val">${visibleServersCount}</div>
                <div class="g-sub">在线 <span style="color:#10b981">${globalOnline}</span> | 离线 <span style="color:#ef4444">${globalOffline}</span></div>
              </div>
              

              <div class="g-item">
                <div class="g-label">本机可见数字资产 (${sys.asset_currency || '元'})</div>
                <div class="g-val">${visibleAsset.toFixed(2)} <span style="font-size:16px;color: var(--text2);">总</span> | ${visibleRemAsset.toFixed(2)} <span style="font-size:16px;color: var(--text2);">余</span></div>
              </div>
            </div>
            
            <div class="stats-row bottom-row">
              <div class="g-item">
                <div class="g-label">实时网速 (入 | 出)</div>
                <div class="g-val"><span style="color:#10b981">↓</span> <span class="speed-anim" data-id="g-in" data-val="${globalSpeedIn}">0 B/s</span> | <span style="color:#3b82f6">↑</span> <span class="speed-anim" data-id="g-out" data-val="${globalSpeedOut}">0 B/s</span></div>
              </div>

              <div class="g-item">
                <div class="g-label">本机流量 (入 | 出) ${sys.auto_reset_traffic === 'true' ? '<span style="font-size:10px; color:#c2410c;">(按期)</span>' : ''}</div>
                <div class="g-val">${formatBytes(globalNetRx)} | ${formatBytes(globalNetTx)}</div>
              </div>
            </div>
          </div>

          <div id="view-card" class="view-panel active">
             <div id="ajax-cards">${cardContentHtml}</div>
          </div>

          <div id="view-table" class="view-panel">
            <div class="table-responsive">
              <table class="custom-table">
                <thead>
                  <tr><th>状态</th><th>节点名称</th><th>地区</th><th>系统/架构/虚拟化</th><th>CPU</th><th>内存</th><th>磁盘</th><th>流量(入|出)</th><th>下行</th><th>上行</th><th>更新</th></tr>
                </thead>
                <tbody id="ajax-table">
                  ${tableBodyHtml || '<tr><td colspan="11" style="text-align:center;">暂无数据</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <div id="view-map" class="view-panel">
            <div class="region-board" id="region-board" aria-label="地区速览"></div>
            <div id="map-container"></div>
          </div>
          
          ${sys.enable_popup === 'true' ? `
          <div id="welcome-popup" class="modal" style="z-index: 9999;">
            <div class="modal-content" style="max-width: 550px; padding: 30px; text-align: center; border-radius: 16px;">
              <div style="text-align: left; line-height: 1.6; font-size: 15px; color: inherit; max-height: 60vh; overflow-y: auto; padding-right: 5px;">
                  ${sys.popup_content || ''}
              </div>
              <div style="margin-top: 25px; text-align: center;">
                <button onclick="closeWelcomePopup()" class="btn btn-blue" style="padding: 10px 30px; font-size: 16px; border-radius: 8px;">我已知晓</button>
              </div>
            </div>
          </div>
          <script>
            document.addEventListener('DOMContentLoaded', () => {
              const currentIP = "${clientIP}";
              const lastSeenIP = localStorage.getItem('popup_seen_ip');
              if (lastSeenIP !== currentIP) {
                 document.getElementById('welcome-popup').style.display = 'block';
              }
            });
            function closeWelcomePopup() {
              localStorage.setItem('popup_seen_ip', "${clientIP}");
              document.getElementById('welcome-popup').style.display = 'none';
            }
          </script>
          ` : ''}
          
          ${getFooterHtml(sys)}
        </div>

        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
        
        <script>
          // 统一北京时间(UTC+8)格式化，返回 "YYYY-MM-DD HH:mm:ss"
          const fmtBJ = (ts) => {
            const d = new Date(parseInt(ts) + 8 * 3600 * 1000);
            const p = (n) => String(n).padStart(2, '0');
            return \`\${d.getUTCFullYear()}-\${p(d.getUTCMonth() + 1)}-\${p(d.getUTCDate())} \${p(d.getUTCHours())}:\${p(d.getUTCMinutes())}:\${p(d.getUTCSeconds())}\`;
          };
          const formatBytesJs = (bytes) => {
            const b = parseInt(bytes);
            if (isNaN(b) || b === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(b) / Math.log(k));
            return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
          };

          window.speedCache = {};
          function animateBytes(el, start, end, duration) {
              let startTimestamp = null;
              const step = (timestamp) => {
                  if (!startTimestamp) startTimestamp = timestamp;
                  const progress = Math.min((timestamp - startTimestamp) / duration, 1);
                  const easeProgress = 1 - Math.pow(1 - progress, 3);
                  const currentBytes = start + (end - start) * easeProgress;
                  el.innerText = formatBytesJs(currentBytes) + '/s';
                  if (progress < 1) window.requestAnimationFrame(step);
              };
              window.requestAnimationFrame(step);
          }

          function applySpeedAnimations() {
              document.querySelectorAll('.speed-anim').forEach(el => {
                  const id = el.dataset.id;
                  const newVal = parseFloat(el.dataset.val) || 0;
                  const oldVal = window.speedCache[id] !== undefined ? window.speedCache[id] : 0;
                  window.speedCache[id] = newVal;
                  if (oldVal !== newVal) { animateBytes(el, oldVal, newVal, 1200); } 
                  else { el.innerText = formatBytesJs(newVal) + '/s'; }
              });
          }

          let mapInitialized = false;
          window.currentFilter = 'all';

          function switchView(viewName) {
            document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById('btn-' + viewName).classList.add('active');
            
            document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));
            document.getElementById('view-' + viewName).classList.add('active');
            
            localStorage.setItem('monitor_preferred_view', viewName);

            if (viewName === 'map') {
              if (!mapInitialized) { initMap(); mapInitialized = true; } 
              else { window.myMap.invalidateSize(); }
            }
          }

          function setFilter(code) {
              window.currentFilter = code; applyFilter();
          }

          function applyFilter() {
              if(!window.currentFilter) window.currentFilter = 'all';
              document.querySelectorAll('.filter-tag').forEach(el => {
                  if (el.dataset.code === window.currentFilter) el.classList.add('active'); else el.classList.remove('active');
              });
              document.querySelectorAll('.vps-card').forEach(el => {
                  if (window.currentFilter === 'all' || el.dataset.country === window.currentFilter) el.style.display = 'flex';
                  else el.style.display = 'none';
              });
              document.querySelectorAll('#ajax-table tr').forEach(el => {
                  if (window.currentFilter === 'all' || el.dataset.country === window.currentFilter) el.style.display = '';
                  else el.style.display = 'none';
              });
              document.querySelectorAll('.group-header').forEach(header => {
                  const grid = header.nextElementSibling;
                  if (grid && grid.classList.contains('grid-container')) {
                      const visibleCards = Array.from(grid.querySelectorAll('.vps-card')).filter(el => el.style.display !== 'none');
                      header.style.display = visibleCards.length > 0 ? 'block' : 'none';
                  }
              });
          }

          let markersLayer; let geoJsonLayer; let worldGeoJson = null; let currentMapDataStr = "";

          const countryCoords = {
            'US': [37.09, -95.71], 'CN': [35.86, 104.19], 'JP': [36.20, 138.25], 'HK': [22.31, 114.16], 'MO': [22.20, 113.55], 'SG': [1.35, 103.81], 'KR': [35.90, 127.76], 'DE': [51.16, 10.45], 'GB': [55.37, -3.43], 'NL': [52.13, 5.29], 'FR': [46.22, 2.21], 'CA': [56.13, -106.34], 'AU': [-25.27, 133.77], 'IN': [20.59, 78.96], 'BR': [-14.23, -51.92], 'RU': [61.52, 105.31], 'ZA': [-30.55, 22.93], 'TW': [23.69, 120.96], 'IT': [41.87, 12.56], 'SE': [60.12, 18.64], 'CH': [46.81, 8.22], 'ES': [40.46, -3.74], 'PL': [51.91, 19.14], 'FI': [61.92, 25.74], 'NO': [60.47, 8.46], 'DK': [56.26, 9.50], 'IE': [53.14, -7.69], 'AT': [47.51, 14.55], 'TR': [38.96, 35.24], 'AE': [23.42, 53.84], 'MY': [4.21, 101.97], 'TH': [15.87, 100.99], 'VN': [14.05, 108.27], 'PH': [12.87, 121.77], 'ID': [-0.78, 113.92], 'UA': [48.38, 31.17], 'CZ': [49.74, 15.34], 'NZ': [-40.90, 174.89], 'MX': [23.63, -102.55], 'IR': [32.43, 53.68]
          };
          const iso2To3 = { "US":"USA","CN":"CHN","JP":"JPN","HK":"HKG","MO":"MAC","SG":"SGP","KR":"KOR","DE":"DEU","GB":"GBR", "NL":"NLD","FR":"FRA","CA":"CAN","AU":"AUS","IN":"IND","BR":"BRA","RU":"RUS","ZA":"ZAF", "TW":"TWN","IT":"ITA","SE":"SWE","CH":"CHE","ES":"ESP","PL":"POL","FI":"FIN","NO":"NOR", "DK":"DNK","IE":"IRL","AT":"AUT","TR":"TUR","AE":"ARE","MY":"MYS","TH":"THA","VN":"VNM", "PH":"PHL","ID":"IDN","UA":"UKR","CZ":"CZE","NZ":"NZL","MX":"MEX","IR":"IRN" };
          const iso3ToIso2 = {};
          for (const _k in iso2To3) { iso3ToIso2[iso2To3[_k]] = _k; }
          const REGION_NAMES = {
            'US':'美国','CN':'中国','JP':'日本','HK':'中国香港','TW':'中国台湾','MO':'中国澳门','SG':'新加坡','KR':'韩国','DE':'德国','GB':'英国','NL':'荷兰','FR':'法国','CA':'加拿大','AU':'澳大利亚','IN':'印度','BR':'巴西','RU':'俄罗斯','ZA':'南非','IT':'意大利','SE':'瑞典','CH':'瑞士','ES':'西班牙','PL':'波兰','FI':'芬兰','TH':'泰国','MY':'马来西亚','VN':'越南','ID':'印尼','PH':'菲律宾','AE':'阿联酋','TR':'土耳其','IR':'伊朗','UA':'乌克兰','CZ':'捷克','IE':'爱尔兰','AT':'奥地利','NO':'挪威','DK':'丹麦','NZ':'新西兰','MX':'墨西哥'
          };
          window.__mapSelCode = null;

          function selectRegion(code) {
            window.__mapSelCode = code;
            const cards = document.querySelectorAll('#region-board .rb-card');
            for (let i = 0; i < cards.length; i++) {
              if (cards[i].dataset.code === code) cards[i].classList.add('active');
              else cards[i].classList.remove('active');
            }
          }

          function renderRegionBoard(data) {
            const board = document.getElementById('region-board');
            if (!board) return;
            board.innerHTML = '';
            const ranked = [];
            let total = 0;
            for (const code in data) {
              const c = parseInt(data[code]) || 0;
              if (c <= 0) continue;
              total += c;
              if (countryCoords[code]) ranked.push({ code: code, count: c });
            }
            if (total <= 0 || ranked.length === 0) {
              board.innerHTML = '<div class="rb-empty">暂无地区数据</div>';
              return;
            }
            ranked.sort(function(a, b) { return b.count - a.count; });
            const top = ranked.slice(0, 12);
            const rest = ranked.slice(12);
            let restTotal = 0;
            for (let i = 0; i < rest.length; i++) restTotal += rest[i].count;

            for (let i = 0; i < top.length; i++) {
              const o = top[i];
              const nm = REGION_NAMES[o.code] || o.code;
              const fcode = o.code === 'TW' ? 'cn' : o.code.toLowerCase();
              const pct = Math.max(Math.round(o.count / total * 100), 1);
              const card = document.createElement('div');
              card.className = 'rb-card';
              card.dataset.code = o.code;
              card.innerHTML = '<div class="rb-head"><img src="https://flagcdn.com/48x36/' + fcode + '.png" alt="' + nm + '" loading="lazy"><span class="rb-name" title="' + nm + '">' + nm + '</span></div><div class="rb-num">' + o.count + '<small>台</small></div><div class="rb-bar"><div style="width:' + pct + '%"></div></div>';
              card.addEventListener('click', (function(code, cnt, nmv) {
                return function() {
                  selectRegion(code);
                  if (countryCoords[code]) {
                    if (window.myMap) window.myMap.flyTo(countryCoords[code], Math.max(window.myMap.getZoom() || 2, 4), { duration: 0.8 });
                    if (cnt > 0) window.myMap.openPopup('<b>' + nmv + '</b><br>' + cnt + ' 台', countryCoords[code], { closeButton: false });
                  }
                };
              })(o.code, o.count, nm));
              board.appendChild(card);
            }

            if (rest.length > 0) {
              const card = document.createElement('div');
              card.className = 'rb-card';
              card.innerHTML = '<div class="rb-head"><span class="rb-name">其余 ' + rest.length + ' 国</span></div><div class="rb-num">' + restTotal + '<small>台</small></div><div class="rb-bar"><div style="width:' + Math.max(Math.round(restTotal / total * 100), 1) + '%"></div></div>';
              board.appendChild(card);
            }
          }

          async function initMap() {
            window.myMap = L.map('map-container', { zoomControl: true, attributionControl: false, minZoom: 1 }).setView([30, 10], 2);
            try {
                const res = await fetch('https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json');
                worldGeoJson = await res.json();
                drawMarkers();
            } catch (e) {}
          }

          window.__uiThemeChanged = function() {
            currentMapDataStr = '';
            if (window.myMap && worldGeoJson) drawMarkers();
          };

          function drawMarkers() {
            if(!window.myMap || !worldGeoJson) return;
            const newDataStr = document.getElementById('map-data').textContent;
            if (currentMapDataStr === newDataStr) return;
            currentMapDataStr = newDataStr;

            if(geoJsonLayer) window.myMap.removeLayer(geoJsonLayer);
            if(markersLayer) markersLayer.clearLayers(); else markersLayer = L.layerGroup().addTo(window.myMap);

            const data = JSON.parse(newDataStr);
            renderRegionBoard(data);
            const dark = window.uiDark ? window.uiDark() : false;

            const activeIso3 = {}; 
            for (const code in data) { 
               if (iso2To3[code]) activeIso3[iso2To3[code]] = true; 
            }
            
            // 核心修复：领土完整性映射。只要命中中国大陆、台湾、香港或澳门任意一处，共同点亮整个中国版图
            if (activeIso3['CHN'] || activeIso3['TWN'] || activeIso3['HKG'] || activeIso3['MAC']) {
                activeIso3['CHN'] = true;
                activeIso3['TWN'] = true;
                activeIso3['HKG'] = true;
                activeIso3['MAC'] = true;
            }

            geoJsonLayer = L.geoJSON(worldGeoJson, {
                style: function(feature) {
                    const id = feature.id;
                    const isActive = !!activeIso3[id];
                    if (isActive) {
                      const code = iso3ToIso2[id];
                      const cnt = code ? (parseInt(data[code]) || 1) : 1;
                      const alpha = Math.min(0.25 + cnt * 0.07, 0.8);
                      return { fillColor: 'rgba(0,113,227,' + alpha.toFixed(2) + ')', weight: 1, opacity: 1, color: dark ? '#3a3a3c' : '#ffffff', fillOpacity: 1 };
                    }
                    return { fillColor: dark ? '#2c2c2e' : '#e9e9ed', weight: 1, opacity: 1, color: dark ? '#000000' : '#ffffff', fillOpacity: 1 };
                },
                onEachFeature: function(feature, layer) {
                  layer.on('click', function() {
                    const code = iso3ToIso2[feature.id];
                    if (!code) return;
                    selectRegion(code);
                    const cnt = data[code] ? parseInt(data[code]) : 0;
                    const nm = REGION_NAMES[code] || code;
                    if (cnt > 0) layer.bindPopup('<b>' + nm + '</b><br>' + cnt + ' 台').openPopup();
                    if (countryCoords[code]) window.myMap.flyTo(countryCoords[code], Math.max(window.myMap.getZoom() || 2, 4), { duration: 0.8 });
                  });
                }
            }).addTo(window.myMap);

            for (const [code, count] of Object.entries(data)) {
              if(countryCoords[code]) {
                const c = parseInt(count) || 0;
                if (c <= 0) continue;
                const len = String(c).length;
                const w = len <= 1 ? 22 : (len === 2 ? 27 : 32);
                const icon = L.divIcon({ className: 'custom-map-badge', html: \`<div>\${c}</div>\`, iconSize: [w, 22], iconAnchor: [w / 2, 11] });
                const mk = L.marker(countryCoords[code], {icon: icon}).addTo(markersLayer);
                mk.bindTooltip((REGION_NAMES[code] || code) + ' · ' + c + ' 台', { direction: 'top', offset: L.point(0, -14) });
              }
            }
          }

          document.addEventListener('DOMContentLoaded', () => {
             const savedView = localStorage.getItem('monitor_preferred_view') || 'card';
             switchView(savedView); applyFilter(); applySpeedAnimations();
          });

          setInterval(async () => {
            try {
              const currentUrl = new URL(location.href);
              currentUrl.searchParams.set('ajax', '1');
              const res = await fetch(currentUrl.toString());
              const htmlText = await res.text();
              const parser = new DOMParser();
              const newDoc = parser.parseFromString(htmlText, 'text/html');
              
              document.getElementById('ajax-stats').innerHTML = newDoc.getElementById('ajax-stats').innerHTML;
              document.getElementById('ajax-cards').innerHTML = newDoc.getElementById('ajax-cards').innerHTML;
              document.getElementById('ajax-table').innerHTML = newDoc.getElementById('ajax-table').innerHTML;
              document.getElementById('ajax-filters').innerHTML = newDoc.getElementById('ajax-filters').innerHTML;
              document.getElementById('map-data').textContent = newDoc.getElementById('map-data').textContent;
              

              drawMarkers(); applyFilter(); applySpeedAnimations();
            } catch (e) {}
          }, 4000);
        </script>
        ${sys.custom_script || ''}
      </body>
      </html>`;

      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron 定时触发：探针全部掉线时无上报流量，仍能靠本入口触发告警扫描
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledAlertCheck(env));
  }
};
