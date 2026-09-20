/**
 * CF-Server-Monitor-Pro 定时告警触发器（独立 Worker）
 *
 * 背景：Cloudflare Pages 不支持 Cron Triggers，因此把原本由 Pages/Workers 自身 Cron
 *      触发的告警扫描，改为由本独立 Worker 每分钟调用 Pages 站点的 /api/cron 端点代为触发。
 *
 * 部署：wrangler deploy -c cron/wrangler.toml
 * 必需变量：SITE_URL（Pages 站点地址）、API_SECRET（须与 Pages 端一致，可用 wrangler secret 配置）
 */
const REQUEST_TIMEOUT_MS = 20000;

// 去除 SITE_URL 尾部斜杠，避免拼接出 //api/cron
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// 触发 Pages 端告警扫描；内部捕获全部异常，失败只返回结果对象，绝不抛出
async function triggerAlertScan(env) {
  const base = normalizeBaseUrl(env && env.SITE_URL);
  const startedAt = Date.now();

  if (!base) {
    return { ok: false, status: 0, elapsed_ms: 0, error: 'missing SITE_URL' };
  }

  const target = base + '/api/cron';
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'x-cf-secret': String((env && env.API_SECRET) || '')
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    let body = '';
    try { body = await res.text(); } catch (e) { body = ''; }

    return {
      ok: res.ok,
      status: res.status,
      elapsed_ms: Date.now() - startedAt,
      url: target,
      body: String(body || '').slice(0, 500)
    };
  } catch (e) {
    // 超时、DNS 失败、网络不可达等一律降级为失败结果，不中断 Worker 执行
    return {
      ok: false,
      status: 0,
      elapsed_ms: Date.now() - startedAt,
      url: target,
      error: String((e && e.message) || e)
    };
  }
}

export default {
  // Cron 触发（每分钟）：异步执行，不阻塞调度返回
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerAlertScan(env));
  },

  // 手动测试入口：直接在浏览器/curl 访问本 Worker 域名即可查看本次触发结果 JSON
  async fetch(request, env) {
    const result = await triggerAlertScan(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
};
