async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};
  const cacheStore = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : undefined;

  const PREFIX = args.prefix ?? '[LD] ';
  const TIMEOUT = parseInt(args.timeout ?? 3000, 10);
  const RETRIES = parseInt(args.retries ?? 0, 10);
  const RETRY_DELAY = parseInt(args.retry_delay ?? 250, 10);
  const CONCURRENCY = parseInt(args.concurrency ?? 15, 10);
  const CACHE_ENABLED = parseBool(args.cache, true) && !!cacheStore;
  const DISABLE_FAILED_CACHE = parseBool(args.disable_failed_cache ?? args.ignore_failed_error, false);
  const CLEAN = parseBool(args.clean, true);
  const DEBUG = parseBool(args.debug, false);
  const ALLOW_CHALLENGE = parseBool(args.allow_challenge, true);
  const ALLOW_RATE_LIMITED = parseBool(args.allow_rate_limited, false);

  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876, 10);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 1000, 10);
  const PER_PROXY_TIMEOUT = parseInt(
    args.http_meta_proxy_timeout ?? Math.max(6000, TIMEOUT * (RETRIES + 1) + RETRY_DELAY * RETRIES + 2500),
    10
  );
  const LOG_EVERY = Math.max(20, CONCURRENCY);

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

  if (CLEAN) {
    for (const p of proxies) {
      if (!p || typeof p.name !== 'string') continue;
      if (p.name.startsWith(PREFIX)) p.name = p.name.slice(PREFIX.length);
    }
  }

  const internalProxies = [];
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) node[key] = proxy[key];
        }
        internalProxies.push({ ...node, _proxies_index: index });
      }
    } catch (e) {
      $.info(`节点转换失败: ${proxy?.name || 'Unknown'} | ${e.message || e}`);
    }
  });

  if (internalProxies.length === 0) return proxies;

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
    if (!body.pid || !Array.isArray(body.ports)) throw new Error('Meta 未返回 PID 或 ports');

    metaPid = body.pid;
    metaPorts = body.ports;
    $.info(
      `🚀 Linux.do 检测启动 | 节点:${internalProxies.length} | ${ALLOW_CHALLENGE ? 'PASS/CF_CHALLENGE' : '仅 PASS'}${ALLOW_RATE_LIMITED ? '/RATE_LIMITED' : ''} 加 [LD] | 缓存:${CACHE_ENABLED ? 'on' : 'off'}`
    );
    await $.wait(META_START_DELAY);
  } catch (e) {
    $.error(`❌ Meta 启动失败: ${e.message || e}`);
    return proxies;
  }

  let finished = 0;
  let passed = 0;

  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
      const port = metaPorts[idx];
      const originalNode = proxies[proxy._proxies_index];
      const result = await resolveProbe(proxy, port);

      finished++;

      if (originalNode) {
        originalNode._linuxdo = {
          level: result.level,
          status: result.status,
          ms: result.ms,
          detail: result.detail,
        };
      }

      const shouldTag =
        result.level === 'PASS' ||
        (ALLOW_CHALLENGE && result.level === 'CF_CHALLENGE') ||
        (ALLOW_RATE_LIMITED && result.level === 'RATE_LIMITED');

      if (shouldTag && originalNode) {
        passed++;
        if (!originalNode.name.startsWith(PREFIX)) {
          originalNode.name = `${PREFIX}${originalNode.name}`;
        }
      }

      if (DEBUG) {
        $.info(
          `[${finished}/${internalProxies.length}] ${proxy.name || originalNode?.name || 'Unknown'} -> ${result.level} (status=${result.status}, ${result.ms}ms)${result.detail ? ' | ' + result.detail : ''}`
        );
      }

      if (finished % LOG_EVERY === 0 || finished === internalProxies.length) {
        $.info(`进度: ${finished}/${internalProxies.length} | 通过(加LD): ${passed}`);
      }
    }),
    { concurrency: CONCURRENCY }
  );

  try {
    await http({
      method: 'post',
      url: `${metaApiBase}/stop`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: [metaPid] }),
    });
  } catch (e) {
    $.info(`Meta 关闭失败: ${e.message || e}`);
  }

  $.info(`🏁 检测结束 | 通过(加LD): ${passed}/${internalProxies.length}`);
  return proxies;

  async function resolveProbe(proxy, port) {
    const cacheId = getCacheId(proxy);
    const cached = getCachedResult(cacheId);
    if (cached) return cached;

    const result = await checkWithRetry(port);
    setCachedResult(cacheId, result);
    return result;
  }

  async function checkWithRetry(port) {
    let last = { level: 'FAIL', status: 0, ms: 0, detail: 'unknown' };
    for (let i = 0; i <= RETRIES; i++) {
      last = await probeOnce(port);
      if (['PASS', 'BLOCKED', 'CF_CHALLENGE', 'RATE_LIMITED'].includes(last.level)) return last;
      if (i < RETRIES) await $.wait(RETRY_DELAY);
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
    const rateLimitedMarkup = looksLikeRateLimited(html, headers, status);

    if (blockedMarkup) {
      return {
        level: 'BLOCKED',
        status,
        ms: main.ms,
        detail: 'cloudflare blocked (e.g. 1020 / access denied)',
      };
    }

    if (rateLimitedMarkup) {
      return {
        level: 'RATE_LIMITED',
        status,
        ms: main.ms,
        detail: rateLimitedDetail(headers, status),
      };
    }

    if (cfMitigated) {
      return {
        level: 'CF_CHALLENGE',
        status,
        ms: main.ms,
        detail: 'cf-mitigated: challenge',
      };
    }

    if (challengeMarkup) {
      return {
        level: 'CF_CHALLENGE',
        status,
        ms: main.ms,
        detail: 'cloudflare challenge page',
      };
    }

    if (looksLikeDiscourse(html) && !cfMitigated && !challengeMarkup && !rateLimitedMarkup) {
      return { level: 'PASS', status, ms: main.ms, detail: 'direct discourse' };
    }

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

  function getCacheId(proxy) {
    if (!CACHE_ENABLED) return '';
    const stableProxy = Object.fromEntries(
      Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
    );
    return `linuxdo:availability:${HOME_URL}:${TIMEOUT}:${RETRIES}:${RETRY_DELAY}:${ALLOW_CHALLENGE}:${ALLOW_RATE_LIMITED}:${JSON.stringify(HTML_HEADERS)}:${JSON.stringify(stableProxy)}`;
  }

  function getCachedResult(cacheId) {
    if (!CACHE_ENABLED || !cacheId) return null;
    try {
      const cached = cacheStore.get(cacheId);
      if (!cached || typeof cached.level !== 'string') return null;
      if (cached.level !== 'PASS' && DISABLE_FAILED_CACHE) return null;
      return cached;
    } catch (e) {
      $.info(`缓存读取失败: ${e.message || e}`);
      return null;
    }
  }

  function setCachedResult(cacheId, result) {
    if (!CACHE_ENABLED || !cacheId) return;
    try {
      cacheStore.set(cacheId, {
        level: result.level,
        status: result.status,
        ms: result.ms,
        detail: result.detail,
      });
    } catch (e) {
      $.info(`缓存写入失败: ${e.message || e}`);
    }
  }

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

      const result = await timedRequest({
        method: 'get',
        url: currentUrl,
        timeout,
        headers,
        autoRedirect: false,
        followRedirect: false,
        proxy: `http://${META_HOST}:${port}`,
      });

      totalMs += result.ms;
      last = { res: result.res, ms: totalMs, error: result.error };

      const status = toStatus(result.res);
      const normalizedHeaders = normalizeHeaders(result.res?.headers);
      if (isRedirectStatus(status) && normalizedHeaders.location) {
        currentUrl = toAbsoluteUrl(String(normalizedHeaders.location), currentUrl);
        continue;
      }

      return last;
    }

    return last || { res: null, ms: totalMs, error: new Error('redirect failed') };
  }

  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase();
    if (typeof $.http[method] !== 'function') {
      throw new Error(`$.http.${method} 不存在`);
    }
    return await $.http[method](opt);
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve) => {
      let index = 0;
      let running = 0;

      function next() {
        while (index < tasks.length && running < concurrency) {
          tasks[index++]()
            .catch((e) => {
              $.info(`任务执行失败: ${e.message || e}`);
            })
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
    const server = String(headers.server || '').toLowerCase();
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

  function looksLikeRateLimited(html, headers, status) {
    const h = String(html || '').toLowerCase();
    if (!h) {
      return status === 429 || !!headers?.['retry-after'];
    }

    const titleRateLimited = /<title[^>]*>\s*you are being rate limited\s*<\/title>/.test(h);
    const headingRateLimited = /<h1[^>]*>\s*you are being rate limited\s*<\/h1>/.test(h);
    const bannedText = h.includes('we have banned you temporarily from accessing this website');
    const tryLaterText = h.includes('please try again later');
    const cf1015 = h.includes('error 1015');
    const tooManyRequests = h.includes('too many requests');
    const hasRetryAfter = !!headers?.['retry-after'];

    if (cf1015) return true;
    if ((titleRateLimited || headingRateLimited) && (bannedText || tryLaterText || status === 429 || hasRetryAfter)) return true;
    if (bannedText && (status === 429 || hasRetryAfter || titleRateLimited || headingRateLimited)) return true;
    if (status === 429 && (titleRateLimited || headingRateLimited || bannedText || tooManyRequests)) return true;
    if (hasRetryAfter && (titleRateLimited || headingRateLimited || bannedText)) return true;

    return false;
  }

  function rateLimitedDetail(headers, status) {
    const retryAfter = headers?.['retry-after'];
    if (retryAfter) return `rate limited (status=${status || 0}, retry-after=${retryAfter})`;
    if (status === 429) return 'rate limited (429)';
    return 'rate limited / temporary banned page';
  }

  function toAbsoluteUrl(pathOrUrl, baseUrl) {
    try {
      if (!pathOrUrl) return baseUrl;
      if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return new URL(pathOrUrl, base).toString();
    } catch (e) {
      return baseUrl;
    }
  }

  function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }
}
