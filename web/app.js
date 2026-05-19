const state = {
  user: null,
  videos: [],
  visibleCount: 5,
  resultMeta: {
    requestedCount: 15,
    returnedCount: 0,
    hasMore: false,
  },
  history: [],
  imageList: [],
  imageIndex: 0,
  currentAwemeId: '',
  renderedCount: 0,
  imageScrollRafPending: false,
  touchMoveBound: false,
  loadingTimer: null,
  loadingStageTimers: [],
  detailLoading: false,
  detailLoadingTimer: null,
  lastLoadingPhrase: '',
  lastDetailLoadingPhrase: '',
  loadMoreCount: 0,
  historyPriming: false,
  activeHistoryId: '',
  openingCard: null,
  activeCommentAwemeId: '',
  commentLoadingAwemeId: '',
  commentErrorAwemeId: '',
  commentSheetOpen: false,
  commentReturnContext: null,
  commentAuthorDetailActive: false,
  videoHandlers: null,
  videoSessionId: 0,
  searching: false,
  touchStartX: 0,
  touchStartY: 0,
  homeInputScrollTop: 0,
  homeInputRestoreUntil: 0,
  currentView: 'home',
  navigationStack: ['home'],
  navigationSyncing: false,
  navigationDirection: 'forward',
  overlayNavigation: '',
};

const HISTORY_STORAGE_KEY = 'kwjz-history';
const SAMPLE_GUIDE_DONE_KEY = 'kwjz-sample-guide-done';
const viewportRoot = document.documentElement;

let viewportSyncRaf = 0;

function syncViewportVars() {
  viewportSyncRaf = 0;
  const visualViewport = window.visualViewport;
  const layoutHeight = Math.max(
    1,
    Math.round(window.innerHeight || viewportRoot.clientHeight || 0)
  );
  let viewportHeight = Math.max(
    1,
    Math.round(visualViewport?.height || layoutHeight)
  );
  let bottomGuard = visualViewport
    ? Math.max(0, Math.ceil(window.innerHeight - visualViewport.height - visualViewport.offsetTop))
    : 0;
  if (shouldUseKeyboardViewportFallback(bottomGuard, layoutHeight)) {
    bottomGuard = Math.round(layoutHeight * 0.42);
    viewportHeight = Math.max(1, layoutHeight - bottomGuard);
  }
  viewportRoot.style.setProperty('--app-vh', `${viewportHeight}px`);
  viewportRoot.style.setProperty('--app-viewport-bottom-guard', `${bottomGuard}px`);
}

function requestViewportSync() {
  if (viewportSyncRaf) return;
  viewportSyncRaf = window.requestAnimationFrame(syncViewportVars);
}

function initViewportSync() {
  syncViewportVars();
  window.addEventListener('resize', requestViewportSync, { passive: true });
  window.addEventListener('orientationchange', requestViewportSync, { passive: true });
  window.addEventListener('focusin', handleKeyboardFocusIn);
  window.addEventListener('focusout', handleKeyboardFocusOut);
  if (!window.visualViewport) return;
  window.visualViewport.addEventListener('resize', requestViewportSync, { passive: true });
  window.visualViewport.addEventListener('scroll', requestViewportSync, { passive: true });
}

initViewportSync();

const historySamples = [
  { id: 'Zlh971230', name: 'Zlh971230' },
  { id: '10058599', name: '10058599' },
];

const loadingPhraseStages = [
  [
    '正在打开主页。',
    '正在读取最近作品。',
    '可能要几秒。',
  ],
  [
    '主页还没回应。',
    '作品还在路上。',
    '再等一下，别急着重来。',
  ],
  [
    '这次有点慢。',
    '还在等内容回来。',
    '如果一直没有结果，可以稍后再试。',
  ],
];

const detailLoadingPhrases = [
  '正在打开作品。',
  '正在获取内容。',
  '正在准备播放。',
  '图片正在加载。',
  '可能要几秒。',
  '作品还在路上。',
  '再等一下，别急着重来。',
  '如果一直打不开，可以稍后再试。',
];

const $ = (id) => document.getElementById(id);

const els = {
  homeView: $('homeView'),
  loadingView: $('loadingView'),
  resultView: $('resultView'),
  searchForm: $('searchForm'),
  mobileBackBtn: $('mobileBackBtn'),
  uniqueIdInput: $('uniqueIdInput'),
  searchButton: document.querySelector('#searchForm button[type="submit"]'),
  homeError: $('homeError'),
  historySection: $('historySection'),
  historyList: $('historyList'),
  loadingText: $('loadingText'),
  backHomeBtn: $('backHomeBtn'),
  userCard: $('userCard'),
  resultSummary: $('resultSummary'),
  videoList: $('videoList'),
  resultActions: $('resultActions'),
  loadMoreBtn: $('loadMoreBtn'),

  toast: $('toast'),
  detailLoading: $('detailLoading'),
  detailLoadingText: $('detailLoadingText'),
  videoModal: $('videoModal'),
  videoSourceBadge: $('videoSourceBadge'),
  videoStage: $('videoStage'),
  videoPlayer: $('videoPlayer'),
  videoToggleBtn: $('videoToggleBtn'),
  videoToggleIcon: $('videoToggleIcon'),
  videoSeek: $('videoSeek'),
  videoTime: $('videoTime'),
  videoMuteBtn: $('videoMuteBtn'),
  videoMuteIcon: $('videoMuteIcon'),
  closeVideoBtn: $('closeVideoBtn'),
  videoCommentBtn: $('videoCommentBtn'),

  imageModal: $('imageModal'),
  imageLoading: $('imageLoading'),
  imageScroll: $('imageScroll'),
  imageCounter: $('imageCounter'),
  imageDots: $('imageDots'),
  closeImageBtn: $('closeImageBtn'),
  imageCommentBtn: $('imageCommentBtn'),
  commentSheet: $('commentSheet'),
  commentSheetBackdrop: $('commentSheetBackdrop'),
  commentSheetBody: $('commentSheetBody'),
  closeCommentSheetBtn: $('closeCommentSheetBtn'),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function post(path, data) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const error = new Error(json.error || '请求失败');
      error.status = res.status;
      error.failureKind = `http_${res.status || 'unknown'}`;
      throw error;
    }
    return json;
  }).catch((error) => {
    if (error?.status) throw error;
    if (!error?.failureKind) {
      if (error?.name === 'AbortError') {
        error.failureKind = 'network_abort';
      } else if (error?.name === 'TypeError') {
        error.failureKind = 'network_typeerror';
      } else {
        error.failureKind = 'client_unknown';
      }
    }
    throw error;
  });
}

function getJson(path) {
  return fetch(path, { cache: 'no-store' }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const error = new Error(json.error || '请求失败');
      error.status = res.status;
      error.failureKind = `http_${res.status || 'unknown'}`;
      throw error;
    }
    return json;
  }).catch((error) => {
    if (error?.status) throw error;
    if (!error?.failureKind) {
      if (error?.name === 'AbortError') {
        error.failureKind = 'network_abort';
      } else if (error?.name === 'TypeError') {
        error.failureKind = 'network_typeerror';
      } else {
        error.failureKind = 'client_unknown';
      }
    }
    throw error;
  });
}

function track(eventName, payload = {}) {
  void eventName;
  void payload;
}


function getOrCreateVisitorId() {
  const key = 'fxb-visitor-id';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = createId('v');
    localStorage.setItem(key, created);
    return created;
  } catch {
    return createId('v');
  }
}

