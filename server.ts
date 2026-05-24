import express from 'express';
import cors from 'cors';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import './src/env.js';
import {
  closeBrowser,
  fetchBySecUid,
  fetchByUniqueId,
  fetchUserInfo,
  getCachedComments,
  getCachedImageUrls,
  getCachedVideoUrl,
  getRuntimeStatus as getPlaywrightRuntimeStatus,
  warmUp,
} from './src/index.js';

process.env.NODE_ENV ||= 'production';

const app = express();
const webRoot = path.join(process.cwd(), 'web');
const indexHtmlPath = path.join(webRoot, 'index.html');
const assetsRoot = path.join(webRoot, 'assets');
const assetManifestPath = path.join(assetsRoot, 'asset-manifest.json');
const assetManifest = readOrBuildAssetManifest(assetManifestPath);
const indexHtmlTemplate = readFileSync(indexHtmlPath, 'utf8');
const PORT = readIntEnv('PORT', 3000, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_ORIGINS = readListEnv('ALLOWED_ORIGINS');
const MAX_LOOKUP_COUNT = readIntEnv('MAX_LOOKUP_COUNT', 15, 1, 30);
const MAX_COMMENT_COUNT = readIntEnv('MAX_COMMENT_COUNT', 20, 1, 20);
const CDN_FETCH_TIMEOUT_MS = readIntEnv('CDN_FETCH_TIMEOUT_MS', 15000, 1000, 60000);
const RATE_LIMIT_BUCKET_MAX = readIntEnv('RATE_LIMIT_BUCKET_MAX', 10000, 100, 1000000);
const LOOKUP_JOB_TTL_MS = readIntEnv('LOOKUP_JOB_TTL_MS', 10 * 60 * 1000, 60_000, 60 * 60 * 1000);

if (readBooleanEnv('TRUST_PROXY', true)) {
  app.set('trust proxy', 1);
}

app.use(cors({
  origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use(requestLogger);
app.use((_req: any, res: any, next: any) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get(['/', '/index.html'], sendIndexHtml);
app.use(express.static(webRoot, { index: false, setHeaders: setStaticCacheHeaders }));

app.get('/healthz', (_req: any, res: any) => {
  res.json({ ok: true, assetVersion: assetManifest.assetVersion, assets: assetManifest, ...getRuntimeStatus() });
});

app.get('/api/status', (_req: any, res: any) => {
  res.json({ ok: true, assetVersion: assetManifest.assetVersion, assets: assetManifest, ...getRuntimeStatus() });
});

// Open-source build keeps this route as a no-op compatibility endpoint. No data is stored.
app.post('/api/events', (_req: any, res: any) => res.status(204).end());

app.post('/api/user-info', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const uniqueId = validateUniqueId(req.body?.uniqueId);
  if (!uniqueId.ok) return res.status(400).json({ error: uniqueId.error });
  try {
    res.json(await fetchUserInfo(uniqueId.value));
  } catch (e: any) {
    respondError(req, res, e, '查询失败，请稍后再试。');
  }
});

app.post('/api/images', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const awemeId = validateAwemeId(req.body?.awemeId);
  if (!awemeId.ok) return res.status(400).json({ error: awemeId.error });
  try {
    res.json({ urls: await getCachedImageUrls(awemeId.value) });
  } catch (e: any) {
    respondError(req, res, e, '图片暂时不可用，请稍后再试。');
  }
});

app.post('/api/comments', rateLimit(commentRateLimitConfig()), async (req: any, res: any) => {
  const awemeId = validateAwemeId(req.body?.awemeId);
  const count = validateCommentCount(req.body?.count);
  if (!awemeId.ok) return res.status(400).json({ error: awemeId.error });
  if (!count.ok) return res.status(400).json({ error: count.error });
  try {
    res.json(await getCachedComments(awemeId.value, count.value));
  } catch (e: any) {
    respondError(req, res, e, '评论暂时不可用，请稍后再试。');
  }
});

app.post('/api/video-url', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const awemeId = validateAwemeId(req.body?.awemeId);
  if (!awemeId.ok) return res.status(400).json({ error: awemeId.error });
  try {
    res.json({ url: await getCachedVideoUrl(awemeId.value, { refresh: req.body?.refresh === true }) });
  } catch (e: any) {
    respondError(req, res, e, '视频暂时不可用，请稍后再试。');
  }
});

app.get('/api/video', rateLimit(videoRateLimitConfig()), async (req: any, res: any) => {
  const awemeId = validateAwemeId(req.query.awemeId);
  if (!awemeId.ok) return res.status(400).json({ error: awemeId.error });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CDN_FETCH_TIMEOUT_MS);
  try {
    const cdnUrl = await getCachedVideoUrl(awemeId.value);
    const range = req.headers.range;
    const videoResp = await fetch(cdnUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        Referer: 'https://m.douyin.com/',
        ...(range ? { Range: range } : {}),
      },
    });
    if (!videoResp.ok || !videoResp.body) return res.status(502).json({ error: 'CDN 请求失败' });
    const headers: Record<string, string> = {
      'Content-Type': videoResp.headers.get('content-type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    const contentLength = videoResp.headers.get('content-length');
    const contentRange = videoResp.headers.get('content-range');
    if (contentLength) headers['Content-Length'] = contentLength;
    if (contentRange) headers['Content-Range'] = contentRange;
    res.writeHead(videoResp.status, headers);
    await pipeline(Readable.fromWeb(videoResp.body as any), res);
  } catch (e: any) {
    if (!res.headersSent) {
      respondError(req, res, e, e?.name === 'AbortError' ? '视频加载超时，请稍后再试。' : '视频暂时不可用，请稍后再试。');
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
  }
});

app.post('/api/lookup-jobs', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const uniqueId = validateUniqueId(req.body?.uniqueId);
  const count = validateCount(req.body?.count);
  if (!uniqueId.ok) return res.status(400).json({ error: uniqueId.error });
  if (!count.ok) return res.status(400).json({ error: count.error });
  res.json(startLookupJob(() => fetchByUniqueId(uniqueId.value, { count: count.value })));
});

app.post('/api/lookup-secuid-jobs', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const secUid = validateSecUid(req.body?.secUid);
  const count = validateCount(req.body?.count);
  if (!secUid.ok) return res.status(400).json({ error: secUid.error });
  if (!count.ok) return res.status(400).json({ error: count.error });
  res.json(startLookupJob(() => fetchBySecUid(secUid.value, {
    count: count.value,
    nickname: normalizeOptionalText(req.body?.nickname, 80),
    avatar: normalizeOptionalUrl(req.body?.avatar),
    signature: normalizeOptionalText(req.body?.signature, 160),
  })));
});

