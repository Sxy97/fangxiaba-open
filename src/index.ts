import { chromium, Browser, BrowserContext, type Page, type Response } from 'playwright';
import { setupInterceptor } from './interceptor.js';
import type { Aweme, CommentResult, FetchOptions, PostApiResponse, PublicComment, UserInfo, UserResult } from './types.js';

export type { Aweme, CommentResult, FetchOptions, PublicComment, UserInfo, UserResult } from './types.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIDEO_URL_TTL_MS = readIntEnv('VIDEO_URL_TTL_MS', 10 * 60 * 1000, 60_000, 60 * 60 * 1000);
const LOOKUP_CACHE_TTL_MS = readIntEnv('LOOKUP_CACHE_TTL_MS', 5 * 60 * 1000, 0, 30 * 60 * 1000);
const IMAGE_URL_TTL_MS = readIntEnv('IMAGE_URL_TTL_MS', 10 * 60 * 1000, 0, 60 * 60 * 1000);
const COMMENT_CACHE_TTL_MS = readIntEnv('COMMENT_CACHE_TTL_MS', 2 * 60 * 1000, 0, 10 * 60 * 1000);
const NEGATIVE_CACHE_TTL_MS = readIntEnv('NEGATIVE_CACHE_TTL_MS', 20 * 1000, 0, 5 * 60 * 1000);
const PLAYWRIGHT_CONCURRENCY = readIntEnv('PLAYWRIGHT_CONCURRENCY', 2, 1, 8);
const PLAYWRIGHT_QUEUE_TIMEOUT_MS = readIntEnv('PLAYWRIGHT_QUEUE_TIMEOUT_MS', 20 * 1000, 1000, 120_000);
const PLAYWRIGHT_QUEUE_MAX = readIntEnv('PLAYWRIGHT_QUEUE_MAX', 20, 0, 500);
const LOOKUP_FIRST_WAIT_MS = readIntEnv('LOOKUP_FIRST_WAIT_MS', 3500, 1000, 15_000);
const LOOKUP_RETRY_WAIT_MS = readIntEnv('LOOKUP_RETRY_WAIT_MS', 5500, 1000, 15_000);
const LOOKUP_NAVIGATION_TIMEOUT_MS = readIntEnv('LOOKUP_NAVIGATION_TIMEOUT_MS', 8000, 1000, 30_000);
const IMAGE_FIRST_WAIT_MS = readIntEnv('IMAGE_FIRST_WAIT_MS', 2500, 500, 15_000);
const IMAGE_RETRY_WAIT_MS = readIntEnv('IMAGE_RETRY_WAIT_MS', 3500, 500, 15_000);
const IMAGE_NAVIGATION_TIMEOUT_MS = readIntEnv('IMAGE_NAVIGATION_TIMEOUT_MS', 8000, 1000, 30_000);
const PLAYWRIGHT_PROXY_SERVER = process.env.PLAYWRIGHT_PROXY_SERVER?.trim() || '';
const PLAYWRIGHT_PROXY_USERNAME = process.env.PLAYWRIGHT_PROXY_USERNAME?.trim() || '';
const PLAYWRIGHT_PROXY_PASSWORD = process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim() || '';
const LOOKUP_DEBUG = isTruthyEnv(process.env.LOOKUP_DEBUG);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 浏览器实例复用，避免每次请求冷启动
let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedContextPromise: Promise<BrowserContext> | null = null;
let activePlaywrightTasks = 0;
let playwrightWarmedUp = false;
const playwrightQueue: Array<{
  run: () => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}> = [];
const videoUrlCache = new Map<string, { url: string; expiresAt: number }>();
const listVideoUrlCache = new Map<string, { url: string; expiresAt: number }>();
const lookupCache = new Map<string, { result: UserResult; expiresAt: number }>();
const imageUrlCache = new Map<string, { urls: string[]; expiresAt: number }>();
const listImageUrlCache = new Map<string, { urls: string[]; expiresAt: number }>();
const commentCache = new Map<string, { result: CommentResult; expiresAt: number }>();
const negativeCache = new Map<string, { message: string; expiresAt: number }>();
const videoUrlInFlight = new Map<string, Promise<string>>();
const lookupInFlight = new Map<string, Promise<UserResult>>();
const imageUrlInFlight = new Map<string, Promise<string[]>>();
const commentInFlight = new Map<string, Promise<CommentResult>>();

export interface SecUidLookupOptions extends FetchOptions {
  nickname?: string;
  avatar?: string;
  signature?: string;
}

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser?.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
      ...(PLAYWRIGHT_PROXY_SERVER ? {
        proxy: {
          server: PLAYWRIGHT_PROXY_SERVER,
          ...(PLAYWRIGHT_PROXY_USERNAME ? { username: PLAYWRIGHT_PROXY_USERNAME } : {}),
          ...(PLAYWRIGHT_PROXY_PASSWORD ? { password: PLAYWRIGHT_PROXY_PASSWORD } : {}),
        },
      } : {}),
    });
    sharedBrowser.on('disconnected', () => {
      sharedBrowser = null;
      sharedContext = null;
      sharedContextPromise = null;
      playwrightWarmedUp = false;
    });
  }
  return sharedBrowser;
}

// 常驻上下文，保持 cookie 有效
async function getSharedContext(): Promise<BrowserContext> {
  if (sharedContext?.browser()?.isConnected()) return sharedContext;
  sharedContext = null;
  if (sharedContextPromise) return sharedContextPromise;

  sharedContextPromise = initSharedContext().catch((error) => {
    sharedContextPromise = null;
    throw error;
  });

  return sharedContextPromise;
}

async function initSharedContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await createContext(browser);
  context.on('close', () => {
    if (sharedContext === context) sharedContext = null;
    if (sharedContextPromise) sharedContextPromise = null;
  });
  try {
    const page = await context.newPage();
    await page.goto('https://m.douyin.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    await page.close(); // 只保留 cookie，关闭页面
    sharedContext = context;
    sharedContextPromise = null;
    playwrightWarmedUp = true;
    return context;
  } catch (error) {
    playwrightWarmedUp = false;
    await context.close().catch(() => {});
    throw error;
  }
}