function createId(prefix) {
  const random = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function getViewMap() {
  return {
    home: els.homeView,
    loading: els.loadingView,
    result: els.resultView,
  };
}

function getCurrentViewName() {
  const views = getViewMap();
  const active = Object.entries(views).find(([, view]) => view.classList.contains('is-visible'))
    || Object.entries(views).find(([, view]) => !view.hidden);
  return active?.[0] || state.currentView || 'home';
}

function shouldShowMobileBack(viewName = state.currentView) {
  return false;
}

function updateMobileBackButton() {
  if (!els.mobileBackBtn) return;
  els.mobileBackBtn.hidden = !shouldShowMobileBack();
}

function replaceNavigationState(view = state.currentView || 'home') {
  if (!window.history?.replaceState) return;
  window.history.replaceState({ appView: view, appOverlay: '' }, document.title);
}

function pushNavigationState(view) {
  if (!window.history?.pushState || state.navigationSyncing) return;
  const currentHistoryView = window.history.state?.appView;
  const currentHistoryOverlay = window.history.state?.appOverlay || '';
  if (currentHistoryView === view && !currentHistoryOverlay) return;
  window.history.pushState({ appView: view, appOverlay: '' }, document.title);
}

function showView(name, options = {}) {
  const { history = 'push', direction = 'forward' } = options;
  const effectiveHistory = name === 'loading' ? 'none' : history;
  const views = {
    home: els.homeView,
    loading: els.loadingView,
    result: els.resultView,
  };
  const current = Object.values(views).find((view) => view.classList.contains('is-visible'))
    || Object.values(views).find((view) => !view.hidden);
  const next = views[name];
  if (!next) return;
  state.navigationDirection = direction;
  document.body.classList.toggle('is-nav-back', direction === 'back');
  document.body.classList.toggle('is-nav-forward', direction !== 'back');
  setHomeViewScrollMode(name === 'home');
  if (current === next) {
    next.classList.add('is-visible');
    state.currentView = name;
    updateMobileBackButton();
    syncHomeStaticScroll();
    return;
  }

  Object.values(views).forEach((view) => {
    if (view !== next && view !== current) {
      view.hidden = true;
      view.classList.remove('is-visible');
    }
  });

  next.hidden = false;
  requestAnimationFrame(() => {
    if (current) current.classList.remove('is-visible');
    next.classList.add('is-visible');
  });

  if (current) {
    setTimeout(() => {
      if (!current.classList.contains('is-visible')) current.hidden = true;
    }, prefersReducedMotion() ? 0 : 760);
  }

  const shouldSnapToTop = [
  ].includes(name);
  getScrollRoot().scrollTo({ top: 0, behavior: shouldSnapToTop || prefersReducedMotion() ? 'auto' : 'smooth' });
  state.currentView = name;
  if (effectiveHistory === 'push') {
    state.navigationStack.push(name);
    pushNavigationState(name);
  } else if (effectiveHistory === 'replace') {
    state.navigationStack = [name];
    replaceNavigationState(name);
  } else if (effectiveHistory === 'back') {
    state.navigationStack.push(name);
  }
  updateMobileBackButton();
  syncHomeStaticScroll();
}

function setHomeViewScrollMode(isHomeView) {
  document.documentElement.classList.toggle('is-home-view', isHomeView);
  document.body.classList.toggle('is-home-view', isHomeView);
  if (!isHomeView) {
    document.documentElement.classList.remove('is-static-home');
    document.body.classList.remove('is-static-home');
  }
}

function syncHomeStaticScroll() {
  if (!document.body.classList.contains('is-home-view')) return;
  requestAnimationFrame(() => {
    if (!document.body.classList.contains('is-home-view')) return;
    const shellStyles = getComputedStyle(document.querySelector('.app-shell'));
    const verticalPadding = parseFloat(shellStyles.paddingTop || '0') + parseFloat(shellStyles.paddingBottom || '0');
    const availableHeight = document.querySelector('.app-shell').clientHeight - verticalPadding;
    const contentHeight = els.homeView.scrollHeight;
    const shouldLock = contentHeight <= availableHeight + 1;
    document.documentElement.classList.toggle('is-static-home', shouldLock);
    document.body.classList.toggle('is-static-home', shouldLock);
  });
}

function focusUniqueIdWithoutPageJump(event) {
  if (state.currentView !== 'home' || document.activeElement === els.uniqueIdInput) return;
  if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
  if (isIosTouchBrowser()) return;
  const root = getScrollRoot();
  const scrollTop = root.scrollTop;
  state.homeInputScrollTop = scrollTop;
  state.homeInputRestoreUntil = Date.now() + 900;
  event.preventDefault();
  els.uniqueIdInput.focus({ preventScroll: true });
  restoreHomeInputScroll();
  setTimeout(restoreHomeInputScroll, 80);
  setTimeout(restoreHomeInputScroll, 220);
  setTimeout(restoreHomeInputScroll, 520);
}

function restoreHomeInputScroll() {
  if (state.currentView !== 'home' || document.activeElement !== els.uniqueIdInput) return;
  if (Date.now() > state.homeInputRestoreUntil) return;
  const root = getScrollRoot();
  root.scrollTo({ top: state.homeInputScrollTop, behavior: 'auto' });
}

function isIosTouchBrowser() {
  return /iP(?:hone|ad|od)/.test(navigator.platform)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isTouchBrowser() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function isKeyboardTextControl(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea') return true;
  if (tagName !== 'input') return false;
  const type = (element.getAttribute('type') || 'text').toLowerCase();
  return !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
}

function isKeyboardLikelyOpen() {
  return document.documentElement.classList.contains('is-keyboard-open');
}

function shouldUseKeyboardViewportFallback(bottomGuard, layoutHeight) {
  if (!isKeyboardLikelyOpen() || !isTouchBrowser() || bottomGuard >= 80) return false;
  const screenHeight = Math.max(window.screen?.height || 0, window.screen?.availHeight || 0);
  return !screenHeight || layoutHeight / screenHeight > 0.72;
}

function handleKeyboardFocusIn(event) {
  if (!isTouchBrowser() || !isKeyboardTextControl(event.target)) return;
  document.documentElement.classList.add('is-keyboard-open');
  document.body.classList.add('is-keyboard-open');
  requestViewportSync();
  setTimeout(requestViewportSync, 80);
  setTimeout(requestViewportSync, 260);
}

function handleKeyboardFocusOut() {
  setTimeout(() => {
    if (isKeyboardTextControl(document.activeElement)) return;
    document.documentElement.classList.remove('is-keyboard-open');
    document.body.classList.remove('is-keyboard-open');
    requestViewportSync();
    setTimeout(requestViewportSync, 120);
  }, 0);
}

function setHomeInputFocused(focused) {
  document.documentElement.classList.toggle('is-home-input-focused', focused);
  document.body.classList.toggle('is-home-input-focused', focused);
}

function getOpenOverlayName() {
  if (state.commentSheetOpen) return 'comment';
  if (!els.videoModal.hidden) return 'video';
  if (!els.imageModal.hidden) return 'image';
  return '';
}

function closeOpenOverlay() {
  const overlay = getOpenOverlayName();
  if (overlay === 'comment') {
    closeCommentSheet();
    return true;
  }
  if (overlay === 'video') {
    closeVideo();
    return true;
  }
  if (overlay === 'image') {
    closeImages();
    return true;
  }
  return false;
}

function resetOverlayState() {
  closeCommentSheet(true);
  forceHideModal(els.videoModal);
  forceHideModal(els.imageModal);
  document.body.style.overflow = '';
  updateTouchMoveBinding();
}

function resetLookupFlow() {
  clearCommentReturnContext();
  state.user = null;
  state.videos = [];
  state.visibleCount = 5;
  state.renderedCount = 0;
  state.loadMoreCount = 0;
  state.currentAwemeId = '';
  resetResultState();
  els.uniqueIdInput.value = '';
  setError('');
}


function resetToHome(options = {}) {
  if (state.detailLoading) return;
  resetOverlayState();
  resetLookupFlow();
  showView('home', { history: options.history || 'replace', direction: options.direction || 'back' });
}

function pushOverlayNavigation(overlay) {
  if (!window.history?.pushState || state.navigationSyncing) return;
  if (window.history.state?.appOverlay === overlay) return;
  state.overlayNavigation = overlay;
  window.history.pushState({ appView: state.currentView || getCurrentViewName(), appOverlay: overlay }, document.title);
  updateMobileBackButton();
}

function consumeOverlayNavigation() {
  state.overlayNavigation = '';
  updateMobileBackButton();
}


function goBack(options = {}) {
  if (state.detailLoading) return;
  const { fromPopState = false } = options;

  if (closeOpenOverlay()) {
    if (!fromPopState && window.history.state?.appOverlay) {
      state.navigationSyncing = true;
      window.history.back();
      setTimeout(() => { state.navigationSyncing = false; }, 0);
    } else {
      consumeOverlayNavigation();
    }
    return;
  }


  if (!fromPopState && window.history.length > 1 && state.currentView !== 'home') {
    window.history.back();
    return;
  }

  if (state.currentView !== 'home') {
    resetToHome({ history: fromPopState ? 'none' : 'replace', direction: 'back' });
  }
}

function handleHistoryPopState(event) {
  if (state.navigationSyncing) return;
  const targetState = event.state || {};
  if (getOpenOverlayName() || targetState.appOverlay) {
    goBack({ fromPopState: true });
    return;
  }
  const targetView = targetState.appView || 'home';
  if (targetView === 'home') {
    resetToHome({ history: 'none', direction: 'back' });
    return;
  }
  showView(targetView, { history: 'none', direction: 'back' });
}

function setError(message = '') {
  els.homeError.textContent = message;
  els.homeError.hidden = !message;
}

function setSearching(searching) {
  state.searching = searching;
  els.uniqueIdInput.disabled = searching;
  els.searchButton.disabled = searching;
  els.searchButton.textContent = searching ? '别急，正在打开' : '看一眼';
}

function setConfirmingSearch(confirming) {
  els.searchForm.classList.toggle('is-confirming', confirming);
  els.searchButton.textContent = confirming ? '准备打开' : (state.searching ? '别急，正在打开' : '看一眼');
}

function shufflePhrases(phrases, avoidPhrase = '') {
  const shuffled = [...phrases];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  if (shuffled.length > 1 && shuffled[0] === avoidPhrase) {
    const swapIndex = shuffled.findIndex((phrase) => phrase !== avoidPhrase);
    if (swapIndex > 0) [shuffled[0], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[0]];
  }
  return shuffled;
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function createPhraseRotator(
  phrases,
  element,
  intervalMs,
  lastPhrase = '',
  onPhrase = () => {},
  preferredPhrase = '',
  options = {},
) {
  let queue = shufflePhrases(phrases, lastPhrase);
  if (preferredPhrase && queue.includes(preferredPhrase)) {
    queue = [preferredPhrase, ...queue.filter((phrase) => phrase !== preferredPhrase)];
  }
  let index = 0;
  const timers = new Set();
  const typewriter = options.typewriter && !prefersReducedMotion();
  const charDelayMs = options.charDelayMs || 100;
  const holdMs = options.holdMs || intervalMs;
  const fadeMs = options.fadeMs || 620;

  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const clearTimers = () => {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  };

  const next = () => {
    if (index >= queue.length) {
      queue = shufflePhrases(phrases, lastPhrase);
      index = 0;
    }
    const phrase = queue[index++] || '';
    lastPhrase = phrase;
    onPhrase(phrase);
    showPhrase(phrase);
    return phrase;
  };

  const scheduleNext = () => {
    element.classList.add('is-fading');
    later(() => {
      element.classList.remove('is-fading');
      next();
    }, typewriter ? fadeMs : intervalMs);
  };

  const showPhrase = (phrase) => {
    element.classList.remove('is-fading');
    if (!typewriter) {
      element.textContent = phrase;
      later(scheduleNext, intervalMs);
      return;
    }

    const chars = Array.from(phrase);
    element.textContent = '';
    let charIndex = 0;
    const typeNext = () => {
      element.textContent += chars[charIndex] || '';
      charIndex++;
      if (charIndex < chars.length) {
        later(typeNext, charDelayMs);
        return;
      }
      later(scheduleNext, holdMs);
    };
    typeNext();
  };

  next();
  return {
    stop: () => {
      clearTimers();
      element.classList.remove('is-fading');
    },
  };
}

function startLoadingText() {
  stopLoadingText();

  const startStage = (stageIndex) => {
    state.loadingTimer?.stop?.();
    const phrases = loadingPhraseStages[stageIndex] || loadingPhraseStages[loadingPhraseStages.length - 1];
    state.loadingTimer = createPhraseRotator(
      phrases,
      els.loadingText,
      1900,
      state.lastLoadingPhrase,
      (phrase) => {
        state.lastLoadingPhrase = phrase;
      },
      '',
      { typewriter: true, charDelayMs: 100, holdMs: 1300, fadeMs: 760 },
    );
  };

  startStage(0);
  state.loadingStageTimers = [
    setTimeout(() => startStage(1), 2000),
    setTimeout(() => startStage(2), 6000),
  ];
}

function stopLoadingText() {
  state.loadingTimer?.stop?.();
  state.loadingStageTimers.forEach((timer) => clearTimeout(timer));
  state.loadingStageTimers = [];
  state.loadingTimer = null;
}

function showDetailLoading(preferredPhrase = '') {
  state.detailLoading = true;
  updateTouchMoveBinding();
  els.detailLoading.hidden = false;
  requestAnimationFrame(() => els.detailLoading.classList.add('is-visible'));
  document.body.style.overflow = 'hidden';
  state.detailLoadingTimer?.stop?.();
  state.detailLoadingTimer = createPhraseRotator(
    detailLoadingPhrases,
    els.detailLoadingText,
    2000,
    state.lastDetailLoadingPhrase,
    (phrase) => {
      state.lastDetailLoadingPhrase = phrase;
    },
    preferredPhrase,
    { typewriter: true, charDelayMs: 100, holdMs: 1300, fadeMs: 760 },
  );
}

function hideDetailLoading() {
  state.detailLoadingTimer?.stop?.();
  state.detailLoadingTimer = null;
  state.detailLoading = false;
  updateTouchMoveBinding();
  els.detailLoading.classList.remove('is-visible');
  setTimeout(() => {
    if (!state.detailLoading) els.detailLoading.hidden = true;
    if (els.videoModal.hidden && els.imageModal.hidden) {
      document.body.style.overflow = '';
    }
    updateTouchMoveBinding();
  }, prefersReducedMotion() ? 0 : 620);
}

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function markSampleGuideDone() {
  localStorage.setItem(SAMPLE_GUIDE_DONE_KEY, '1');
}

function shouldShowHistorySamples() {
  return state.history.length === 0 && localStorage.getItem(SAMPLE_GUIDE_DONE_KEY) !== '1';
}

function saveHistory(id, user, type = 'handle') {
  const historyType = type === 'secUid' ? 'secUid' : 'handle';
  const next = state.history.filter((item) => item.id !== id || getHistoryType(item) !== historyType);
  next.unshift({
    id,
    type: historyType,
    name: user?.nickname || id,
    avatar: user?.avatar || '',
  });
  state.history = next.slice(0, 8);
  markSampleGuideDone();
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.history));
  renderHistory();
}

function writeHistory() {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.history));
  renderHistory();
}