app.get('/api/lookup-jobs/:jobId', rateLimit(lookupStatusRateLimitConfig()), async (req: any, res: any) => {
  const jobId = validateJobId(req.params?.jobId);
  if (!jobId.ok) return res.status(400).json({ error: jobId.error });
  const job = lookupJobs.get(jobId.value);
  if (!job || job.expiresAt <= Date.now()) {
    if (job) lookupJobs.delete(jobId.value);
    return res.status(404).json({ error: '查询任务不存在或已过期' });
  }
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', Expires: '0' });
  res.json(toPublicLookupJob(job));
});

app.post('/api/lookup', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const uniqueId = validateUniqueId(req.body?.uniqueId);
  const count = validateCount(req.body?.count);
  if (!uniqueId.ok) return res.status(400).json({ error: uniqueId.error });
  if (!count.ok) return res.status(400).json({ error: count.error });
  try {
    res.json(await fetchByUniqueId(uniqueId.value, { count: count.value }));
  } catch (e: any) {
    respondError(req, res, e, '查询失败，请稍后再试。');
  }
});

app.post('/api/lookup-secuid', rateLimit(playwrightRateLimitConfig()), async (req: any, res: any) => {
  const secUid = validateSecUid(req.body?.secUid);
  const count = validateCount(req.body?.count);
  if (!secUid.ok) return res.status(400).json({ error: secUid.error });
  if (!count.ok) return res.status(400).json({ error: count.error });
  try {
    res.json(await fetchBySecUid(secUid.value, {
      count: count.value,
      nickname: normalizeOptionalText(req.body?.nickname, 80),
      avatar: normalizeOptionalUrl(req.body?.avatar),
      signature: normalizeOptionalText(req.body?.signature, 160),
    }));
  } catch (e: any) {
    respondError(req, res, e, '查询失败，请稍后再试。');
  }
});