/** 获取视频的直接播放地址 */
export async function fetchVideoUrl(awemeId: string): Promise<string> {
  return runPlaywrightTask(async () => {
    const context = await getSharedContext();
    const page = await context.newPage();
    const networkUrls: string[] = [];
    let navigationElapsed = 0;
    let navigationError = '';
    try {
      await blockVideoPageHeavyResources(page);
      page.on('response', (response) => {
        const url = extractVideoUrlFromResponse(response);
        if (url) networkUrls.push(url);
      });

      const navigationStart = Date.now();
      await page.goto(`https://m.douyin.com/share/video/${awemeId}`, {
        waitUntil: 'commit',
        timeout: 10000,
      }).catch((error) => {
        navigationError = error?.message || String(error);
      });
      navigationElapsed = Date.now() - navigationStart;

      const waitStart = Date.now();
      while (Date.now() - waitStart <= 10000) {
        const domUrl = await extractVideoUrlFromDom(page);
        const scriptUrl = domUrl ? '' : await extractVideoUrlFromScripts(page);
        const url = domUrl || scriptUrl || networkUrls[networkUrls.length - 1] || '';
        if (url) return normalizeVideoUrl(url);
        await sleep(250);
      }

      const hasVideoNode = await hasVideoElement(page);
      console.warn(
        `视频地址未找到: aweme=${awemeId} nav=${navigationElapsed}ms hasVideo=${hasVideoNode}` +
          ` networkUrls=${networkUrls.length} page=${page.url()}` +
          (navigationError ? ` navError=${navigationError}` : ''),
      );
      throw new Error('未找到视频地址');
    } finally {
      await page.close();
    }
  });
}

export async function getCachedVideoUrl(awemeId: string, options: { refresh?: boolean } = {}): Promise<string> {
  pruneVideoUrlCache();
  const negativeKey = `videoUrl:${awemeId}:${options.refresh ? 'refresh' : 'normal'}`;

  const cached = videoUrlCache.get(awemeId);
  const listCached = listVideoUrlCache.get(awemeId);
  const now = Date.now();
  if (!options.refresh && cached && cached.expiresAt > now) {
    console.log(`video-url status=cache aweme=${awemeId}`);
    return cached.url;
  }
  if (!options.refresh && listCached && listCached.expiresAt > now) {
    console.log(`video-url status=list-cache aweme=${awemeId}`);
    cacheVideoUrl(awemeId, listCached.url);
    return listCached.url;
  }
  throwIfNegativeCached(negativeKey);

  const inFlightKey = `${awemeId}:${options.refresh ? 'refresh' : 'normal'}`;
  const inFlight = videoUrlInFlight.get(inFlightKey);
  if (inFlight) return inFlight;

  console.log(`video-url status=${options.refresh ? 'refresh' : 'fetch'} aweme=${awemeId}`);
  const promise = fetchVideoUrl(awemeId)
    .catch((error) => {
      cacheNegativeError(negativeKey, error);
      console.warn(`video-url status=failed aweme=${awemeId} refresh=${Boolean(options.refresh)} message=${error?.message || error}`);
      throw error;
    })
    .finally(() => {
      videoUrlInFlight.delete(inFlightKey);
    });
  videoUrlInFlight.set(inFlightKey, promise);

  const url = await promise;
  cacheVideoUrl(awemeId, url);
  return url;
}

export async function getCachedImageUrls(awemeId: string): Promise<string[]> {
  pruneImageUrlCache();
  const negativeKey = `images:${awemeId}`;

  const cached = imageUrlCache.get(awemeId);
  const listCached = listImageUrlCache.get(awemeId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    console.log(`图片缓存命中: ${awemeId}`);
    return [...cached.urls];
  }
  if (listCached && listCached.expiresAt > now) {
    console.log(`图片列表缓存命中: ${awemeId}`);
    cacheImageUrls(awemeId, listCached.urls);
    return [...listCached.urls];
  }
  throwIfNegativeCached(negativeKey);

  const inFlight = imageUrlInFlight.get(awemeId);
  if (inFlight) return [...(await inFlight)];

  const promise = fetchImageUrls(awemeId)
    .catch((error) => {
      cacheNegativeError(negativeKey, error);
      throw error;
    })
    .finally(() => {
      imageUrlInFlight.delete(awemeId);
    });
  imageUrlInFlight.set(awemeId, promise);

  const urls = await promise;
  cacheImageUrls(awemeId, urls);
  return urls;
}

export async function getCachedComments(awemeId: string, count = 10): Promise<CommentResult> {
  pruneCommentCache();
  const normalizedCount = Math.min(20, Math.max(1, Math.floor(Number(count) || 10)));
  const cacheKey = `${awemeId}:${normalizedCount}`;
  const negativeKey = `comments:${cacheKey}`;
  const cached = commentCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    console.log(`评论缓存命中: ${awemeId} | count=${normalizedCount}`);
    return cloneCommentResult(cached.result);
  }
  throwIfNegativeCached(negativeKey);

  const inFlight = commentInFlight.get(cacheKey);
  if (inFlight) return cloneCommentResult(await inFlight);

  const promise = fetchComments(awemeId, normalizedCount)
    .catch((error) => {
      cacheNegativeError(negativeKey, error);
      throw error;
    })
    .finally(() => {
      commentInFlight.delete(cacheKey);
    });
  commentInFlight.set(cacheKey, promise);

  const result = await promise;
  if (COMMENT_CACHE_TTL_MS > 0) {
    commentCache.set(cacheKey, {
      result: cloneCommentResult(result),
      expiresAt: Date.now() + COMMENT_CACHE_TTL_MS,
    });
  }
  return result;
}

export async function fetchComments(awemeId: string, count = 10): Promise<CommentResult> {
  const directStart = Date.now();
  try {
    const result = await fetchCommentsDirect(awemeId, count);
    console.log(`评论阶段: aweme=${awemeId} mode=direct comments=${result.comments.length} total=${Date.now() - directStart}ms`);
    return result;
  } catch (error: any) {
    console.warn(`评论直连失败，回退 Playwright: aweme=${awemeId} message=${error?.message || error}`);
  }

  return runPlaywrightTask(async () => {
    const startTime = Date.now();
    const context = await getSharedContext();
    const page = await context.newPage();
    try {
      await page.goto('https://m.douyin.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      const data = await page.evaluate(async ({ awemeId, count }) => {
        const url = new URL('https://www.iesdouyin.com/web/api/v2/comment/list/');
        url.searchParams.set('aweme_id', awemeId);
        url.searchParams.set('cursor', '0');
        url.searchParams.set('count', String(count));
        const resp = await fetch(url.toString(), { credentials: 'include' });
        if (!resp.ok) throw new Error(`comment api status ${resp.status}`);
        return await resp.json();
      }, { awemeId, count });

      const result = normalizeCommentResult(data);
      result.comments = result.comments.slice(0, count);
      console.log(`评论阶段: aweme=${awemeId} mode=playwright comments=${result.comments.length} total=${Date.now() - startTime}ms`);
      return result;
    } finally {
      await page.close();
    }
  });
}