function removeHistory(uniqueId) {
  state.history = state.history.filter((item) => item.id !== uniqueId);
  writeHistory();
}

function getHistoryType(item) {
  return item?.type === 'secUid' ? 'secUid' : 'handle';
}

function renderHistory() {
  els.historyList.innerHTML = '';
  const showSamples = shouldShowHistorySamples();
  els.historySection.hidden = state.history.length === 0 && !showSamples;

  const items = showSamples ? historySamples : state.history;
  items.forEach((item) => {
    const entry = document.createElement('div');
    entry.className = 'history-item';
    entry.classList.toggle('is-sample', showSamples);

    const searchButton = document.createElement('button');
    searchButton.className = 'history-person';
    searchButton.type = 'button';
    searchButton.dataset.action = showSamples ? 'sample-search' : 'search-history';
    searchButton.dataset.id = item.id;
    searchButton.dataset.searchType = showSamples ? 'handle' : getHistoryType(item);
    if (item.avatar) {
      const img = document.createElement('img');
      img.src = item.avatar;
      img.alt = '';
      img.loading = 'lazy';
      searchButton.appendChild(img);
    } else if (showSamples) {
      const placeholder = document.createElement('span');
      placeholder.className = 'history-avatar-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.textContent = item.name.slice(0, 1).toUpperCase();
      searchButton.appendChild(placeholder);
    }

    const name = document.createElement('span');
    name.textContent = item.name || item.id;
    searchButton.appendChild(name);

    if (showSamples) {
      const badge = document.createElement('span');
      badge.className = 'history-sample-badge';
      badge.textContent = '示例';
      searchButton.appendChild(badge);
    }

    entry.appendChild(searchButton);

    if (!showSamples) {
      const removeButton = document.createElement('button');
      removeButton.className = 'history-remove';
      removeButton.type = 'button';
      removeButton.dataset.action = 'remove-history';
      removeButton.dataset.id = item.id;
      removeButton.setAttribute('aria-label', `删除 ${item.name || item.id}`);
      removeButton.textContent = '×';
      entry.appendChild(removeButton);
    }
    entry.classList.toggle('is-active', item.id === state.activeHistoryId);

    els.historyList.appendChild(entry);
  });
  syncHomeStaticScroll();
}

function formatAwemeTime(awemeId) {
  try {
    const ts = Number(BigInt(awemeId) >> 32n);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '';
  }
}