let server: ReturnType<typeof app.listen> | null = null;

startServer().catch((e: any) => {
  console.error(`服务启动失败: ${e?.message || e}`);
  process.exit(1);
});

async function startServer(): Promise<void> {
  server = app.listen(PORT, HOST, () => {
    console.log(`服务已启动: http://${HOST}:${PORT}`);
  });
  if (readBooleanEnv('PLAYWRIGHT_WARMUP', true)) {
    warmUp().catch((error: any) => {
      console.warn(`Playwright 预热失败，服务继续运行: ${error?.message || error}`);
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`收到 ${signal}，正在关闭服务...`);
    server?.close(async () => {
      await closeBrowser();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  });
}

type Valid<T> = { ok: true; value: T } | { ok: false; error: string };
type RateLimitConfig = { windowMs: number; max: number };
type LookupJob = {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: number;
  expiresAt: number;
  result?: unknown;
  error?: string;
};
type AssetManifest = {
  app: string;
  style: string;
  appHash: string;
  styleHash: string;
  assetVersion: string;
};

const uniqueIdPattern = /^[A-Za-z0-9._-]{1,32}$/;
const secUidPattern = /^[A-Za-z0-9._:-]{8,160}$/;
const awemeIdPattern = /^\d{8,32}$/;
const jobIdPattern = /^[0-9a-fA-F-]{16,80}$/;
const lookupJobs = new Map<string, LookupJob>();
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
let lastRateLimitPrune = 0;
let lastJobPrune = 0;

function startLookupJob(task: () => Promise<unknown>) {
  pruneLookupJobs();
  const job: LookupJob = {
    jobId: randomUUID(),
    status: 'queued',
    createdAt: Date.now(),
    expiresAt: Date.now() + LOOKUP_JOB_TTL_MS,
  };
  lookupJobs.set(job.jobId, job);
  queueMicrotask(async () => {
    job.status = 'running';
    try {
      job.result = await task();
      job.status = 'succeeded';
    } catch (error: any) {
      job.error = error?.message || '查询失败';
      job.status = 'failed';
    }
  });
  return toPublicLookupJob(job);
}

function toPublicLookupJob(job: LookupJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    ...(job.status === 'succeeded' ? { result: job.result } : {}),
    ...(job.status === 'failed' ? { error: job.error || '查询失败' } : {}),
  };
}

function pruneLookupJobs(now = Date.now()) {
  if (now - lastJobPrune < 60_000 && lookupJobs.size < 1000) return;
  lastJobPrune = now;
  for (const [jobId, job] of lookupJobs) {
    if (job.expiresAt <= now) lookupJobs.delete(jobId);
  }
}

function getRuntimeStatus() {
  pruneLookupJobs();
  return {
    lookupQueue: {
      mode: 'memory',
      queued: [...lookupJobs.values()].filter((job) => job.status === 'queued').length,
      running: [...lookupJobs.values()].filter((job) => job.status === 'running').length,
      total: lookupJobs.size,
    },
    ...getPlaywrightRuntimeStatus(),
  };
}

function validateUniqueId(value: unknown): Valid<string> {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: '请输入 dy 号' };
  const normalized = value.trim();
  if (!uniqueIdPattern.test(normalized)) return { ok: false, error: 'dy 号格式不正确' };
  return { ok: true, value: normalized };
}

function validateAwemeId(value: unknown): Valid<string> {
  const normalized = typeof value === 'string' ? value.trim() : String(value || '').trim();
  if (!normalized) return { ok: false, error: '缺少 awemeId' };
  if (!awemeIdPattern.test(normalized)) return { ok: false, error: '作品 ID 格式不正确' };
  return { ok: true, value: normalized };
}