/** 获取图片动态的全部图片 */
export async function fetchImageUrls(awemeId: string): Promise<string[]> {
  return runPlaywrightTask(async () => {
    const startTime = Date.now();
    const context = await getSharedContext();
    const page = await context.newPage();
    try {
      await blockImageHeavyResources(page);

      const firstNavigateElapsed = await gotoImageSharePage(page, awemeId);
      let waitElapsed = 0;
      let retryNavigateElapsed = 0;
      let retryWaitElapsed = 0;
      let retried = false;

      let urls = await waitForImageUrls(page, IMAGE_FIRST_WAIT_MS);
      waitElapsed = urls.elapsed;

      if (urls.urls.length === 0) {
        retried = true;
        retryNavigateElapsed = await gotoImageSharePage(page, awemeId);
        urls = await waitForImageUrls(page, IMAGE_RETRY_WAIT_MS);
        retryWaitElapsed = urls.elapsed;
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `图片阶段: aweme=${awemeId} firstNav=${firstNavigateElapsed}ms firstWait=${waitElapsed}ms` +
          ` retried=${retried} retryNav=${retryNavigateElapsed}ms retryWait=${retryWaitElapsed}ms images=${urls.urls.length} total=${elapsed}ms`,
      );
      return urls.urls;
    } finally {
      await page.close();
    }
  });
}

/** 预热：服务启动时调用 */
export async function warmUp(): Promise<void> {
  console.log('预热中...');
  await getSharedContext();
  console.log('预热完成，浏览器就绪');
}

export async function closeBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedContext = null;
  sharedContextPromise = null;
  sharedBrowser = null;
  playwrightWarmedUp = false;
  await browser?.close().catch(() => {});
}

export function getRuntimeStatus() {
  return {
    playwright: {
      warmedUp: playwrightWarmedUp && Boolean(sharedContext?.browser()?.isConnected()),
      activeTasks: activePlaywrightTasks,
      queueLength: playwrightQueue.length,
      concurrency: PLAYWRIGHT_CONCURRENCY,
      queueMax: PLAYWRIGHT_QUEUE_MAX,
      proxy: Boolean(PLAYWRIGHT_PROXY_SERVER),
    },
    cache: {
      lookup: lookupCache.size,
      videoUrl: videoUrlCache.size + listVideoUrlCache.size,
      imageUrl: imageUrlCache.size + listImageUrlCache.size,
      comments: commentCache.size,
      negative: negativeCache.size,
    },
  };
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
}

async function createLookupContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: DESKTOP_UA,
    viewport: { width: 1365, height: 900 },
  });
}

/** 获取用户信息（Playwright 兜底，签名 API 不稳定） */
export async function fetchUserInfo(uniqueId: string): Promise<UserInfo> {
  return runPlaywrightTask(async () => {
    const context = await getSharedContext();
    const page = await context.newPage();
    try {
      await page.goto('https://m.douyin.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const data = await page.evaluate(async (id) => {
        const resp = await fetch(
          'https://www.iesdouyin.com/web/api/v2/user/info/?unique_id=' + id,
          { credentials: 'include' },
        );
        return await resp.json();
      }, uniqueId);
      if (!data.user_info) throw new Error(`未找到 dy 号 ${uniqueId} 的用户`);
      return buildUserInfo(data.user_info, uniqueId);
    } finally {
      await page.close();
    }
  });
}

/**
 * 输入 dy 号，返回用户信息和视频列表。
 *
 * @example
 * const result = await fetchByUniqueId('dkvhz8lc5', { count: 15 });
 * console.log(result.nickname, result.videos);
 */
export async function fetchByUniqueId(
  uniqueId: string,
  options: FetchOptions = {},
): Promise<UserResult> {
  return runPlaywrightTask(async () => {
    const { count = 15 } = options;
    const startTime = Date.now();

    const userInfoStart = Date.now();
    const userInfo = await fetchUserInfoDirect(uniqueId);
    const userInfoElapsed = Date.now() - userInfoStart;
    if (!userInfo.user_info) {
      throw new Error(`未找到 dy 号 ${uniqueId} 的用户`);
    }

    const { sec_uid, aweme_count } = userInfo.user_info;
    const publicUserInfo = buildUserInfo(userInfo.user_info, uniqueId);
    const { nickname } = publicUserInfo;
    console.log(`用户: ${nickname} | dy 号: ${publicUserInfo.uniqueId} | 作品: ${aweme_count}`);

    if (Number(aweme_count) <= 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  lookup阶段: userInfo=${userInfoElapsed}ms videos=0 skipped=emptyAwemeCount`);
      console.log(`  完成，耗时 ${elapsed}s`);
      return {
        ...publicUserInfo,
        secUid: sec_uid,
        videos: [],
        requestedCount: count,
        returnedCount: 0,
        hasMore: false,
      };
    }

    const context = await createLookupContext(await getBrowser());
    const page = await context.newPage();

    try {
      await blockLookupHeavyResources(page);
      const detachLookupDebug = attachLookupDebug(page, `uniqueId:${uniqueId}`);

      // 步骤3: 拦截器 + 访问用户主页，拿首屏视频
      const { getVideos, getHasMore, getPostUrls, reset } = setupInterceptor(page);
      const firstPostResponse = waitForPostResponse(page, LOOKUP_FIRST_WAIT_MS + LOOKUP_NAVIGATION_TIMEOUT_MS);
      const firstNavigateElapsed = await gotoLookupUserPage(page, sec_uid);
      const firstWaitElapsed = await waitForVideos(getVideos, count, LOOKUP_FIRST_WAIT_MS, {
        postResponsePromise: firstPostResponse,
        getPostUrls,
      });

      // 首次如果没拿到，重试一次（反爬 JS 可能没跑完）
      let retried = false;
      let retryNavigateElapsed = 0;
      let retryWaitElapsed = 0;
      let allVideos = getVideos().slice(0, count);
      let hasMore = getHasMore();
      if (allVideos.length === 0 && getPostUrls().length > 0) {
        const direct = await fetchDesktopPostList(page, sec_uid, count, getPostUrls()).catch(() => null);
        if (direct?.aweme_list?.length) {
          allVideos = direct.aweme_list.slice(0, count);
          hasMore = Boolean(direct.has_more);
        }
      }
      if (allVideos.length === 0) {
        console.log('  首次无数据，重试...');
        retried = true;
        reset();
        const retryPostResponse = waitForPostResponse(page, LOOKUP_RETRY_WAIT_MS + LOOKUP_NAVIGATION_TIMEOUT_MS);
        retryNavigateElapsed = await gotoLookupUserPage(page, sec_uid);
        retryWaitElapsed = await waitForVideos(getVideos, count, LOOKUP_RETRY_WAIT_MS, {
          postResponsePromise: retryPostResponse,
          getPostUrls,
        });
        if (allVideos.length === 0) {
          allVideos = getVideos().slice(0, count);
          hasMore = getHasMore();
        }
      }

      if (allVideos.length === 0) {
        const direct = await fetchDesktopPostList(page, sec_uid, count, getPostUrls()).catch(async (error) => {
          await runLookupFailureDiagnostics(page, sec_uid, count, `uniqueId:${uniqueId}`);
          throw error;
        });
        allVideos = direct.aweme_list.slice(0, count);
        hasMore = Boolean(direct.has_more);
      }
      detachLookupDebug();
      cacheListMediaUrls(allVideos);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  lookup阶段: userInfo=${userInfoElapsed}ms firstNav=${firstNavigateElapsed}ms firstWait=${firstWaitElapsed}ms` +
          ` retried=${retried} retryNav=${retryNavigateElapsed}ms retryWait=${retryWaitElapsed}ms videos=${allVideos.length}`,
      );
      console.log(`  完成，耗时 ${elapsed}s`);

      return {
        ...publicUserInfo,
        secUid: sec_uid,
        videos: allVideos,
        requestedCount: count,
        returnedCount: allVideos.length,
        hasMore: hasMore || Number(aweme_count) > allVideos.length,
      };
    } finally {
      await context.close();
    }
  });
}