function formatUnixTime(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeVideos(videos) {
  return (videos || []).map((video) => ({
    ...video,
    _time: formatAwemeTime(video.aweme_id),
    _cachedImages: imageUrlsOf(video),
  }));
}

function coverOf(video) {
  return video?.video?.cover?.url_list?.[0] || '';
}

function videoUrlOf(video) {
  const candidates = [
    ...(video?.video?.play_addr_h264?.url_list || []),
    ...(video?.video?.play_addr?.url_list || []),
    ...(video?.video?.bit_rate || []).flatMap((item) => item?.play_addr?.url_list || []),
  ];
  const url = candidates.find((item) => typeof item === 'string' && /^https?:\/\//.test(item));
  return url ? url.replace('ratio=720p', 'ratio=540p') : '';
}

function imageUrlsOf(video) {
  const candidates = [
    ...(video?.image_infos || []).flatMap((image) => [
      ...(image?.origin_image?.url_list || []),
      ...(image?.label_large?.url_list || []),
      ...(image?.label_thumb?.url_list || []),
    ]),
    ...(video?.images || []).flatMap((image) => [
      ...(image?.download_url_list || []),
      ...(image?.url_list || []),
    ]),
  ].filter((url) => typeof url === 'string' && /^https?:\/\//.test(url));
  return uniqueImageUrls(candidates);
}

function uniqueImageUrls(urls) {
  const seen = new Set();
  const result = [];
  urls.forEach((url) => {
    const key = imageUrlDedupeKey(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(url);
  });
  return result;
}

function imageUrlDedupeKey(url) {
  try {
    return new URL(url, window.location.href).pathname
      .replace(/^\/obj\//, '/')
      .replace(/~tplv-[^/?]+(?=\.|$)/, '');
  } catch {
    return String(url || '').split('?')[0];
  }
}

function hasDisplayCount(value) {
  if (value === null || value === undefined || value === '') return false;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0;
}

function formatDisplayCount(value) {
  if (!hasDisplayCount(value)) return '';
  const numberValue = Number(value);
  if (numberValue < 10000) return String(Math.floor(numberValue));
  const wanValue = numberValue / 10000;
  const fixed = wanValue >= 100 ? wanValue.toFixed(0) : wanValue.toFixed(1);
  return `${fixed.replace(/\.0$/, '')}万`;
}

function renderUser() {
  const avatar = state.user?.avatar
    ? `<img class="avatar" src="${escapeAttr(state.user.avatar)}" alt="" loading="eager" decoding="async">`
    : '';
  const signature = String(state.user?.signature || '').trim();
  const stats = [
    ['粉丝', state.user?.followerCount],
    ['关注', state.user?.followingCount],
    ['获赞', state.user?.totalFavorited],
  ]
    .filter(([, value]) => hasDisplayCount(value))
    .map(([label, value]) => `
      <span class="user-stat">
        <span class="user-stat-value">${escapeHtml(formatDisplayCount(value))}</span>
        <span class="user-stat-label">${escapeHtml(label)}</span>
      </span>
    `)
    .join('');
  els.userCard.innerHTML = `
    ${avatar}
    <p class="nickname">${escapeHtml(state.user?.nickname || '那个人')}</p>
    ${signature ? `<p class="signature">${escapeHtml(signature)}</p>` : ''}
    ${stats ? `<div class="user-stats" aria-label="账号统计">${stats}</div>` : ''}
  `;
}

function renderResultSummary() {
  const total = state.videos.length;
  els.resultSummary.textContent = `最近作品 · ${total} 条`;
  els.resultSummary.hidden = false;
}

function renderVideos() {
  els.videoList.classList.remove('is-waiting');
  renderResultSummary();
  const prevCount = state.renderedCount;
  if (prevCount === 0) els.videoList.innerHTML = '';
  if (state.videos.length === 0) {
    els.videoList.innerHTML = '<section class="empty-state"><p>暂时没看到内容。</p><p>到这儿先停一下。</p></section>';
    state.renderedCount = 0;
    els.resultActions.hidden = false;
    els.loadMoreBtn.hidden = true;
    els.backHomeBtn.hidden = false;
    return;
  }
  const visible = state.videos.slice(prevCount, state.visibleCount);
  const fragment = document.createDocumentFragment();

  visible.forEach((video, i) => {
    const itemIndex = prevCount + i;
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = String(video.aweme_id);
    card.style.animationDelay = `${Math.min(i, 5) * 42}ms`;

    const isImage = Number(video.aweme_type) === 68;
    const cover = coverOf(video);
    const loading = itemIndex < 2 ? 'eager' : 'lazy';
    const fetchPriority = itemIndex < 2 ? 'auto' : 'low';
    const diggCount = video.statistics?.digg_count;
    const likeText = hasDisplayCount(diggCount) ? `${formatDisplayCount(diggCount)}赞` : '';

    card.innerHTML = `
      <button class="cover-wrap" type="button" data-action="open" data-id="${escapeAttr(video.aweme_id)}">
        ${cover ? `<img class="cover" src="${escapeAttr(cover)}" alt="" loading="${loading}" decoding="async" fetchpriority="${fetchPriority}">` : ''}
        <span class="type-pill">${isImage ? '图片' : '视频'}</span>
      </button>
      <div class="card-body">
        <p class="desc">${escapeHtml(video.desc || '（没有写什么说明）')}</p>
        <div class="card-meta">
          ${video._time ? `<span class="time">${escapeHtml(video._time)}</span>` : ''}
          ${likeText ? `<span class="like-count">${escapeHtml(likeText)}</span>` : ''}
          <button class="copy-link-btn" type="button" data-action="copy" data-id="${escapeAttr(video.aweme_id)}">复制链接</button>
        </div>
      </div>
    `;

    fragment.appendChild(card);
  });

  els.videoList.appendChild(fragment);
  state.renderedCount = state.visibleCount;

  const hasMore = state.visibleCount < state.videos.length;
  renderResultSummary();
  els.resultActions.hidden = !hasMore;
  els.loadMoreBtn.hidden = !hasMore;
  els.backHomeBtn.hidden = !hasMore;
  updateLoadMoreText();
}

async function openCommentSheet() {
  if (!state.currentAwemeId || state.detailLoading) return;
  const awemeId = String(state.currentAwemeId);
  const video = state.videos.find((item) => String(item.aweme_id) === awemeId);
  if (!video) return;

  state.activeCommentAwemeId = awemeId;
  track('comment_open', {
    dyId: state.user?.uniqueId || '',
    awemeId,
    metadata: { cached: Array.isArray(video._cachedComments) },
  });
  resetCommentSheetScroll();
  showCommentSheet();
  if (Array.isArray(video._cachedComments)) {
    renderCommentSheet(video._cachedComments);
    return;
  }
  if (video._commentError) {
    renderCommentState('评论暂时没打开。稍后再试。');
    return;
  }
  renderCommentState('评论正在来。');
  await prepareDetailComments(video, { renderSheet: true });
}

async function prepareDetailComments(video, options = {}) {
  const { renderSheet = false } = options;
  const awemeId = String(video?.aweme_id || '');
  if (!awemeId) return;

  if (Array.isArray(video._cachedComments)) {
    updateDetailCommentEntry(awemeId, 'ready');
    if (renderSheet) renderCommentSheet(video._cachedComments);
    return;
  }

  updateDetailCommentEntry(awemeId, 'loading');
  try {
    const result = await post('/api/comments', { awemeId, count: 10 });
    video._cachedComments = result.comments || [];
    video._commentError = false;
    updateDetailCommentEntry(awemeId, 'ready');
    if (renderSheet && state.activeCommentAwemeId === awemeId) renderCommentSheet(video._cachedComments);
  } catch (error) {
    video._commentError = true;
    updateDetailCommentEntry(awemeId, 'error');
    if (renderSheet && state.activeCommentAwemeId === awemeId) {
      renderCommentState(error?.status === 429 ? '太频繁了，手先停一下。' : '评论暂时没打开。稍后再试。');
    }
  }
}

function updateDetailCommentEntry(awemeId, status = 'idle') {
  if (state.currentAwemeId !== String(awemeId)) return;
  state.commentLoadingAwemeId = status === 'loading' ? String(awemeId) : '';
  state.commentErrorAwemeId = status === 'error' ? String(awemeId) : '';
  const button = !els.videoModal.hidden ? els.videoCommentBtn : (!els.imageModal.hidden ? els.imageCommentBtn : null);
  hideDetailCommentEntry();
  if (!button) return;
  button.hidden = false;
  button.disabled = false;
  button.classList.toggle('is-loading', status === 'loading');
  button.classList.toggle('has-error', status === 'error');
  button.querySelector('span:last-child').textContent = status === 'loading' ? '加载中' : '评论';
}

function hideDetailCommentEntry() {
  state.commentLoadingAwemeId = '';
  state.commentErrorAwemeId = '';
  els.videoCommentBtn.hidden = true;
  els.imageCommentBtn.hidden = true;
  [els.videoCommentBtn, els.imageCommentBtn].forEach((button) => {
    button.disabled = false;
    button.classList.remove('is-loading', 'has-error');
    const label = button.querySelector('span:last-child');
    if (label) label.textContent = '评论';
  });
}

function showCommentSheet() {
  state.commentSheetOpen = true;
  els.commentSheet.hidden = false;
  pushOverlayNavigation('comment');
  requestAnimationFrame(() => els.commentSheet.classList.add('is-visible'));
}

function closeCommentSheet(immediate = false) {
  state.commentSheetOpen = false;
  state.activeCommentAwemeId = '';
  resetCommentSheetScroll();
  els.commentSheet.classList.remove('is-visible');
  if (immediate) {
    els.commentSheet.hidden = true;
    els.commentSheetBody.innerHTML = '<p class="comment-sheet-state">评论正在来。<span>只看公开能看到的。</span></p>';
    resetCommentSheetScroll();
    return;
  }
  setTimeout(() => {
    if (!state.commentSheetOpen) {
      els.commentSheet.hidden = true;
      els.commentSheetBody.innerHTML = '<p class="comment-sheet-state">评论正在来。<span>只看公开能看到的。</span></p>';
      resetCommentSheetScroll();
    }
  }, prefersReducedMotion() ? 0 : 280);
}

function renderCommentSheet(comments) {
  if (!comments?.length) {
    renderCommentState('暂时没有评论。');
    return;
  }
  els.commentSheetBody.innerHTML = `
    <div class="comment-list">
      ${comments.map(renderComment).join('')}
    </div>
  `;
  resetCommentSheetScroll();
}

function renderCommentState(message) {
  els.commentSheetBody.innerHTML = `<p class="comment-sheet-state">${escapeHtml(message)}<span>只看公开能看到的。</span></p>`;
  resetCommentSheetScroll();
}

function resetCommentSheetScroll() {
  els.commentSheetBody.scrollTop = 0;
  requestAnimationFrame(() => {
    els.commentSheetBody.scrollTop = 0;
  });
}

function renderComment(comment) {
  const user = comment.user || {};
  const handle = getValidCommentHandle(user);
  const secUid = getValidSecUid(user.secUid);
  const avatar = user.avatar
    ? `<img class="comment-avatar" src="${escapeAttr(user.avatar)}" alt="">`
    : '<span class="comment-avatar comment-avatar-empty" aria-hidden="true"></span>';
  const author = escapeHtml(user.nickname || '有人');
  const personControl = handle
    ? `<button class="comment-person" type="button" data-action="comment-user" data-search-type="handle" data-id="${escapeAttr(handle)}" title="${escapeAttr(user.signature || '')}">${avatar}<span class="comment-author">${author}</span></button>`
    : secUid
      ? `<button class="comment-person" type="button" data-action="comment-user" data-search-type="secUid" data-id="${escapeAttr(secUid)}" data-nickname="${escapeAttr(user.nickname || '')}" data-avatar="${escapeAttr(user.avatar || '')}" data-signature="${escapeAttr(user.signature || '')}" title="${escapeAttr(user.signature || '')}">${avatar}<span class="comment-author">${author}</span></button>`
      : `<span class="comment-person is-disabled">${avatar}<span class="comment-author is-disabled">${author}</span></span>`;
  return `
    <article class="comment-item">
      ${personControl}
      <div class="comment-main">
        <p class="comment-text">${escapeHtml(comment.text || '')}</p>
        <div class="comment-meta">
          ${comment.createTime ? `<span>${escapeHtml(formatUnixTime(comment.createTime))}</span>` : ''}
        </div>
      </div>
    </article>
  `;
}

function getValidCommentHandle(user) {
  const candidates = [user?.uniqueId, user?.shortId];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (isValidCommentHandle(value)) return value;
  }
  return '';
}

function isValidUniqueId(value) {
  return /^[A-Za-z0-9._-]{1,32}$/.test(String(value || '').trim());
}

function isValidCommentHandle(value) {
  return Boolean(value && value !== '0' && /^[A-Za-z0-9._-]{1,32}$/.test(value));
}

function getValidSecUid(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '0') return '';
  return /^[A-Za-z0-9._:-]{8,160}$/.test(normalized) ? normalized : '';
}

async function startSearch(forcedId, options = {}) {
  const { saveToHistory = true, fromComment = false } = options;
  if (state.searching || state.historyPriming) return;
  const uniqueId = (forcedId || els.uniqueIdInput.value).trim();
  if (!uniqueId) {
    setError('先输入 dy 号。空着我也翻不动。');
    return;
  }
  if (!isValidUniqueId(uniqueId)) {
    setError('这个 dy 号好像不对，换一个试试。');
    return;
  }

  if (!fromComment) clearCommentReturnContext();
  setError('');
  setSearching(true);
  setConfirmingSearch(true);
  resetResultState();
  const startedAt = Date.now();
  track('search_submit', {
    dyId: uniqueId,
    metadata: { source: forcedId ? 'programmatic' : 'form', fromComment },
  });
  await sleep(400);
  setConfirmingSearch(false);
  showView('loading');
  startLoadingText();

  try {
    const job = await post('/api/lookup-jobs', { uniqueId, count: 15 });
    const result = await waitForLookupJob(job);

    if (!result?.nickname) {
      const error = new Error('未找到这个 dy 号');
      error.failureKind = 'empty_lookup_payload';
      throw error;
    }

    track('search_success', {
      dyId: uniqueId,
      durationMs: Date.now() - startedAt,
      metadata: {
        returnedCount: Number(result.returnedCount) || 0,
        requestedCount: Number(result.requestedCount) || 15,
        hasMore: Boolean(result.hasMore),
      },
    });
    if (saveToHistory) saveHistory(uniqueId, result);
    await showLookupResult(result);
    state.commentAuthorDetailActive = Boolean(fromComment && state.commentReturnContext);
    updateTouchMoveBinding();
  } catch (error) {
    track('search_failed', {
      dyId: uniqueId,
      status: error?.status || 'client',
      durationMs: Date.now() - startedAt,
      metadata: { message: getSearchErrorMessage(error), fromComment, failureKind: classifySearchFailure(error) },
    });
    showView('home');
    setError(getSearchErrorMessage(error));
  } finally {
    setConfirmingSearch(false);
    setSearching(false);
    stopLoadingText();
  }
}

async function startSecUidSearch({ secUid, nickname = '', avatar = '', signature = '', saveToHistory = true, fromComment = false }) {
  if (state.searching || state.historyPriming) return;
  const normalizedSecUid = getValidSecUid(secUid);
  if (!normalizedSecUid) return;

  if (!fromComment) clearCommentReturnContext();
  setError('');
  setSearching(true);
  setConfirmingSearch(true);
  resetResultState();
  const startedAt = Date.now();
  track('search_submit', {
    dyId: normalizedSecUid,
    metadata: { searchType: 'secUid', fromComment },
  });
  await sleep(220);
  setConfirmingSearch(false);
  showView('loading');
  startLoadingText();

  try {
    const job = await post('/api/lookup-secuid-jobs', {
      secUid: normalizedSecUid,
      nickname,
      avatar,
      signature,
      count: 15,
    });
    const result = await waitForLookupJob(job);

    if (!result?.secUid) {
      const error = new Error('未找到这个人');
      error.failureKind = 'empty_secuid_payload';
      throw error;
    }
    track('search_success', {
      dyId: result.uniqueId || normalizedSecUid,
      durationMs: Date.now() - startedAt,
      metadata: {
        searchType: 'secUid',
        returnedCount: Number(result.returnedCount) || 0,
        requestedCount: Number(result.requestedCount) || 15,
        hasMore: Boolean(result.hasMore),
      },
    });
    if (saveToHistory) saveHistory(result.uniqueId || normalizedSecUid, result, result.uniqueId ? 'handle' : 'secUid');
    await showLookupResult(result);
    state.commentAuthorDetailActive = Boolean(fromComment && state.commentReturnContext);
    updateTouchMoveBinding();
  } catch (error) {
    track('search_failed', {
      dyId: normalizedSecUid,
      status: error?.status || 'client',
      durationMs: Date.now() - startedAt,
      metadata: { searchType: 'secUid', message: getSearchErrorMessage(error), fromComment, failureKind: classifySearchFailure(error) },
    });
    showView('home');
    setError(getSearchErrorMessage(error));
  } finally {
    setConfirmingSearch(false);
    setSearching(false);
    stopLoadingText();
  }
}

async function waitForLookupJob(initialJob) {
  if (initialJob?.status === 'succeeded' && initialJob.result) return initialJob.result;
  if (initialJob?.status === 'failed') {
    const error = new Error(initialJob.error || '查询失败，请稍后再试。');
    error.failureKind = 'lookup_job_failed';
    throw error;
  }
  const jobId = initialJob?.jobId;
  if (!jobId) {
    const error = new Error('查询任务创建失败，请稍后再试。');
    error.failureKind = 'lookup_job_missing';
    throw error;
  }

  const deadline = Date.now() + 90_000;
  let pollCount = 0;
  let consecutiveRateLimits = 0;
  while (Date.now() < deadline) {
    await sleep(nextLookupPollDelay(pollCount, consecutiveRateLimits));
    pollCount += 1;
    let job;
    try {
      job = await getJson('/api/lookup-jobs/' + encodeURIComponent(jobId));
      consecutiveRateLimits = 0;
    } catch (error) {
      if (error?.status === 429) {
        consecutiveRateLimits += 1;
        continue;
      }
      throw error;
    }
    if (job?.status === 'succeeded' && job.result) return job.result;
    if (job?.status === 'failed') {
      const error = new Error(job.error || '查询失败，请稍后再试。');
      error.failureKind = 'lookup_job_failed';
      throw error;
    }
  }

  const error = new Error('查询超时，请稍后再试。');
  error.failureKind = 'lookup_job_timeout';
  throw error;
}

function nextLookupPollDelay(pollCount, consecutiveRateLimits) {
  if (consecutiveRateLimits > 0) return Math.min(8000, 3000 + consecutiveRateLimits * 1500);
  if (pollCount < 3) return 1200;
  if (pollCount < 8) return 1800;
  if (pollCount < 16) return 2600;
  return 3500;
}

async function showLookupResult(result) {
  state.user = result;
  state.videos = normalizeVideos(result.videos);
  state.resultMeta = {
    requestedCount: Number(result.requestedCount) || 15,
    returnedCount: Number(result.returnedCount) || state.videos.length,
    hasMore: Boolean(result.hasMore),
  };
  state.visibleCount = Math.min(5, state.videos.length);
  state.renderedCount = 0;
  renderUser();
  prepareVideoReveal();
  showView('result');
  await sleep(500);
  renderVideos();
}

function resetResultState() {
  state.loadMoreCount = 0;
  state.renderedCount = 0;
  state.resultMeta = { requestedCount: 15, returnedCount: 0, hasMore: false };
  els.resultSummary.hidden = true;
  els.resultSummary.textContent = '';
  els.loadMoreBtn.textContent = '再看一点';
  els.resultActions.hidden = true;
  els.loadMoreBtn.hidden = true;
  els.backHomeBtn.hidden = true;
  closeCommentSheet();
  state.activeCommentAwemeId = '';
  clearOpeningState();
}

function clearCommentReturnContext() {
  state.commentReturnContext = null;
  state.commentAuthorDetailActive = false;
  updateTouchMoveBinding();
}

function prepareVideoReveal() {
  els.videoList.classList.add('is-waiting');
  els.videoList.innerHTML = '<section class="result-waiting">等一下。内容在路上。</section>';
  els.resultActions.hidden = true;
  els.loadMoreBtn.hidden = true;
  els.backHomeBtn.hidden = true;
}

function updateLoadMoreText() {
  els.loadMoreBtn.textContent = '再看一点';
}

function setOpeningState(target) {
  clearOpeningState();
  const card = target.closest('.card');
  if (!card) return;
  state.openingCard = card;
  card.classList.add('is-opening');
}

function clearOpeningState() {
  if (state.openingCard) state.openingCard.classList.remove('is-opening');
  state.openingCard = null;
}

async function openWork(awemeId, target) {
  if (state.detailLoading) return;
  const video = state.videos.find((item) => String(item.aweme_id) === String(awemeId));
  if (!video) return;

  state.currentAwemeId = awemeId;
  track('work_open', {
    dyId: state.user?.uniqueId || '',
    awemeId,
    metadata: { workType: Number(video.aweme_type) === 68 ? 'image' : 'video' },
  });
  closeCommentSheet();
  hideDetailCommentEntry();
  if (target) setOpeningState(target);

  try {
    if (Number(video.aweme_type) === 68) {
      await openImages(video);
    } else {
      await openVideo(video);
    }
  } finally {
    clearOpeningState();
  }
}

async function openVideo(video) {
  showDetailLoading('正在打开作品。');
  els.videoModal.hidden = true;
  const coverUrl = coverOf(video);
  try {
    const listVideoUrl = videoUrlOf(video);
    if (listVideoUrl && !video._cachedVideoUrl) {
      video._cachedVideoUrl = listVideoUrl;
      setVideoSourceBadge('');
    }
    if (!video._cachedVideoUrl) {
      setVideoSourceBadge('');
      const res = await post('/api/video-url', { awemeId: video.aweme_id });
      video._cachedVideoUrl = res.url || '';
    } else {
      setVideoSourceBadge('');
    }
    if (!video._cachedVideoUrl) throw new Error('没有拿到播放地址');

    hideDetailLoading();
    document.body.style.overflow = 'hidden';
    setVideoPoster(coverUrl);
    showModal(els.videoModal);
    updateDetailCommentEntry(video.aweme_id, 'idle');
    prepareDetailComments(video);
    await startVideoPlaybackWithFallback(video._cachedVideoUrl, video.aweme_id, (url) => {
      video._cachedVideoUrl = url;
    });
  } catch (error) {
    hideDetailLoading();
    await copyLink(video.aweme_id);
    showToast(getDetailErrorMessage(error, '这条暂时打不开，链接已经替你复制好了。'));
  }
}

function startVideoPlaybackWithFallback(directUrl, awemeId, onRefreshUrl = () => {}) {
  const proxyUrl = '/api/video?awemeId=' + encodeURIComponent(awemeId);
  const sessionId = ++state.videoSessionId;
  let usingProxy = false;
  let refreshedDirectUrl = false;
  let fallbackInProgress = false;

  clearVideoPlaybackHandlers();
  setVideoLoading(true);
  els.videoPlayer.pause();
  els.videoPlayer.removeAttribute('src');
  els.videoPlayer.load();
  resetVideoControls();

  const markVideoReady = () => {
    if (sessionId !== state.videoSessionId) return;
    setVideoLoading(false);
  };

  const markVideoWaiting = () => {
    if (sessionId !== state.videoSessionId) return;
    setVideoLoading(true);
  };

  const markProxyStarted = () => {
    if (sessionId !== state.videoSessionId || !usingProxy) return;
    if (!isProxyVideoSource(proxyUrl)) return;
    setVideoSourceBadge('代理播放');
  };

  const playDirect = (url) => {
    directUrl = url;
    setVideoLoading(true);
    els.videoPlayer.pause();
    els.videoPlayer.removeAttribute('src');
    els.videoPlayer.load();
    els.videoPlayer.src = directUrl;
    setVideoSourceBadge('');
    return els.videoPlayer.play().catch(() => {});
  };

  const fallbackToProxy = () => {
    if (sessionId !== state.videoSessionId || usingProxy || fallbackInProgress) return;
    if (!isCurrentVideoSource(directUrl)) return;
    fallbackInProgress = true;
    if (!refreshedDirectUrl) {
      refreshedDirectUrl = true;
      setVideoLoading(true);
      setVideoSourceBadge('直链失效，正在刷新');
      post('/api/video-url', { awemeId, refresh: true })
        .then((res) => {
          if (sessionId !== state.videoSessionId || usingProxy) return;
          const refreshedUrl = res.url || '';
          if (!refreshedUrl) throw new Error('没有拿到播放地址');
          onRefreshUrl(refreshedUrl);
          fallbackInProgress = false;
          playDirect(refreshedUrl);
        })
        .catch(() => {
          fallbackInProgress = false;
          switchToProxy();
        });
      return;
    }
    fallbackInProgress = false;
    switchToProxy();
  };

  const switchToProxy = () => {
    if (sessionId !== state.videoSessionId || usingProxy) return;
    usingProxy = true;
    setVideoLoading(true);
    setVideoSourceBadge('直链仍失败，切换代理');
    els.videoPlayer.pause();
    els.videoPlayer.removeAttribute('src');
    els.videoPlayer.load();
    els.videoPlayer.src = proxyUrl;
    els.videoPlayer.play().catch(() => {});
  };

  state.videoHandlers = { fallbackToProxy, markProxyStarted, markVideoReady, markVideoWaiting };
  els.videoPlayer.addEventListener('error', fallbackToProxy);
  els.videoPlayer.addEventListener('loadstart', markProxyStarted);
  els.videoPlayer.addEventListener('loadedmetadata', markProxyStarted);
  els.videoPlayer.addEventListener('playing', markProxyStarted);
  els.videoPlayer.addEventListener('loadeddata', markVideoReady);
  els.videoPlayer.addEventListener('canplay', markVideoReady);
  els.videoPlayer.addEventListener('playing', markVideoReady);
  els.videoPlayer.addEventListener('waiting', markVideoWaiting);

  els.videoPlayer.referrerPolicy = 'no-referrer';
  els.videoPlayer.setAttribute('referrerpolicy', 'no-referrer');
  return playDirect(directUrl);
}

function setVideoSourceBadge(source) {
  const labels = {
    '代理播放': '代理',
    '直链失效，正在刷新': '刷新中',
    '直链仍失败，切换代理': '切换中',
  };
  els.videoSourceBadge.textContent = labels[source] || source || '';
}

function setVideoPoster(url) {
  if (url) {
    els.videoPlayer.poster = url;
    return;
  }
  els.videoPlayer.removeAttribute('poster');
}

function setVideoLoading(isLoading) {
  els.videoStage.classList.toggle('is-video-loading', Boolean(isLoading));
}

function getVideoPlayerSource() {
  return els.videoPlayer.currentSrc || els.videoPlayer.src || '';
}

function isCurrentVideoSource(url) {
  return normalizeUrl(getVideoPlayerSource()) === normalizeUrl(url);
}

function isProxyVideoSource(proxyUrl) {
  return normalizeUrl(getVideoPlayerSource()) === normalizeUrl(proxyUrl);
}

function normalizeUrl(url) {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return String(url || '');
  }
}

function clearVideoPlaybackHandlers() {
  if (!state.videoHandlers) return;
  els.videoPlayer.removeEventListener('error', state.videoHandlers.fallbackToProxy);
  els.videoPlayer.removeEventListener('loadstart', state.videoHandlers.markProxyStarted);
  els.videoPlayer.removeEventListener('loadedmetadata', state.videoHandlers.markProxyStarted);
  els.videoPlayer.removeEventListener('playing', state.videoHandlers.markProxyStarted);
  els.videoPlayer.removeEventListener('loadeddata', state.videoHandlers.markVideoReady);
  els.videoPlayer.removeEventListener('canplay', state.videoHandlers.markVideoReady);
  els.videoPlayer.removeEventListener('playing', state.videoHandlers.markVideoReady);
  els.videoPlayer.removeEventListener('waiting', state.videoHandlers.markVideoWaiting);
  state.videoHandlers = null;
}

async function openImages(video) {
  showDetailLoading('正在打开图片。');
  try {
    els.imageScroll.scrollLeft = 0;
    els.imageScroll.scrollTop = 0;
    if (!video._cachedImages?.length) {
      els.imageLoading.style.display = '';
      const res = await post('/api/images', { awemeId: video.aweme_id });
      video._cachedImages = res.urls || [];
      els.imageLoading.style.display = 'none';
    }
    if (!video._cachedImages.length) throw new Error('没有图片');

    state.imageList = video._cachedImages;
    state.imageIndex = 0;
    renderImageList();
    hideDetailLoading();
    document.body.style.overflow = 'hidden';
    showModal(els.imageModal);
    updateDetailCommentEntry(video.aweme_id, 'idle');
    prepareDetailComments(video);
    resetImageScroll();
  } catch (error) {
    hideDetailLoading();
    await copyLink(video.aweme_id);
    showToast(getDetailErrorMessage(error, '这条暂时打不开，链接已经替你复制好了。'));
  }
}

function renderImageList() {
  els.imageScroll.innerHTML = '';
  resetImageScroll();
  state.imageList.forEach((url, index) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = index === 0 ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => {
      if (index === state.imageIndex) updateImageIndicators();
    }, { once: true });
    els.imageScroll.appendChild(img);
  });
  renderImageIndicators();
  updateImageIndicators();
  resetImageScroll();
}

