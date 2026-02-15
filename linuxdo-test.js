/**
 * Linux.do 访问检测脚本（强验证版，只保留 [LD] 开头）
 * 目标：筛出 “直达论坛” 或 “验证页稳定可渲染(强验证)” 的节点（B：PASS + CF_OK_STRONG）
 *
 * 使用方法示例:
 * timeout=8000&concurrency=10&prefix=[LD] 
 *
 * 可选参数：
 * prefix=[LD]         通过节点前缀（默认 "[LD] "）
 * timeout=8000        单次请求超时(ms，默认 8000)
 * retries=1           网络失败重试次数（默认 1）
 * concurrency=10      并发数（默认 10）
 * clean=1             检测前清理旧前缀（默认 1）
 * debug=0             输出每个节点判定详情（默认 0）
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};

  // ---------- 参数 ----------
  const PREFIX = args.prefix ?? '[LD] ';
  const TIMEOUT = parseInt(args.timeout ?? 8000, 10);
  const RETRIES = parseInt(args.retries ?? 1, 10);
  const CONCURRENCY = parseInt(args.concurrency ?? 10, 10);
  const CLEAN = parseBool(args.clean, true);
  const DEBUG = parseBool(args.debug, false);

  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876, 10);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 3000, 10);
  const PER_PROXY_TIMEOUT = parseInt(args.http_meta_proxy_timeout ?? Math.max(15000, TIMEOUT * 4), 10);

  // 检测目标
  const HOME_URL = args.url ?? 'https://linux.do/';
  const TURNSTILE_API =
    args.turnstile_url ??
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

  const UA =
    args.ua ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const HTML_HEADERS = {
    'User-Agent': UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  const JS_HEADERS = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: HOME_URL,
  };

  if (!Array.isArray(proxies) || proxies.length === 0) return proxies;

  // ---------- 清理旧前缀，避免残留 ----------
  if (CLEAN) {
    for (const p of proxies) {
      if (!p || typeof p.name !== 'string') continue;
      if (p.name.startsWith(PREFIX)) p.name = p.name.slice(PREFIX.length);
    }
  }

  // ---------- 节点转 internal ----------
  const internalProxies = [];
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        for (const key in proxy) if (/^_/i.test(key)) node[key] = proxy[key];
        internalProxies.push({ ...node, _proxies_index: index });
      }
    } catch (e) {}
  });

  if (internalProxies.length === 0) return proxies;

  // ---------- 启动 HTTP Meta ----------
  const metaApiBase = `${META_PROTOCOL}://${META_HOST}:${META_PORT}`;
  const metaTimeoutCalc = META_START_DELAY + internalProxies.length * PER_PROXY_TIMEOUT;

  let metaPid;
  let metaPorts = [];

  try {
    const startRes = await http({
      method: 'post',
      url: `${metaApiBase}/start`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxies: internalProxies, timeout: metaTimeoutCalc }),
    });
    const body = JSON.parse(startRes.body);
    metaPid = body.pid;
    metaPorts = body.ports;
    $.info(`🚀 Linux.do 强验证检测启动 | 节点:${internalProxies.length} | 筛选=B(PASS+CF_OK_STRONG)`);
    await $.wait(META_START_DELAY);
  } catch (e) {
    $.error(`❌ Meta 启动失败: ${e.message}`);
    return proxies;
  }

  // ---------- 并发检测 ----------
  let finished = 0;
  let passed = 0;

  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
      const port = metaPorts[idx];
      const r = await checkWithRetry(proxy, port);

      finished++;

      const originalNode = proxies[proxy._proxies_index];
      if (originalNode) {
        // 写入结果，便于你后续调试/分析
        originalNode._linuxdo = {
          level: r.level,
          status: r.status,
          ms: r.ms,
          detail: r.detail,
        };
      }

      // 只要 PASS 或 CF_OK_STRONG，就加 [LD]
      if (r.level === 'PASS' || r.level === 'CF_OK_STRONG') {
        passed++;
        if (originalNode && !originalNode.name.startsWith(PREFIX)) {
          originalNode.name = `${PREFIX}${originalNode.name}`;
        }
      }

      if (DEBUG) {
        $.info(
          `[${finished}/${internalProxies.length}] ${proxy.name || originalNode?.name || 'Unknown'} -> ` +
            `${r.level} (status=${r.status}, ${r.ms}ms) ${r.detail ? '| ' + r.detail : ''}`
        );
      }

      if (finished % 10 === 0 || finished === internalProxies.length) {
        $.info(`进度: ${finished}/${internalProxies.length} | 通过(加LD): ${passed}`);
      }
    }),
    { concurrency: CONCURRENCY }
  );

  // ---------- 关闭 meta ----------
  try {
    await http({
      method: 'post',
      url: `${metaApiBase}/stop`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: [metaPid] }),
    });
  } catch (e) {}

  $.info(`🏁 检测结束 | 通过(加LD): ${passed}/${internalProxies.length}`);
  return proxies;

  // ================= 核心检测 =================

  async function checkWithRetry(proxy, port) {
    let last;
    for (let i = 0; i <= RETRIES; i++) {
      last = await probeOnce(port);
      if (last.level === 'PASS' || last.level === 'CF_OK_STRONG' || last.level === 'BLOCKED') return last;
      if (i < RETRIES) await $.wait(500);
    }
    return last;
  }

  async function probeOnce(port) {
    // 1) 拉取首页（带少量重定向处理）
    const main = await fetchWithRedirects({
      url: HOME_URL,
      port,
      headers: HTML_HEADERS,
      timeout: TIMEOUT,
      maxRedirects: 2,
    });

    const status = toStatus(main.res);
    const headers = normalizeHeaders(main.res?.headers);
    const html = toBodyText(main.res);

    if (!main.res || status === 0) {
      return { level: 'NET_FAIL', status, ms: main.ms, detail: main.error ? String(main.error.message || main.error) : 'network error' };
    }

    // 2) 直达 Discourse
    if (looksLikeDiscourse(html) && !looksLikeCFChallenge(html)) {
      return { level: 'PASS', status, ms: main.ms, detail: 'direct discourse' };
    }

    // 3) 明确封禁（1020/Access denied）
    if (looksLikeCFBlocked(html)) {
      return { level: 'BLOCKED', status, ms: main.ms, detail: 'cloudflare blocked (e.g. 1020)' };
    }

    // 4) Cloudflare 挑战页：执行“强验证”
    const cfHeader = isCFHeaders(headers);
    const challengeMarkup = looksLikeCFChallenge(html);

    if (challengeMarkup || (cfHeader && status === 503)) {
      // ---- 强验证三项：challenge-platform + turnstile + cdn-cgi/trace 都要 OK ----
      // 4.1 challenge-platform 资源（优先从 HTML 提取路径）
      let platformOK = false;
      let platformInfo = '';

      const challengePath = extractChallengePlatformPath(html);
      if (challengePath) {
        const platformUrl = toAbsoluteUrl(challengePath, HOME_URL);
        const p = await timedRequest({
          method: 'get',
          url: platformUrl,
          timeout: TIMEOUT,
          headers: JS_HEADERS,
          proxy: `http://${META_HOST}:${port}`,
        });
        const st = toStatus(p.res);
        const body = toBodyText(p.res);
        platformOK = isOkResourceStatus(st) && body && body.length > 80;
        platformInfo = `challenge-platform:${st}`;
      } else {
        platformInfo = 'challenge-platform:missing';
      }

      // 4.2 Turnstile API 必须可加载（无论页面是不是显式 turnstile，都统一测一遍，更贴近你截图场景）
      let turnstileOK = false;
      let turnstileInfo = '';
      {
        const t = await timedRequest({
          method: 'get',
          url: TURNSTILE_API,
          timeout: TIMEOUT,
          headers: JS_HEADERS,
          proxy: `http://${META_HOST}:${port}`,
        });
        const st = toStatus(t.res);
        const body = toBodyText(t.res);
        turnstileOK = isOkResourceStatus(st) && body && body.toLowerCase().includes('turnstile');
        turnstileInfo = `turnstile:${st}`;
      }

      // 4.3 /cdn-cgi/trace 作为 CF 基础链路校验
      let traceOK = false;
      let traceInfo = '';
      {
        const tr = await timedRequest({
          method: 'get',
          url: toAbsoluteUrl('/cdn-cgi/trace', HOME_URL),
          timeout: TIMEOUT,
          headers: { ...JS_HEADERS, Accept: 'text/plain,*/*' },
          proxy: `http://${META_HOST}:${port}`,
        });
        const st = toStatus(tr.res);
        const body = toBodyText(tr.res);
        traceOK = isOkResourceStatus(st) && body && body.includes('ip=');
        traceInfo = `trace:${st}`;
      }

      const strongOK = platformOK && turnstileOK && traceOK;
      return {
        level: strongOK ? 'CF_OK_STRONG' : 'CF_FAIL',
        status,
        ms: main.ms,
        detail: `${platformInfo},${turnstileInfo},${traceInfo}`,
      };
    }

    // 5) 403/429 且命中 CF 头、但没有 challenge 特征：多数是 WAF 直接拒绝
    if (cfHeader && (status === 403 || status === 429)) {
      return { level: 'BLOCKED', status, ms: main.ms, detail: `cloudflare ${status} (no challenge markup)` };
    }

    return { level: 'FAIL', status, ms: main.ms, detail: 'not discourse / not strong-cf' };
  }

  // ================= 工具函数 =================

  async function timedRequest(opt) {
    const start = Date.now();
    try {
      const res = await http(opt);
      return { res, ms: Date.now() - start, error: null };
    } catch (e) {
      return { res: null, ms: Date.now() - start, error: e };
    }
  }

  async function fetchWithRedirects({ url, port, headers, timeout, maxRedirects = 2 }) {
    let currentUrl = url;
    let totalMs = 0;
    let last = null;
    const visited = new Set();

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!currentUrl || visited.has(currentUrl)) break;
      visited.add(currentUrl);

      const r = await timedRequest({
        method: 'get',
        url: currentUrl,
        timeout,
        headers,
        autoRedirect: false,
        followRedirect: false,
        proxy: `http://${META_HOST}:${port}`,
      });

      totalMs += r.ms;
      last = { res: r.res, ms: totalMs, error: r.error };

      const st = toStatus(r.res);
      const hdr = normalizeHeaders(r.res?.headers);
      if (isRedirectStatus(st) && hdr.location) {
        currentUrl = toAbsoluteUrl(String(hdr.location), currentUrl);
        continue;
      }
      return last;
    }
    return last || { res: null, ms: totalMs, error: new Error('redirect failed') };
  }

  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase();
    return await $.http[method](opt);
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve) => {
      let index = 0;
      let running = 0;
      function next() {
        while (index < tasks.length && running < concurrency) {
          tasks[index++]()
            .catch(() => {})
            .finally(() => {
              running--;
              if (index >= tasks.length && running === 0) resolve();
              else next();
            });
          running++;
        }
      }
      next();
    });
  }

  function parseBool(v, defaultValue = false) {
    if (v === undefined || v === null) return defaultValue;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
    return defaultValue;
  }

  function toStatus(res) {
    if (!res) return 0;
    return parseInt(res.status || res.statusCode || 0, 10) || 0;
  }

  function toBodyText(res) {
    if (!res) return '';
    const body = res.body ?? res.data ?? '';
    if (typeof body === 'string') return body;
    try {
      return String(body);
    } catch (e) {
      return '';
    }
  }

  function normalizeHeaders(headers) {
    const out = {};
    if (!headers) return out;
    for (const k of Object.keys(headers)) out[String(k).toLowerCase()] = headers[k];
    return out;
  }

  function isCFHeaders(headers) {
    if (!headers) return false;
    const server = String(headers['server'] || '').toLowerCase();
    if (server.includes('cloudflare')) return true;
    if (headers['cf-ray'] || headers['cf-cache-status']) return true;
    return false;
  }

  function looksLikeDiscourse(html) {
    const h = String(html || '').toLowerCase();
    if (!h) return false;
    if (h.includes('data-discourse-setup')) return true;
    if (h.includes('meta name="generator"') && h.includes('discourse')) return true;
    if (h.includes('id="main-outlet"')) return true;
    if (h.includes('discourse-preload')) return true;
    return false;
  }

  function looksLikeCFChallenge(html) {
    const h = String(html || '').toLowerCase();
    if (!h) return false;
    if (h.includes('/cdn-cgi/challenge-platform/')) return true;
    if (h.includes('cf-challenge') || h.includes('cf_chl')) return true;
    if (h.includes('cf-turnstile') || h.includes('challenges.cloudflare.com') || h.includes('turnstile')) return true;
    if (h.includes('checking if the site connection is secure')) return true;
    if (h.includes('verify you are human') || h.includes('验证您是人类')) return true;
    if (h.includes('just a moment') && h.includes('cloudflare')) return true;
    if (h.includes('attention required') && h.includes('cloudflare')) return true;
    return false;
  }

  function looksLikeCFBlocked(html) {
    const h = String(html || '').toLowerCase();
    if (!h) return false;
    if (h.includes('error 1020')) return true;
    if (h.includes('access denied') && h.includes('cloudflare')) return true;
    if (h.includes('you are unable to access this website')) return true;
    return false;
  }

  function extractChallengePlatformPath(html) {
    if (!html) return null;
    const normalized = String(html).replace(/&amp;/g, '&').replace(/\\\//g, '/');
    const full = normalized.match(/https?:\/\/[^"'<>\s]+\/cdn-cgi\/challenge-platform\/[^"'<>\s]+/i);
    if (full) return full[0];
    const m = normalized.match(/\/cdn-cgi\/challenge-platform\/[^"'<>\s]+/i);
    return m ? m[0] : null;
  }

  function toAbsoluteUrl(pathOrUrl, baseUrl) {
    try {
      if (!pathOrUrl) return baseUrl;
      if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
      const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
      return new URL(pathOrUrl, base).toString();
    } catch (e) {
      return baseUrl;
    }
  }

  function isOkResourceStatus(status) {
    return status === 200 || status === 204 || status === 304;
  }

  function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }
}