export async function fetchBySecUid(
  secUid: string,
  options: SecUidLookupOptions = {},
): Promise<UserResult> {
  return runPlaywrightTask(async () => {
    const { count = 15 } = options;
    const startTime = Date.now();
    const context = await createLookupContext(await getBrowser());
    const page = await context.newPage();

    try {
      await blockLookupHeavyResources(page);
      const detachLookupDebug = attachLookupDebug(page, `secUid:${secUid}`);
      const { getVideos, getHasMore, getPostUrls, reset } = setupInterceptor(page);
      const firstPostResponse = waitForPostResponse(page, LOOKUP_FIRST_WAIT_MS + LOOKUP_NAVIGATION_TIMEOUT_MS);
      const firstNavigateElapsed = await gotoLookupUserPage(page, secUid);
      const firstWaitElapsed = await waitForVideos(getVideos, count, LOOKUP_FIRST_WAIT_MS, {
        postResponsePromise: firstPostResponse,
        getPostUrls,
      });

      let retried = false;
      let retryNavigateElapsed = 0;
      let retryWaitElapsed = 0;
      let allVideos = getVideos().slice(0, count);
      let hasMore = getHasMore();
      if (allVideos.length === 0 && getPostUrls().length > 0) {
        const direct = await fetchDesktopPostList(page, secUid, count, getPostUrls()).catch(() => null);
        if (direct?.aweme_list?.length) {
          allVideos = direct.aweme_list.slice(0, count);
          hasMore = Boolean(direct.has_more);
        }
      }
      if (allVideos.length === 0) {
        console.log('  secUid首次无数据，重试...');
        retried = true;
        reset();
        const retryPostResponse = waitForPostResponse(page, LOOKUP_RETRY_WAIT_MS + LOOKUP_NAVIGATION_TIMEOUT_MS);
        retryNavigateElapsed = await gotoLookupUserPage(page, secUid);
        retryWaitElapsed = await waitForVideos(getVideos, count, LOOKUP_RETRY_WAIT_MS, {
          postResponsePromise: retryPostResponse,
          getPostUrls,
        });
        if (allVideos.length === 0) {
          allVideos = getVideos().slice(0, count);
          hasMore = getHasMore();
        }
      }

      if (allVideos.length === 0) {
        const direct = await fetchDesktopPostList(page, secUid, count, getPostUrls()).catch(async (error) => {
          await runLookupFailureDiagnostics(page, secUid, count, `secUid:${secUid}`);
          throw error;
        });
        allVideos = direct.aweme_list.slice(0, count);
        hasMore = Boolean(direct.has_more);
      }
      detachLookupDebug();
      cacheListMediaUrls(allVideos);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `secUid用户: ${options.nickname || secUid} | firstNav=${firstNavigateElapsed}ms firstWait=${firstWaitElapsed}ms` +
          ` retried=${retried} retryNav=${retryNavigateElapsed}ms retryWait=${retryWaitElapsed}ms videos=${allVideos.length}`,
      );
      console.log(`  完成，耗时 ${elapsed}s`);

      return {
        nickname: String(options.nickname || '这个人'),
        avatar: String(options.avatar || ''),
        uniqueId: '',
        awemeCount: allVideos.length,
        signature: String(options.signature || ''),
        followingCount: 0,
        followerCount: 0,
        totalFavorited: 0,
        secUid,
        videos: allVideos,
        requestedCount: count,
        returnedCount: allVideos.length,
        hasMore,
      };
    } finally {
      await context.close();
    }
  });
}

export async function getCachedByUniqueId(
  uniqueId: string,
  options: FetchOptions = {},
): Promise<UserResult> {
  const { count = 15 } = options;
  const cacheKey = `${uniqueId}:${count}`;
  const negativeKey = `lookup:${cacheKey}`;
  pruneLookupCache();

  const cached = lookupCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    console.log(`搜索缓存命中: ${uniqueId} | count=${count}`);
    return cloneUserResult(cached.result);
  }
  throwIfNegativeCached(negativeKey);

  const inFlight = lookupInFlight.get(cacheKey);
  if (inFlight) return cloneUserResult(await inFlight);

  const promise = fetchByUniqueId(uniqueId, { count })
    .catch((error) => {
      cacheNegativeError(negativeKey, error);
      throw error;
    })
    .finally(() => {
      lookupInFlight.delete(cacheKey);
    });
  lookupInFlight.set(cacheKey, promise);

  const result = await promise;
  if (shouldCacheLookupResult(result) && LOOKUP_CACHE_TTL_MS > 0) {
    lookupCache.set(cacheKey, {
      result: cloneUserResult(result),
      expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
    });
  }
  return result;
}