function resetImageScroll() {
  els.imageScroll.scrollLeft = 0;
  els.imageScroll.scrollTop = 0;
  state.imageIndex = 0;
  updateImageIndicators();
  requestAnimationFrame(() => {
    els.imageScroll.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    updateImageIndicators();
  });
}

function closeVideo() {
  const wasOpen = !els.videoModal.hidden;
  closeCommentSheet();
  hideDetailCommentEntry();
  state.videoSessionId += 1;
  els.videoPlayer.pause();
  clearVideoPlaybackHandlers();
  setVideoLoading(false);
  setVideoSourceBadge('');
  els.videoPlayer.removeAttribute('referrerpolicy');
  els.videoPlayer.removeAttribute('src');
  els.videoPlayer.removeAttribute('poster');
  els.videoPlayer.load();
  resetVideoControls();
  hideModal(els.videoModal);
  if (!wasOpen) document.body.style.overflow = '';
}

function resetVideoControls() {
  els.videoSeek.value = '0';
  els.videoTime.textContent = '0:00';
  updateVideoPlayState();
  updateVideoMuteState();
}

function updateVideoPlayState() {
  const paused = els.videoPlayer.paused || els.videoPlayer.ended;
  els.videoToggleIcon.textContent = paused ? '▶' : 'Ⅱ';
  els.videoToggleBtn.setAttribute('aria-label', paused ? '播放' : '暂停');
}

