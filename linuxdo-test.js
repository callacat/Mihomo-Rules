/**
 * Linux.do 访问检测脚本（宽松版，只保留 [LD] 开头）
 * 目标：筛出“可直接打开 linux.do 首页”或“会进入 Cloudflare 质询页”的节点。
 *
 * 变更点：
 * 1. PASS（直达 Discourse）加 [LD]
 * 2. CF_CHALLENGE（Cloudflare 质询页）默认也加 [LD]
 * 3. BLOCKED（1020 / Access denied / 明确封禁）不加 [LD]
 * 4. 额外使用 cf-mitigated: challenge 头识别 Cloudflare Challenge 页
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
 * allow_challenge=1   是否把 Cloudflare 质询页也算通过（默认 1）
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
  const ALLOW_CHALLENGE = parseBool(args.allow_challenge, true);

  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876, 10);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 3000, 10);
  const PER_PROXY_TIMEOUT = parseInt(
    args.http_meta_proxy_timeout ?? Math.max(15000, TIMEOUT * 4),
    10
  );

  // 检测目标
  const HOME_URL = args.url ?? 'https://linux.do/';
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
    $.info(
      `🚀 Linux.do 宽松检测启动 | 节点:${internalProxies.length} | ${ALLOW_CHALLENGE ? 'PASS/CF_CHALLENGE 加 [LD]' : '仅 PASS 加 [LD]'}`
    );
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
      const r = await checkWithRetry(port);

      finished++;

      const originalNode = proxies[proxy._proxies_index];
      if (originalNode) {
        originalNode._linuxdo = {
          level: r.level,
          status: r.status,
          ms: r.ms,
          detail: r.detail,
        };
      }

      const shouldTag = r.level === 'PASS' || (ALLOW_CHALLENGE && r.level === 'CF_CHALLENGE');
      if (shouldTag) {
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

  async function checkWithRetry(port) {
    let last;
    for (let i = 0; i <= RETRIES; i++) {
      last = await probeOnce(port);
      if (['PASS', 'BLOCKED', 'CF_CHALLENGE'].includes(last.level)) return last;
      if (i < RETRIES) await $.wait(500);
    }
    return last;
  }

  async function probeOnce(port) {
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
      return {
        level: 'NET_FAIL',
        status,
        ms: main.ms,
        detail: main.error ? String(main.error.message || main.error) : 'network error',
      };
    }

    const cfHeader = isCFHeaders(headers);
    const cfMitigated = isCFMitigatedChallenge(headers);
    const challengeMarkup = looksLikeCFChallenge(html);
    const blockedMarkup = looksLikeCFBlocked(html);

    // 1) 真正打开到论坛页面
    if (looksLikeDiscourse(html) && !cfMitigated && !challengeMarkup) {
      return { level: 'PASS', status, ms: main.ms, detail: 'direct discourse' };
    }

    // 2) 明确封禁（1020 / Access denied）
    if (blockedMarkup) {
      return {
        level: 'BLOCKED',
        status,
        ms: main.ms,
        detail: 'cloudflare blocked (e.g. 1020 / access denied)',
      };
    }

    // 3) Cloudflare 官方可识别的 challenge 响应
    if (cfMitigated) {
      return {
        level: 'CF_CHALLENGE',
        status,
        ms: main.ms,
        detail: 'cf-mitigated: challenge',
      };
    }

    // 4) 页面特征命中 challenge
    if (challengeMarkup) {
      return {
        level: 'CF_CHALLENGE',
        status,
        ms: main.ms,
        detail: 'cloudflare challenge page',
      };
    }

    // 5) 403/429/503 且命中 CF 头：通常也是 WAF / challenge / rate limit
    if (cfHeader && [403, 429, 503].includes(status)) {
      return {
        level: 'BLOCKED',
        status,
        ms: main.ms,
        detail: `cloudflare ${status}`,
      };
    }

    return { level: 'FAIL', status, ms: main.ms, detail: 'not discourse' };
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

  function isCFMitigatedChallenge(headers) {
    return String(headers?.['cf-mitigated'] || '').toLowerCase() === 'challenge';
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

  function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }
}