function validateSecUid(value: unknown): Valid<string> {
  const normalized = typeof value === 'string' ? value.trim() : String(value || '').trim();
  if (!normalized) return { ok: false, error: '缺少 secUid' };
  if (!secUidPattern.test(normalized)) return { ok: false, error: '用户标识格式不正确' };
  return { ok: true, value: normalized };
}

function validateJobId(value: unknown): Valid<string> {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return { ok: false, error: '缺少 jobId' };
  if (!jobIdPattern.test(normalized)) return { ok: false, error: 'jobId 格式不正确' };
  return { ok: true, value: normalized };
}

function normalizeOptionalText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function normalizeOptionalUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || normalized.length > 500 || !/^https?:\/\//i.test(normalized)) return '';
  return normalized;
}

function validateCount(value: unknown): Valid<number> {
  if (value === undefined || value === null || value === '') return { ok: true, value: MAX_LOOKUP_COUNT };
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_LOOKUP_COUNT) {
    return { ok: false, error: `每次最多查看 ${MAX_LOOKUP_COUNT} 条` };
  }
  return { ok: true, value: count };
}

function validateCommentCount(value: unknown): Valid<number> {
  if (value === undefined || value === null || value === '') return { ok: true, value: 10 };
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COMMENT_COUNT) {
    return { ok: false, error: `每次最多查看 ${MAX_COMMENT_COUNT} 条评论` };
  }
  return { ok: true, value: count };
}

function requestLogger(req: any, res: any, next: any) {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms ip=${req.ip}`);
  });
  next();
}

function rateLimit(config: RateLimitConfig) {
  return (req: any, res: any, next: any) => {
    const key = `${req.ip}:${req.route?.path || req.path}`;
    const now = Date.now();
    pruneRateLimitBuckets(now);
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && rateLimitBuckets.size >= RATE_LIMIT_BUCKET_MAX) {
        pruneRateLimitBuckets(now, true);
        if (rateLimitBuckets.size >= RATE_LIMIT_BUCKET_MAX) {
          res.status(429).json({ error: '请求太频繁，请稍后再试。' });
          return;
        }
      }
      rateLimitBuckets.set(key, { count: 1, resetAt: now + config.windowMs });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > config.max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ error: '请求太频繁，请稍后再试。' });
      return;
    }
    next();
  };
}

function pruneRateLimitBuckets(now: number, force = false) {
  if (!force && now - lastRateLimitPrune < 60_000 && rateLimitBuckets.size < RATE_LIMIT_BUCKET_MAX) return;
  lastRateLimitPrune = now;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}

function setStaticCacheHeaders(res: any, filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath.endsWith('/index.html')) return setHtmlNoStoreHeaders(res);
  if (/\/assets\/(?:app|styles)\.[a-f0-9]{8}\.(?:js|css)$/i.test(normalizedPath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (/(?:\/app\.js|\/styles\.css)$/i.test(normalizedPath)) return res.setHeader('Cache-Control', 'no-cache');
  if (/\.(?:svg|png|jpg|jpeg|webp|ico|woff2?)$/i.test(normalizedPath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

function sendIndexHtml(req: any, res: any) {
  const latestManifest = readOrBuildAssetManifest(assetManifestPath);
  const shareImageHref = buildAbsolutePublicUrl(req, '/share-card.png');
  const indexHtml = indexHtmlTemplate
    .replaceAll('__STYLE_HREF__', latestManifest.style)
    .replaceAll('__APP_HREF__', latestManifest.app)
    .replaceAll('__SHARE_IMAGE_HREF__', escapeHtmlAttr(shareImageHref));
  setHtmlNoStoreHeaders(res);
  res.type('html').send(indexHtml);
}

function buildAbsolutePublicUrl(req: any, pathname: string): string {
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const host = String(req.get('host') || `localhost:${PORT}`).replace(/[\r\n"'<>]/g, '');
  return `${protocol}://${host}${pathname}`;
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function setHtmlNoStoreHeaders(res: any) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
}