function updateVideoMuteState() {
  const muted = els.videoPlayer.muted || els.videoPlayer.volume === 0;
  els.videoMuteIcon.textContent = muted ? '静音' : '声音';
  els.videoMuteBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
}

function updateVideoProgress() {
  const duration = Number(els.videoPlayer.duration) || 0;
  const current = Number(els.videoPlayer.currentTime) || 0;
  if (duration > 0) {
    els.videoSeek.value = String(Math.round((current / duration) * 1000));
    els.videoTime.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
    return;
  }
  els.videoSeek.value = '0';
  els.videoTime.textContent = formatDuration(current);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const rest = String(value % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function closeImages() {
  closeCommentSheet();
  hideDetailCommentEntry();
  hideModal(els.imageModal, () => {
    els.imageScroll.innerHTML = '';
    els.imageCounter.hidden = true;
    els.imageDots.hidden = true;
    els.imageDots.innerHTML = '';
  });
  state.imageList = [];
  state.imageIndex = 0;
}

function renderImageIndicators() {
  const count = state.imageList.length;
  els.imageDots.innerHTML = '';
  if (count <= 1) {
    els.imageCounter.hidden = true;
    els.imageDots.hidden = true;
    return;
  }
  els.imageCounter.hidden = false;
  els.imageDots.hidden = false;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('span');
    dot.className = 'image-dot';
    dot.setAttribute('aria-hidden', 'true');
    els.imageDots.appendChild(dot);
  }
}

function updateImageIndicators() {
  const count = state.imageList.length;
  if (count <= 1) return;
  const width = Math.max(1, els.imageScroll.clientWidth);
  const index = Math.min(count - 1, Math.max(0, Math.round(els.imageScroll.scrollLeft / width)));
  state.imageIndex = index;
  els.imageCounter.textContent = `${index + 1} / ${count}`;
  [...els.imageDots.children].forEach((dot, i) => {
    dot.classList.toggle('is-active', i === index);
  });
}

function showModal(modal) {
  modal.hidden = false;
  if (modal === els.videoModal) pushOverlayNavigation('video');
  if (modal === els.imageModal) pushOverlayNavigation('image');
  updateTouchMoveBinding();
  requestAnimationFrame(() => modal.classList.add('is-visible'));
}

function hideModal(modal, afterHide = () => {}) {
  const wasOpen = !modal.hidden;
  modal.classList.remove('is-visible');
  setTimeout(() => {
    if (!modal.classList.contains('is-visible')) {
      modal.hidden = true;
      afterHide();
    }
    if (els.videoModal.hidden && els.imageModal.hidden && !state.detailLoading) {
      document.body.style.overflow = '';
    }
    updateTouchMoveBinding();
  }, prefersReducedMotion() ? 0 : 680);
  if (!wasOpen && !state.detailLoading) document.body.style.overflow = '';
}

function forceHideModal(modal) {
  modal.classList.remove('is-visible');
  modal.hidden = true;
  updateTouchMoveBinding();
}

function closeDetailForSearch() {
  closeCommentSheet(true);
  hideDetailCommentEntry();
  if (!els.videoModal.hidden) closeVideo();
  if (!els.imageModal.hidden) closeImages();
  forceHideModal(els.videoModal);
  forceHideModal(els.imageModal);
  document.body.style.overflow = '';
  updateTouchMoveBinding();
}

function captureCommentReturnContext() {
  if (!state.user || !state.videos.length || !state.currentAwemeId) return null;
  const awemeId = String(state.currentAwemeId);
  const video = state.videos.find((item) => String(item.aweme_id) === awemeId);
  if (!video) return null;
  const detailKind = !els.videoModal.hidden ? 'video' : (!els.imageModal.hidden ? 'image' : '');
  if (!detailKind) return null;
  const anchor = getVideoCardAnchor(awemeId);
  return {
    user: state.user,
    videos: state.videos,
    resultMeta: state.resultMeta,
    visibleCount: state.visibleCount,
    renderedCount: state.renderedCount,
    loadMoreCount: state.loadMoreCount,
    currentAwemeId: awemeId,
    detailKind,
    imageList: [...state.imageList],
    imageIndex: state.imageIndex,
    commentScrollTop: els.commentSheetBody.scrollTop,
    listScrollY: getScrollRoot().scrollTop || 0,
    listAnchorTop: anchor?.top ?? null,
  };
}

function getVideoCardAnchor(awemeId) {
  const card = els.videoList.querySelector(`[data-id="${CSS.escape(String(awemeId))}"]`);
  if (!card) return null;
  return {
    id: String(awemeId),
    top: card.getBoundingClientRect().top,
  };
}

function restoreListAnchor(context) {
  const fallbackY = Number(context?.listScrollY) || 0;
  const anchorTop = Number(context?.listAnchorTop);
  const card = els.videoList.querySelector(`[data-id="${CSS.escape(String(context?.currentAwemeId || ''))}"]`);
  if (!card || !Number.isFinite(anchorTop)) {
    getScrollRoot().scrollTo({ top: fallbackY, behavior: 'auto' });
    return;
  }
  const currentTop = card.getBoundingClientRect().top;
  const root = getScrollRoot();
  const nextY = Math.max(0, (root.scrollTop || 0) + currentTop - anchorTop);
  root.scrollTo({ top: nextY, behavior: 'auto' });
}

function canReturnToCommentContext() {
  return Boolean(
    state.commentReturnContext &&
    state.commentAuthorDetailActive &&
    !state.detailLoading &&
    els.videoModal.hidden &&
    els.imageModal.hidden &&
    !els.resultView.hidden
  );
}

async function restoreCommentReturnContext() {
  const context = state.commentReturnContext;
  if (!context) return;

  clearCommentReturnContext();
  closeCommentSheet(true);
  closeVideo();
  closeImages();

  state.user = context.user;
  state.videos = context.videos;
  state.resultMeta = context.resultMeta || { requestedCount: 15, returnedCount: state.videos.length, hasMore: false };
  state.visibleCount = context.visibleCount;
  state.renderedCount = 0;
  state.loadMoreCount = context.loadMoreCount;
  state.currentAwemeId = context.currentAwemeId;
  renderUser();
  els.videoList.innerHTML = '';
  els.videoList.classList.remove('is-waiting');
  renderVideos();
  showView('result');
  requestAnimationFrame(() => {
    restoreListAnchor(context);
    requestAnimationFrame(() => {
      restoreListAnchor(context);
    });
  });

  const video = state.videos.find((item) => String(item.aweme_id) === String(context.currentAwemeId));
  if (!video) return;

  document.body.style.overflow = 'hidden';
  if (context.detailKind === 'image') {
    const images = context.imageList.length ? context.imageList : (video._cachedImages || []);
    if (images.length) {
      video._cachedImages = images;
      state.imageList = images;
      renderImageList();
      state.imageIndex = Math.min(context.imageIndex, images.length - 1);
      showModal(els.imageModal);
      requestAnimationFrame(() => {
        els.imageScroll.scrollTo({ left: els.imageScroll.clientWidth * state.imageIndex, top: 0, behavior: 'auto' });
        updateImageIndicators();
      });
    }
  } else {
    setVideoPoster(coverOf(video));
    showModal(els.videoModal);
    if (video._cachedVideoUrl) {
      await startVideoPlaybackWithFallback(video._cachedVideoUrl, video.aweme_id, (url) => {
        video._cachedVideoUrl = url;
      });
    }
  }

  updateDetailCommentEntry(context.currentAwemeId, video._cachedComments || []);
  if (video._cachedComments?.length) {
    state.activeCommentAwemeId = context.currentAwemeId;
    showCommentSheet();
    renderCommentSheet(video._cachedComments);
    requestAnimationFrame(() => {
      els.commentSheetBody.scrollTop = context.commentScrollTop;
    });
  }
}

function copyLink(awemeId) {
  const url = `https://m.douyin.com/share/video/${awemeId}`;
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(url).catch(() => fallbackCopy(url));
  }
  return fallbackCopy(url);
}