export async function getCachedBySecUid(
  secUid: string,
  options: SecUidLookupOptions = {},
): Promise<UserResult> {
  const { count = 15 } = options;
  const cacheKey = `secUid:${secUid}:${count}`;
  const negativeKey = `lookup:${cacheKey}`;
  pruneLookupCache();

  const cached = lookupCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    console.log(`secUid搜索缓存命中: ${secUid} | count=${count}`);
    return cloneUserResult(cached.result);
  }
  throwIfNegativeCached(negativeKey);

  const inFlight = lookupInFlight.get(cacheKey);
  if (inFlight) return cloneUserResult(await inFlight);

  const promise = fetchBySecUid(secUid, options)
    .catch((error) => {
      cacheNegativeError(negativeKey, error);
      throw error;
    })
    .finally(() => {
      lookupInFlight.delete(cacheKey);
    });
  lookupInFlight.set(cacheKey, promise);

  const result = await promise;
  if (shouldCacheLookupResult(result) && LOOKUP_CACHE_TTL_MS > 0) {
    lookupCache.set(cacheKey, {
      result: cloneUserResult(result),
      expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
    });
  }
  return result;
}

function shouldCacheLookupResult(result: UserResult): boolean {
  return Boolean(result.nickname && result.secUid && result.videos.length > 0);
}

function throwIfNegativeCached(key: string): void {
  const cached = negativeCache.get(key);
  if (!cached) return;
  if (cached.expiresAt <= Date.now()) {
    negativeCache.delete(key);
    return;
  }
  throw new Error(cached.message || '请求繁忙，请稍后再试');
}

function cacheNegativeError(key: string, error: unknown): void {
  if (NEGATIVE_CACHE_TTL_MS <= 0) return;
  const message = error instanceof Error ? error.message : String(error || '请求失败');
  negativeCache.set(key, {
    message,
    expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
  });
}

async function fetchCommentsDirect(awemeId: string, count: number): Promise<CommentResult> {
  const context = await getSharedContext();
  const cookies = await context.cookies(['https://m.douyin.com', 'https://www.iesdouyin.com']);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const url = new URL('https://www.iesdouyin.com/web/api/v2/comment/list/');
  url.searchParams.set('aweme_id', awemeId);
  url.searchParams.set('cursor', '0');
  url.searchParams.set('count', String(count));

  const resp = await fetch(url.toString(), {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept': 'application/json,text/plain,*/*',
      'Referer': 'https://m.douyin.com/',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  if (!resp.ok) throw new Error(`comment direct api status ${resp.status}`);

  const data = await resp.json();
  const result = normalizeCommentResult(data);
  result.comments = result.comments.slice(0, count);
  if (!Array.isArray(result.comments)) throw new Error('comment direct payload invalid');
  return result;
}

async function fetchUserInfoDirect(uniqueId: string): Promise<any> {
  const resp = await fetch(
    'https://www.iesdouyin.com/web/api/v2/user/info/?unique_id=' + encodeURIComponent(uniqueId),
    {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://m.douyin.com/',
      },
    },
  );
  if (!resp.ok) throw new Error(`user info status ${resp.status}`);
  return resp.json();
}

async function fetchDesktopPostList(
  page: Page,
  secUid: string,
  count: number,
  candidateUrls: string[] = [],
): Promise<PostApiResponse> {
  const data = await page.evaluate(async ({ secUid, count, candidateUrls }) => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const params = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      sec_user_id: secUid,
      max_cursor: '0',
      locate_query: 'false',
      show_live_replay_strategy: '1',
      need_time_list: '1',
      count: String(Math.max(count, 18)),
      publish_video_strategy_type: '2',
    });
    let lastError = '';
    const fallbackUrl = `https://www.douyin.com/aweme/v1/web/aweme/post/?${params.toString()}`;
    const urls = [...candidateUrls, fallbackUrl].filter((url, index, list) => (
      typeof url === 'string' && url.includes('/aweme/post/') && list.indexOf(url) === index
    ));
    for (const url of urls) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json,text/plain,*/*' },
        });
        const text = await resp.text();
        if (!resp.ok) {
          lastError = `status ${resp.status}`;
        } else if (!text.trim()) {
          lastError = 'empty body';
        } else {
          try {
            return JSON.parse(text);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (attempt < 3) await delay(800);
      }
    }
    throw new Error(`desktop post response invalid: ${lastError || 'unknown'}`);
  }, { secUid, count, candidateUrls });
  return {
    aweme_list: Array.isArray(data?.aweme_list) ? data.aweme_list : [],
    max_cursor: toSafeNumber(data?.max_cursor),
    has_more: Boolean(data?.has_more),
  };
}

function buildUserInfo(userInfo: any, fallbackUniqueId: string): UserInfo {
  return {
    nickname: String(userInfo?.nickname || ''),
    avatar: userInfo?.avatar_thumb?.url_list?.[0] || '',
    uniqueId: resolveUserUniqueId(userInfo, fallbackUniqueId),
    awemeCount: toSafeNumber(userInfo?.aweme_count),
    signature: String(userInfo?.signature || '').trim(),
    followingCount: toSafeNumber(userInfo?.following_count),
    followerCount: toSafeNumber(userInfo?.mplatform_followers_count),
    totalFavorited: normalizeCountValue(userInfo?.total_favorited),
  };
}

function normalizeCommentResult(data: any): CommentResult {
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  return {
    comments: comments.map(normalizeComment).filter((comment: PublicComment) => comment.cid && comment.text),
    hasMore: Boolean(data?.has_more),
    cursor: toSafeNumber(data?.cursor),
  };
}

function normalizeComment(comment: any): PublicComment {
  const user = comment?.user || {};
  return {
    cid: String(comment?.cid || ''),
    text: String(comment?.text || '').trim(),
    createTime: toSafeNumber(comment?.createTime ?? comment?.create_time),
    diggCount: toSafeNumber(comment?.digg_count),
    user: {
      nickname: String(user?.nickname || ''),
      avatar: user?.avatar_thumb?.url_list?.[0] || user?.avatar_medium?.url_list?.[0] || '',
      uniqueId: String(user?.unique_id || '').trim(),
      shortId: String(user?.short_id || '').trim(),
      secUid: String(user?.sec_uid || '').trim(),
      signature: String(user?.signature || '').trim(),
    },
  };
}

function resolveUserUniqueId(userInfo: any, fallback: string): string {
  const candidates = [userInfo?.unique_id, userInfo?.short_id, fallback];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value && value !== '0') return value;
  }
  return fallback;
}

function toSafeNumber(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
  return numberValue;
}

function normalizeCountValue(value: unknown): string | number {
  if (typeof value === 'number') return toSafeNumber(value);
  const stringValue = String(value ?? '').trim();
  if (!stringValue) return 0;
  return /^\d+$/.test(stringValue) ? stringValue : 0;
}