function readOrBuildAssetManifest(manifestPath: string): AssetManifest {
  try {
    return readAssetManifest(manifestPath);
  } catch {
    return buildAssetManifest();
  }
}

function readAssetManifest(manifestPath: string): AssetManifest {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<AssetManifest>;
  if (
    isAssetHref(parsed.app, 'app', 'js') &&
    isAssetHref(parsed.style, 'styles', 'css') &&
    isAssetHash(parsed.appHash) &&
    isAssetHash(parsed.styleHash) &&
    parsed.assetVersion === `${parsed.appHash}-${parsed.styleHash}`
  ) {
    return parsed as AssetManifest;
  }
  throw new Error('资源 manifest 格式不正确');
}

function buildAssetManifest(): AssetManifest {
  mkdirSync(assetsRoot, { recursive: true });
  cleanGeneratedAssets();
  const style = buildHashedAsset(path.join(webRoot, 'styles.css'), 'styles', 'css');
  const app = buildHashedAsset(path.join(webRoot, 'app.js'), 'app', 'js');
  const manifest: AssetManifest = {
    app: app.href,
    style: style.href,
    appHash: app.hash,
    styleHash: style.hash,
    assetVersion: `${app.hash}-${style.hash}`,
  };
  writeFileSync(assetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function buildHashedAsset(sourcePath: string, prefix: 'app' | 'styles', extension: 'js' | 'css') {
  const content = readFileSync(sourcePath);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const fileName = `${prefix}.${hash}.${extension}`;
  writeFileSync(path.join(assetsRoot, fileName), content);
  return { href: `/assets/${fileName}`, hash };
}

function cleanGeneratedAssets() {
  if (!existsSync(assetsRoot)) return;
  for (const fileName of readdirSync(assetsRoot)) {
    if (/^(?:app|styles)\.[a-f0-9]{8}\.(?:js|css)$/.test(fileName) || fileName === 'asset-manifest.json') {
      rmSync(path.join(assetsRoot, fileName), { force: true });
    }
  }
}

function isAssetHref(value: unknown, prefix: 'app' | 'styles', extension: 'js' | 'css'): value is string {
  return typeof value === 'string' && new RegExp(`^/assets/${prefix}\\.[a-f0-9]{8}\\.${extension}$`).test(value);
}

function isAssetHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}$/.test(value);
}

function playwrightRateLimitConfig(): RateLimitConfig {
  return { windowMs: readIntEnv('PLAYWRIGHT_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000), max: readIntEnv('PLAYWRIGHT_RATE_LIMIT_MAX', 12, 1, 1000) };
}

function lookupStatusRateLimitConfig(): RateLimitConfig {
  return { windowMs: readIntEnv('LOOKUP_STATUS_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000), max: readIntEnv('LOOKUP_STATUS_RATE_LIMIT_MAX', 120, 1, 5000) };
}

function videoRateLimitConfig(): RateLimitConfig {
  return { windowMs: readIntEnv('VIDEO_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000), max: readIntEnv('VIDEO_RATE_LIMIT_MAX', 60, 1, 5000) };
}

function commentRateLimitConfig(): RateLimitConfig {
  return { windowMs: readIntEnv('COMMENT_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000), max: readIntEnv('COMMENT_RATE_LIMIT_MAX', 20, 1, 1000) };
}

function respondError(req: any, res: any, error: any, fallbackMessage: string) {
  console.error(`${req.method} ${req.originalUrl} failed:`, error);
  const message = String(error?.message || '');
  if (message.includes('未找到 dy 号')) return res.status(404).json({ error: '未找到这个 dy 号' });
  if (message.includes('请求繁忙')) return res.status(429).json({ error: '请求太频繁，请稍后再试。' });
  if (message.includes('未找到视频地址')) return res.status(502).json({ error: '视频地址失效，请稍后再试。' });
  if (error?.name === 'AbortError') return res.status(504).json({ error: fallbackMessage });
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
    return res.status(error.statusCode).json({ error: message || fallbackMessage });
  }
  return res.status(500).json({ error: fallbackMessage });
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function readListEnv(name: string): string[] {
  return (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  return fallback;
}