function fallbackCopy(text) {
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 1400);
}

function getSearchErrorMessage(error) {
  if (error?.status === 429) return '太频繁了，手先停一下。';
  if (error?.status === 400) return '这个 dy 号好像不对，换一个试试。';
  if (error?.status === 404) return '没打开。可能是 dy 号不对，或这一页暂时不让看。';
  return '这次没取到内容。缓一下再试。';
}

function classifySearchFailure(error) {
  if (error?.failureKind) return String(error.failureKind);
  if (error?.status) return `http_${error.status}`;
  return 'client_unknown';
}

function getDetailErrorMessage(error, fallback) {
  if (error?.status === 429) return '太频繁了，手先停一下。';
  if (error?.status === 400) return '这条暂时打不开，链接已经替你复制好了。';
  if (error?.status === 504 || String(error?.message || '').includes('超时')) return '这条暂时打不开，链接已经替你复制好了。';
  if (
    String(error?.message || '').includes('未找到视频地址') ||
    String(error?.message || '').includes('视频地址失效') ||
    String(error?.message || '').includes('没有拿到播放地址')
  ) {
    return '这条暂时打不开，链接已经替你复制好了。';
  }
  return fallback;
}

function goHome(options = {}) {
  if (state.detailLoading) return;
  resetToHome(options);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function getScrollRoot() {
  return document.querySelector('.app-shell') || document.scrollingElement || document.documentElement;
}

function shouldAllowImagePan(target, dx) {
  if (els.imageModal.hidden) return false;
  const scroller = target.closest?.('.image-scroll');
  if (!scroller) return false;
  const maxLeft = scroller.scrollWidth - scroller.clientWidth;
  if (maxLeft <= 0) return false;
  if (dx > 0 && scroller.scrollLeft <= 0) return false;
  if (dx < 0 && scroller.scrollLeft >= maxLeft - 1) return false;
  return true;
}

function handleTouchStart(event) {
  const touch = event.touches?.[0];
  if (!touch) return;
  state.touchStartX = touch.clientX;
  state.touchStartY = touch.clientY;
}

function handleTouchMove(event) {
  if (event.touches?.length !== 1) return;
  const touch = event.touches[0];
  const dx = touch.clientX - state.touchStartX;
  const dy = touch.clientY - state.touchStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < 3 && absY < 3) return;

  if (!els.imageModal.hidden) {
    if (event.target.closest?.('.comment-sheet-panel')) return;
    if (isRightSwipeGesture(dx, dy) && state.imageIndex === 0) {
      event.preventDefault();
      return;
    }
    if (absX > absY && shouldAllowImagePan(event.target, dx)) return;
    event.preventDefault();
    return;
  }

  if (!els.videoModal.hidden) {
    if (event.target.closest?.('.comment-sheet-panel')) return;
    if (isRightSwipeGesture(dx, dy)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    return;
  }

  if (state.detailLoading) {
    event.preventDefault();
    return;
  }

  if (canReturnToCommentContext() && isRightSwipeGesture(dx, dy)) {
    event.preventDefault();
    return;
  }

  if (absX > absY) {
    event.preventDefault();
    return;
  }

  const root = getScrollRoot();
  const atTop = root.scrollTop <= 0;
  const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
  if ((dy > 0 && atTop) || (dy < 0 && atBottom)) {
    event.preventDefault();
  }
}

function shouldBindTouchMove() {
  return state.detailLoading || !els.videoModal.hidden || !els.imageModal.hidden || canReturnToCommentContext();
}

function updateTouchMoveBinding() {
  const shouldBind = shouldBindTouchMove();
  if (shouldBind === state.touchMoveBound) return;
  state.touchMoveBound = shouldBind;
  if (shouldBind) {
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    return;
  }
  document.removeEventListener('touchmove', handleTouchMove);
}

function handleTouchEnd(event) {
  if (state.detailLoading) return;
  const touch = event.changedTouches?.[0];
  if (!touch) return;
  const dx = touch.clientX - state.touchStartX;
  const dy = touch.clientY - state.touchStartY;
  if (!isRightSwipeGesture(dx, dy)) return;

  if (!els.videoModal.hidden) {
    closeVideo();
    return;
  }

  if (!els.imageModal.hidden && state.imageIndex === 0) {
    closeImages();
    return;
  }

  if (canReturnToCommentContext()) {
    restoreCommentReturnContext();
    return;
  }

}

function isRightSwipeGesture(dx, dy) {
  return dx >= 72 && Math.abs(dx) > Math.abs(dy) * 1.4;
}

els.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startSearch();
});