function cacheListMediaUrls(videos: Aweme[]): void {
  for (const video of videos) {
    const awemeId = String(video?.aweme_id || '');
    if (!awemeId) continue;

    const videoUrl = extractVideoUrlFromAweme(video);
    if (videoUrl && VIDEO_URL_TTL_MS > 0) {
      listVideoUrlCache.set(awemeId, {
        url: videoUrl,
        expiresAt: Date.now() + VIDEO_URL_TTL_MS,
      });
    }

    const imageUrls = extractImageUrlsFromAweme(video);
    if (imageUrls.length > 0 && IMAGE_URL_TTL_MS > 0) {
      listImageUrlCache.set(awemeId, {
        urls: imageUrls,
        expiresAt: Date.now() + IMAGE_URL_TTL_MS,
      });
    }
  }
}

function extractVideoUrlFromAweme(aweme: Aweme): string {
  const candidates = [
    ...(aweme.video?.play_addr_h264?.url_list || []),
    ...(aweme.video?.play_addr?.url_list || []),
    ...(aweme.video?.bit_rate || []).flatMap((item) => item.play_addr?.url_list || []),
  ];
  return normalizeVideoUrl(firstUsableUrl(candidates));
}

function extractImageUrlsFromAweme(aweme: Aweme): string[] {
  const candidates = [
    ...(aweme.image_infos || []).flatMap((image) => [
      ...(image.origin_image?.url_list || []),
      ...(image.label_large?.url_list || []),
      ...(image.label_thumb?.url_list || []),
    ]),
    ...(aweme.images || []).flatMap((image) => [
      ...(image.download_url_list || []),
      ...(image.url_list || []),
    ]),
  ];
  return uniqueImageUrls(candidates.filter(isLikelyImageUrl));
}

function firstUsableUrl(urls: string[]): string {
  return urls.find((url) => typeof url === 'string' && /^https?:\/\//.test(url)) || '';
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push(url);
  }
  return results;
}

function uniqueImageUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const url of urls) {
    const key = imageUrlDedupeKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(url);
  }
  return results;
}

function imageUrlDedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .replace(/^\/obj\//, '/')
      .replace(/~tplv-[^/?]+(?=\.|$)/, '');
  } catch {
    return url.split('?')[0];
  }
}

function isLikelyImageUrl(url: string): boolean {
  if (!/^https?:\/\//.test(url)) return false;
  return url.includes('tos-cn') || url.includes('douyinpic') || url.includes('image');
}

function cacheVideoUrl(awemeId: string, url: string): void {
  if (!url || VIDEO_URL_TTL_MS <= 0) return;
  videoUrlCache.set(awemeId, {
    url,
    expiresAt: Date.now() + VIDEO_URL_TTL_MS,
  });
}

function cacheImageUrls(awemeId: string, urls: string[]): void {
  if (urls.length === 0 || IMAGE_URL_TTL_MS <= 0) return;
  imageUrlCache.set(awemeId, {
    urls: [...urls],
    expiresAt: Date.now() + IMAGE_URL_TTL_MS,
  });
}

function waitForVideos(
  getVideos: () => Aweme[],
  targetCount: number,
  timeoutMs: number,
  options: {
    postResponsePromise?: Promise<number | null>;
    getPostUrls?: () => string[];
  } = {},
): Promise<number> {
  const start = Date.now();
  let lastCount = 0;
  let lastChangeAt = start;
  let postResponseSeenAt = 0;
  options.postResponsePromise?.then((elapsed) => {
    if (elapsed !== null) postResponseSeenAt = Date.now();
  }).catch(() => {});
  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - start;
      const count = getVideos().length;
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = Date.now();
      }
      if (count >= targetCount) return resolve(elapsed);
      if (count > 0 && Date.now() - lastChangeAt >= 700) return resolve(elapsed);
      if (!postResponseSeenAt && options.getPostUrls?.().length) postResponseSeenAt = Date.now();
      if (postResponseSeenAt > 0 && count === 0 && Date.now() - postResponseSeenAt >= 1500) return resolve(elapsed);
      if (elapsed > timeoutMs) return resolve(elapsed);
      setTimeout(check, 200);
    };
    check();
  });
}

function waitForPostResponse(page: Page, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      page.off('response', onResponse);
    };
    const finish = (elapsed: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(elapsed);
    };
    const onResponse = (response: Response) => {
      if (!response.url().includes('/aweme/post/')) return;
      finish(Date.now() - start);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    page.on('response', onResponse);
  });
}

