import { Page } from 'playwright';
import type { Aweme, PostApiResponse } from './types.js';

export interface InterceptorState {
  getVideos: () => Aweme[];
  getHasMore: () => boolean;
  getPostUrls: () => string[];
  reset: () => void;
}

export function setupInterceptor(page: Page): InterceptorState {
  const videos: Aweme[] = [];
  const seenAwemeIds = new Set<string>();
  const postUrls: string[] = [];
  let hasMore = false;

  const rememberPostUrl = (url: string) => {
    if (!url.includes('/aweme/post/') || postUrls.includes(url)) return;
    postUrls.push(url);
    if (postUrls.length > 5) postUrls.shift();
  };

  page.on('request', (request) => {
    rememberPostUrl(request.url());
  });

  page.on('response', async (response) => {
    if (!response.url().includes('/aweme/post/')) return;
    rememberPostUrl(response.url());
    try {
      const text = await response.text();
      if (!text.trim()) return;
      const body = JSON.parse(text);
      const data = body as PostApiResponse;
      hasMore = Boolean(data.has_more);
      for (const aweme of data.aweme_list || []) {
        const awemeId = String(aweme?.aweme_id || '');
        if (!awemeId || seenAwemeIds.has(awemeId)) continue;
        seenAwemeIds.add(awemeId);
        videos.push(aweme);
      }
    } catch {}
  });

  return {
    getVideos: () => videos,
    getHasMore: () => hasMore,
    getPostUrls: () => [...postUrls],
    reset: () => {
      videos.length = 0;
      seenAwemeIds.clear();
      hasMore = false;
    },
  };
}