els.uniqueIdInput.addEventListener('pointerdown', focusUniqueIdWithoutPageJump);
els.uniqueIdInput.addEventListener('touchstart', focusUniqueIdWithoutPageJump, { passive: false });
els.uniqueIdInput.addEventListener('focus', () => setHomeInputFocused(true));
els.uniqueIdInput.addEventListener('blur', () => setHomeInputFocused(false));
window.visualViewport?.addEventListener('resize', restoreHomeInputScroll, { passive: true });
window.visualViewport?.addEventListener('scroll', restoreHomeInputScroll, { passive: true });

els.historyList.addEventListener('click', (event) => {
  if (state.detailLoading || state.searching || state.historyPriming) return;
  const target = event.target.closest('button[data-action]');
  if (!target) return;

  const { action, id } = target.dataset;
  if (action === 'sample-search') {
    els.uniqueIdInput.value = id;
    state.historyPriming = true;
    state.activeHistoryId = id;
    renderHistory();
    setTimeout(() => {
      state.historyPriming = false;
      state.activeHistoryId = '';
      renderHistory();
      startSearch(id);
    }, 350);
  }
  if (action === 'search-history') {
    const searchType = target.dataset.searchType || 'handle';
    const historyItem = state.history.find((item) => item.id === id && getHistoryType(item) === searchType);
    track('history_search', {
      dyId: id,
      metadata: { searchType },
    });
    els.uniqueIdInput.value = searchType === 'handle' ? id : '';
    state.historyPriming = true;
    state.activeHistoryId = id;
    renderHistory();
    setTimeout(() => {
      state.historyPriming = false;
      state.activeHistoryId = '';
      renderHistory();
      if (searchType === 'secUid') {
        startSecUidSearch({
          secUid: id,
          nickname: historyItem?.name || '',
          avatar: historyItem?.avatar || '',
        });
        return;
      }
      startSearch(id);
    }, 350);
  }
  if (action === 'remove-history') {
    removeHistory(id);
    showToast('删了。');
  }
});

els.loadMoreBtn.addEventListener('click', () => {
  if (state.detailLoading) return;
  state.loadMoreCount++;
  state.visibleCount = Math.min(state.visibleCount + 5, state.videos.length);
  renderVideos();
});

els.backHomeBtn.addEventListener('click', () => {
  goHome();
});

els.mobileBackBtn.addEventListener('click', goBack);

els.videoList.addEventListener('click', async (event) => {
  if (state.detailLoading) return;
  const target = event.target.closest('button[data-action]');
  if (!target) return;

  const { action, id } = target.dataset;
  if (action === 'open') await openWork(id, target);
  if (action === 'copy') {
    await copyLink(id);
    track('copy_link', {
      dyId: state.user?.uniqueId || '',
      awemeId: id,
    });
    showToast('作品链接复制好了，可以换个地方打开看');
  }
});

els.videoList.addEventListener('error', (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover')) return;
  img.removeAttribute('src');
  img.hidden = true;
}, true);

els.closeVideoBtn.addEventListener('click', () => {
  if (state.detailLoading) return;
  goBack();
});

els.videoCommentBtn.addEventListener('click', openCommentSheet);
els.imageCommentBtn.addEventListener('click', openCommentSheet);
els.closeCommentSheetBtn.addEventListener('click', goBack);
els.commentSheetBackdrop.addEventListener('click', goBack);
els.commentSheetBody.addEventListener('click', async (event) => {
  const target = event.target.closest('button[data-action="comment-user"]');
  if (!target) return;
  const nextId = String(target.dataset.id || '').trim();
  if (!nextId) return;
  const searchType = target.dataset.searchType || 'handle';
  state.commentReturnContext = captureCommentReturnContext();
  updateTouchMoveBinding();
  closeDetailForSearch();
  if (searchType === 'secUid') {
    await startSecUidSearch({
      secUid: nextId,
      nickname: target.dataset.nickname || '',
      avatar: target.dataset.avatar || '',
      signature: target.dataset.signature || '',
      saveToHistory: false,
      fromComment: true,
    });
    return;
  }
  if (!isValidCommentHandle(nextId)) return;
  els.uniqueIdInput.value = nextId;
  await startSearch(nextId, { saveToHistory: false, fromComment: true });
});

els.videoToggleBtn.addEventListener('click', () => {
  if (els.videoPlayer.paused || els.videoPlayer.ended) {
    els.videoPlayer.play().catch(() => {});
    return;
  }
  els.videoPlayer.pause();
});

els.videoMuteBtn.addEventListener('click', () => {
  els.videoPlayer.muted = !els.videoPlayer.muted;
  updateVideoMuteState();
});

els.videoSeek.addEventListener('input', () => {
  const duration = Number(els.videoPlayer.duration) || 0;
  if (duration <= 0) return;
  els.videoPlayer.currentTime = (Number(els.videoSeek.value) / 1000) * duration;
  updateVideoProgress();
});

els.videoPlayer.addEventListener('click', () => {
  if (els.videoPlayer.paused || els.videoPlayer.ended) {
    els.videoPlayer.play().catch(() => {});
    return;
  }
  els.videoPlayer.pause();
});

els.videoPlayer.addEventListener('play', updateVideoPlayState);
els.videoPlayer.addEventListener('pause', updateVideoPlayState);
els.videoPlayer.addEventListener('ended', updateVideoPlayState);
els.videoPlayer.addEventListener('loadedmetadata', updateVideoProgress);
els.videoPlayer.addEventListener('durationchange', updateVideoProgress);
els.videoPlayer.addEventListener('timeupdate', updateVideoProgress);
els.videoPlayer.addEventListener('volumechange', updateVideoMuteState);

els.imageScroll.addEventListener('scroll', () => {
  if (state.imageScrollRafPending) return;
  state.imageScrollRafPending = true;
  requestAnimationFrame(() => {
    state.imageScrollRafPending = false;
    updateImageIndicators();
  });
}, { passive: true });

els.closeImageBtn.addEventListener('click', () => {
  if (state.detailLoading) return;
  goBack();
});

document.addEventListener('keydown', (event) => {
  if (state.detailLoading) return;
  if (event.key === 'Escape') {
    if (state.commentSheetOpen) {
      closeCommentSheet();
      return;
    }
    closeVideo();
    closeImages();
  }
  if (!els.imageModal.hidden && event.key === 'ArrowLeft') {
    els.imageScroll.scrollBy({ left: -els.imageScroll.clientWidth * 0.8, behavior: 'smooth' });
  }
  if (!els.imageModal.hidden && event.key === 'ArrowRight') {
    els.imageScroll.scrollBy({ left: els.imageScroll.clientWidth * 0.8, behavior: 'smooth' });
  }
});

document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd, { passive: true });
window.addEventListener('popstate', handleHistoryPopState);
window.addEventListener('resize', syncHomeStaticScroll);

state.history = readHistory();
if (state.history.length > 0) markSampleGuideDone();
renderHistory();
els.homeView.classList.add('is-visible');
setHomeViewScrollMode(true);
state.currentView = 'home';
replaceNavigationState('home');
updateMobileBackButton();
syncHomeStaticScroll();
track('page_view', {
  metadata: {
    title: document.title,
  },
});