function attachLookupDebug(page: Page, label: string): () => void {
  if (!LOOKUP_DEBUG) return () => {};
  const requestUrls = new Set<string>();
  const responseUrls = new Set<string>();
  debugLookupLog('attach', { label, url: page.url() });

  const onRequest = (request: any) => {
    const url = request.url();
    if (!url.includes('/aweme/post/')) return;
    requestUrls.add(url);
    debugLookupLog('post-request', {
      label,
      count: requestUrls.size,
      method: request.method(),
      resourceType: request.resourceType(),
      url: sanitizeLookupUrl(url),
    });
  };

  const onResponse = (response: Response) => {
    const url = response.url();
    if (!url.includes('/aweme/post/')) return;
    responseUrls.add(url);
    const status = response.status();
    const contentType = response.headers()['content-type'] || '';
    response.text()
      .then((text) => {
        debugLookupLog('post-response', {
          label,
          count: responseUrls.size,
          status,
          contentType,
          bodyLength: text.length,
          empty: text.trim().length === 0,
          preview: text.trim() ? sanitizeDebugText(text, 120) : '',
          url: sanitizeLookupUrl(url),
        });
      })
      .catch((error) => {
        debugLookupLog('post-response-read-failed', {
          label,
          status,
          contentType,
          message: error instanceof Error ? error.message : String(error),
          url: sanitizeLookupUrl(url),
        });
      });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  return () => {
    debugLookupLog('detach', {
      label,
      requests: requestUrls.size,
      responses: responseUrls.size,
      url: page.url(),
    });
    page.off('request', onRequest);
    page.off('response', onResponse);
  };
}

async function runLookupFailureDiagnostics(page: Page, secUid: string, count: number, label: string): Promise<void> {
  if (!LOOKUP_DEBUG) return;
  debugLookupLog('failure-diagnostics-start', { label, url: page.url() });
  await diagnoseHydration(page, `${label}:desktop`).catch((error) => {
    debugLookupLog('desktop-hydration-failed', { label, message: toErrorMessage(error) });
  });
  const performanceUrls = await getPostUrlsFromPerformance(page).catch(() => []);
  debugLookupLog('desktop-performance-post-urls', {
    label,
    count: performanceUrls.length,
    urls: performanceUrls.slice(0, 5).map(sanitizeLookupUrl),
  });
  await diagnoseFullDesktopPage(secUid, count, label).catch((error) => {
    debugLookupLog('full-desktop-diagnostics-failed', { label, message: toErrorMessage(error) });
  });
  await diagnoseMobileSharePage(secUid, count, label).catch((error) => {
    debugLookupLog('mobile-share-diagnostics-failed', { label, message: toErrorMessage(error) });
  });
  debugLookupLog('failure-diagnostics-end', { label });
}

async function diagnoseFullDesktopPage(secUid: string, count: number, label: string): Promise<void> {
  const context = await createLookupContext(await getBrowser());
  const page = await context.newPage();
  const fullLabel = `${label}:full-desktop`;
  const detach = attachLookupDebug(page, fullLabel);
  try {
    const { getVideos, getPostUrls } = setupInterceptor(page);
    const postResponse = waitForPostResponse(page, LOOKUP_RETRY_WAIT_MS + LOOKUP_NAVIGATION_TIMEOUT_MS + 8000);
    const started = Date.now();
    await page.goto(`https://www.douyin.com/user/${secUid}`, {
      waitUntil: 'domcontentloaded',
      timeout: LOOKUP_NAVIGATION_TIMEOUT_MS + 8000,
    }).catch((error) => {
      debugLookupLog('full-desktop-navigation-warning', { label, message: toErrorMessage(error) });
    });
    await page.evaluate(() => window.scrollTo({ top: Math.max(document.body.scrollHeight * 0.45, 800), behavior: 'smooth' }))
      .catch(() => {});
    await sleep(1800);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
    const waitElapsed = await waitForVideos(getVideos, count, LOOKUP_RETRY_WAIT_MS + 3000, {
      postResponsePromise: postResponse,
      getPostUrls,
    });
    await diagnoseHydration(page, fullLabel).catch((error) => {
      debugLookupLog('full-desktop-hydration-failed', { label, message: toErrorMessage(error) });
    });
    const performanceUrls = await getPostUrlsFromPerformance(page).catch(() => []);
    debugLookupLog('full-desktop-result', {
      label,
      navAndWaitElapsed: Date.now() - started,
      waitElapsed,
      videos: getVideos().length,
      postUrls: getPostUrls().slice(0, 8).map(sanitizeLookupUrl),
      performancePostUrls: performanceUrls.slice(0, 8).map(sanitizeLookupUrl),
      url: page.url(),
    });
  } finally {
    detach();
    await context.close().catch(() => {});
  }
}

async function diagnoseMobileSharePage(secUid: string, count: number, label: string): Promise<void> {
  const context = await createContext(await getBrowser());
  const page = await context.newPage();
  const mobileLabel = `${label}:mobile-share`;
  const detach = attachLookupDebug(page, mobileLabel);
  try {
    await blockLookupHeavyResources(page);
    const { getVideos, getPostUrls } = setupInterceptor(page);
    const postResponse = waitForPostResponse(page, LOOKUP_RETRY_WAIT_MS + LOOKUP_NAVIGATION_TIMEOUT_MS);
    const started = Date.now();
    await page.goto(`https://m.douyin.com/share/user/${secUid}`, {
      waitUntil: 'commit',
      timeout: LOOKUP_NAVIGATION_TIMEOUT_MS,
    }).catch((error) => {
      debugLookupLog('mobile-share-navigation-warning', { label, message: toErrorMessage(error) });
    });
    const waitElapsed = await waitForVideos(getVideos, count, LOOKUP_RETRY_WAIT_MS, {
      postResponsePromise: postResponse,
      getPostUrls,
    });
    await diagnoseHydration(page, mobileLabel).catch((error) => {
      debugLookupLog('mobile-share-hydration-failed', { label, message: toErrorMessage(error) });
    });
    debugLookupLog('mobile-share-result', {
      label,
      navAndWaitElapsed: Date.now() - started,
      waitElapsed,
      videos: getVideos().length,
      postUrls: getPostUrls().slice(0, 5).map(sanitizeLookupUrl),
      url: page.url(),
    });
  } finally {
    detach();
    await context.close().catch(() => {});
  }
}

async function diagnoseHydration(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const scripts = Array.from(document.scripts || []);
    let awemeListScripts = 0;
    let awemeIdScripts = 0;
    let postPathScripts = 0;
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.includes('aweme_list')) awemeListScripts += 1;
      if (text.includes('aweme_id') || text.includes('awemeId')) awemeIdScripts += 1;
      if (text.includes('/aweme/post/')) postPathScripts += 1;
    }
    return {
      url: location.href,
      scriptCount: scripts.length,
      awemeListScripts,
      awemeIdScripts,
      postPathScripts,
      bodyTextLength: document.body?.innerText?.length || 0,
      readyState: document.readyState,
    };
  });
  debugLookupLog('hydration', { label, ...result });
}

async function getPostUrlsFromPerformance(page: Page): Promise<string[]> {
  return page.evaluate(() => (
    (performance.getEntriesByType('resource') || [])
      .map((entry) => String(entry.name || ''))
      .filter((url, index, list) => url.includes('/aweme/post/') && list.indexOf(url) === index)
  ));
}

function sanitizeLookupUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const allowedValues = new Set([
      'aid',
      'count',
      'max_cursor',
      'device_platform',
      'channel',
      'publish_video_strategy_type',
      'locate_query',
      'need_time_list',
      'show_live_replay_strategy',
    ]);
    const sensitive = /(token|bogus|verify|signature|webid|odin|fp|cookie|ttwid|nonce|csrf|sec_user|user_id|uid|ms)/i;
    const params = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      if (sensitive.test(key)) {
        params.set(key, '<redacted>');
      } else if (allowedValues.has(key)) {
        params.set(key, value.length > 64 ? `<len:${value.length}>` : value);
      } else {
        params.set(key, value ? `<len:${value.length}>` : '<empty>');
      }
    });
    const query = params.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return sanitizeDebugText(url, 180);
  }
}

function sanitizeDebugText(text: string, maxLength: number): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/("?(?:msToken|a_bogus|X-Bogus|verifyFp|fp|ttwid|odin_tt|webid)"?\s*[:=]\s*)"[^"]+"/gi, '$1"<redacted>"')
    .slice(0, maxLength);
}

function debugLookupLog(message: string, metadata: Record<string, unknown> = {}): void {
  if (!LOOKUP_DEBUG) return;
  console.log(`lookup-debug ${message} ${JSON.stringify(metadata)}`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function blockLookupHeavyResources(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (['image', 'media', 'font'].includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}

async function gotoLookupUserPage(page: Page, secUid: string): Promise<number> {
  const start = Date.now();
  await page.goto(`https://www.douyin.com/user/${secUid}`, {
    waitUntil: 'commit',
    timeout: LOOKUP_NAVIGATION_TIMEOUT_MS,
  }).catch((error) => {
    console.warn(`  分享页导航未完成，继续等待视频列表: ${error?.message || error}`);
  });
  return Date.now() - start;
}

async function blockImageHeavyResources(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    if (['media', 'font', 'stylesheet'].includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}

async function blockVideoPageHeavyResources(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'font', 'stylesheet'].includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}

async function extractVideoUrlFromDom(page: Page): Promise<string> {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    return video?.currentSrc || video?.src || video?.getAttribute('src') || '';
  }).catch(() => '');
}

async function hasVideoElement(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.querySelector('video'))).catch(() => false);
}

async function extractVideoUrlFromScripts(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scripts = Array.from(document.scripts);
    const playUrlPattern = /(?:https?:\/\/[^"'\\<]+|\/aweme\/v1\/playwm\/\?[^"'\\<]+)/g;
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('playwm') && !text.includes('video_id')) continue;
      const matches = text.match(playUrlPattern) || [];
      const candidate = matches.find((url) => url.includes('/aweme/v1/playwm/') || url.includes('video_id='));
      if (candidate) return candidate.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&');
    }
    return '';
  }).catch(() => '');
}

function extractVideoUrlFromResponse(response: Response): string {
  const url = response.url();
  const contentType = response.headers()['content-type'] || '';
  const resourceType = response.request().resourceType();
  if (contentType.startsWith('video/') || resourceType === 'media' || isLikelyVideoUrl(url)) {
    return url;
  }
  return '';
}

function isLikelyVideoUrl(url: string): boolean {
  if (!/^https?:\/\//.test(url)) return false;
  return url.includes('mime_type=video_mp4') || url.includes('video_id=') || url.includes('/video/tos/');
}

function normalizeVideoUrl(url: string): string {
  if (!url) return '';
  const absoluteUrl = url.startsWith('/') ? `https://m.douyin.com${url}` : url;
  return absoluteUrl.replace('ratio=720p', 'ratio=540p');
}

async function gotoImageSharePage(page: Page, awemeId: string): Promise<number> {
  const start = Date.now();
  await page.goto(`https://m.douyin.com/share/video/${awemeId}`, {
    waitUntil: 'commit',
    timeout: IMAGE_NAVIGATION_TIMEOUT_MS,
  }).catch((error) => {
    console.warn(`图片页导航未完成，继续等待图片: ${error?.message || error}`);
  });
  return Date.now() - start;
}

async function waitForImageUrls(page: Page, timeoutMs: number): Promise<{ urls: string[]; elapsed: number }> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const urls = await extractImageUrls(page);
    if (urls.length > 0) {
      return { urls, elapsed: Date.now() - start };
    }
    await sleep(250);
  }
  return { urls: await extractImageUrls(page), elapsed: Date.now() - start };
}

async function extractImageUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const imgs = document.querySelectorAll('img[src*="tos-cn"]');
    const seen = new Set<string>();
    const results: string[] = [];
    for (const img of imgs) {
      const src = (img as HTMLImageElement).src;
      // 匹配水印图（视频/图片）和 live 图
      if (!src.includes('water-v2') && !src.includes('lqen-new-water')) continue;
      if (seen.has(src)) continue;
      seen.add(src);
      results.push(src);
    }
    return results;
  });
}

function runPlaywrightTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activePlaywrightTasks++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activePlaywrightTasks--;
          runNextPlaywrightTask();
        });
    };

    if (activePlaywrightTasks < PLAYWRIGHT_CONCURRENCY) {
      run();
      return;
    }

    if (playwrightQueue.length >= PLAYWRIGHT_QUEUE_MAX) {
      reject(new Error('请求繁忙，请稍后再试'));
      return;
    }

    const queued = {
      run,
      reject,
      timer: setTimeout(() => {
        const index = playwrightQueue.indexOf(queued);
        if (index >= 0) playwrightQueue.splice(index, 1);
        reject(new Error('请求繁忙，请稍后再试'));
      }, PLAYWRIGHT_QUEUE_TIMEOUT_MS),
    };
    playwrightQueue.push(queued);
  });
}

function runNextPlaywrightTask() {
  while (activePlaywrightTasks < PLAYWRIGHT_CONCURRENCY && playwrightQueue.length > 0) {
    const next = playwrightQueue.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.run();
  }
}

function pruneVideoUrlCache() {
  const now = Date.now();
  pruneNegativeCache(now);
  for (const [awemeId, cached] of videoUrlCache) {
    if (cached.expiresAt <= now) videoUrlCache.delete(awemeId);
  }
  for (const [awemeId, cached] of listVideoUrlCache) {
    if (cached.expiresAt <= now) listVideoUrlCache.delete(awemeId);
  }
}

function pruneLookupCache() {
  const now = Date.now();
  pruneNegativeCache(now);
  for (const [key, cached] of lookupCache) {
    if (cached.expiresAt <= now) lookupCache.delete(key);
  }
}

function pruneImageUrlCache() {
  const now = Date.now();
  pruneNegativeCache(now);
  for (const [awemeId, cached] of imageUrlCache) {
    if (cached.expiresAt <= now) imageUrlCache.delete(awemeId);
  }
  for (const [awemeId, cached] of listImageUrlCache) {
    if (cached.expiresAt <= now) listImageUrlCache.delete(awemeId);
  }
}

function pruneCommentCache() {
  const now = Date.now();
  pruneNegativeCache(now);
  for (const [key, cached] of commentCache) {
    if (cached.expiresAt <= now) commentCache.delete(key);
  }
}

function pruneNegativeCache(now = Date.now()) {
  for (const [key, cached] of negativeCache) {
    if (cached.expiresAt <= now) negativeCache.delete(key);
  }
}

function cloneUserResult(result: UserResult): UserResult {
  return {
    ...result,
    videos: result.videos.map((video) => ({
      ...video,
      video: video.video
        ? {
            ...video.video,
            cover: {
              ...video.video.cover,
              url_list: [...(video.video.cover?.url_list || [])],
            },
          }
        : video.video,
    })),
  };
}

function cloneCommentResult(result: CommentResult): CommentResult {
  return {
    comments: result.comments.map((comment) => ({
      ...comment,
      user: { ...comment.user },
    })),
    hasMore: result.hasMore,
    cursor: result.cursor,
  };
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
