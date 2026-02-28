import { deleteDocument, getAllDocuments, getMeta, putDocuments, setMeta } from './db.js';
import { generateAnswer } from './rag.js';
import { rankDocuments } from './search.js';

const DEFAULT_SETTINGS = {
  topK: 12,
  vectorWeight: 0.75,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
};

const EMBED_BATCH_SIZE_IDLE = 8;
const EMBED_BATCH_SIZE_INTERACTIVE = 2;
const INDEX_BATCH_PAUSE_IDLE_MS = 12;
const INDEX_BATCH_PAUSE_INTERACTIVE_MS = 180;
const CONTENT_BATCH_SIZE_IDLE = 2;
const CONTENT_BATCH_SIZE_INTERACTIVE = 1;
const CONTENT_BATCH_PAUSE_IDLE_MS = 40;
const CONTENT_BATCH_PAUSE_INTERACTIVE_MS = 220;
const CONTENT_FETCH_TIMEOUT_MS = 8000;
const CONTENT_MAX_TEXT_CHARS = 2200;
const OFFSCREEN_URL = 'offscreen.html';

let indexState = {
  running: false,
  lastIndexedAt: null,
  totalDocs: 0,
  lastError: null,
  progressDone: 0,
  progressTotal: 0,
  progressPct: 0,
  currentReason: null,
  contentRunning: false,
  contentLastIndexedAt: null,
  contentLastError: null,
  contentProgressDone: 0,
  contentProgressTotal: 0,
  contentProgressPct: 0,
  contentCurrentReason: null,
};

let createOffscreenPromise = null;
let activePopupConnections = 0;

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInteractiveMode() {
  return activePopupConnections > 0;
}

function getEmbedBatchSize() {
  return isInteractiveMode() ? EMBED_BATCH_SIZE_INTERACTIVE : EMBED_BATCH_SIZE_IDLE;
}

function getIndexPauseMs() {
  return isInteractiveMode() ? INDEX_BATCH_PAUSE_INTERACTIVE_MS : INDEX_BATCH_PAUSE_IDLE_MS;
}

function getContentBatchSize() {
  return isInteractiveMode() ? CONTENT_BATCH_SIZE_INTERACTIVE : CONTENT_BATCH_SIZE_IDLE;
}

function getContentPauseMs() {
  return isInteractiveMode() ? CONTENT_BATCH_PAUSE_INTERACTIVE_MS : CONTENT_BATCH_PAUSE_IDLE_MS;
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBookmarkContentSnippet(url) {
  if (!isHttpUrl(url)) return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTENT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });

    if (!response.ok) return '';

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return '';
    }

    const raw = await response.text();
    const text = contentType.includes('text/plain') ? raw : stripHtmlToText(raw);
    return text.slice(0, CONTENT_MAX_TEXT_CHARS);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function bookmarkToDoc(bookmark, folderPath) {
  const title = bookmark.title || '';
  const url = bookmark.url || '';
  const text = `${title}\n${folderPath}\n${url}`.trim();
  const searchText = `${title} ${folderPath} ${url}`.toLowerCase();

  return {
    id: bookmark.id,
    title,
    url,
    folderPath,
    dateAdded: bookmark.dateAdded || null,
    text,
    searchText,
    embedding: null,
    contentText: '',
    contentEmbedding: null,
    contentUpdatedAt: null,
    updatedAt: Date.now(),
  };
}

function flattenBookmarkTree(nodes, currentPath = '', output = []) {
  for (const node of nodes) {
    const nextPath = node.title ? `${currentPath}/${node.title}` : currentPath;

    if (node.url) {
      output.push(bookmarkToDoc(node, currentPath || '/'));
      continue;
    }

    if (node.children?.length) {
      flattenBookmarkTree(node.children, nextPath, output);
    }
  }

  return output;
}

async function ensureOffscreenDocument() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
    return;
  }

  if (!createOffscreenPromise) {
    createOffscreenPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Run local embedding model and keep it warm for semantic bookmark search.',
      })
      .catch((error) => {
        // If it already exists on older Chrome versions without hasDocument, proceed.
        const message = String(error?.message || error);
        if (!message.toLowerCase().includes('single offscreen document')) {
          throw error;
        }
      });

    try {
      await createOffscreenPromise;
    } finally {
      createOffscreenPromise = null;
    }
  } else {
    await createOffscreenPromise;
  }
}

async function embedTexts(texts) {
  if (!texts.length) return [];

  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: 'EMBED_TEXTS',
    texts,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Embedding worker returned an unknown error.');
  }

  return response.embeddings;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setIndexMeta(totalDocs) {
  const now = Date.now();
  indexState.lastIndexedAt = now;
  indexState.totalDocs = totalDocs;
  indexState.lastError = null;
  await setMeta('lastIndexedAt', now);
  await setMeta('totalDocs', totalDocs);
}

function updateProgress({ done, total }) {
  indexState.progressDone = done;
  indexState.progressTotal = total;
  indexState.progressPct = total > 0 ? Math.min(1, done / total) : 0;
}

async function setContentIndexMeta(totalDocs) {
  const now = Date.now();
  indexState.contentLastIndexedAt = now;
  indexState.contentLastError = null;
  await setMeta('contentLastIndexedAt', now);
  await setMeta('contentLastError', null);
  await setMeta('contentIndexedDocCount', totalDocs);
}

function updateContentProgress({ done, total }) {
  indexState.contentProgressDone = done;
  indexState.contentProgressTotal = total;
  indexState.contentProgressPct = total > 0 ? Math.min(1, done / total) : 0;
}

async function runContentReindex(reason = 'manual-content') {
  if (indexState.contentRunning) return;

  indexState.contentRunning = true;
  indexState.contentLastError = null;
  indexState.contentCurrentReason = reason;
  await setMeta('contentLastError', null);

  try {
    const docs = await getAllDocuments();
    const candidates = docs.filter((doc) => isHttpUrl(doc.url));
    updateContentProgress({ done: 0, total: candidates.length });

    let done = 0;
    let cursor = 0;
    while (cursor < candidates.length) {
      const batchSize = getContentBatchSize();
      const batch = candidates.slice(cursor, cursor + batchSize);
      const snippets = await Promise.all(
        batch.map((doc) => fetchBookmarkContentSnippet(doc.url))
      );

      const textsToEmbed = [];
      const embedIndexForDoc = new Array(batch.length).fill(-1);

      for (let i = 0; i < snippets.length; i += 1) {
        const snippet = snippets[i];
        if (!snippet) continue;
        embedIndexForDoc[i] = textsToEmbed.length;
        textsToEmbed.push(snippet);
      }

      const embeddings = textsToEmbed.length ? await embedTexts(textsToEmbed) : [];

      const enriched = batch.map((doc, idx) => {
        const embedIdx = embedIndexForDoc[idx];
        return {
          ...doc,
          contentText: snippets[idx] || '',
          contentEmbedding: embedIdx >= 0 ? embeddings[embedIdx] : null,
          contentUpdatedAt: Date.now(),
        };
      });

      await putDocuments(enriched);
      done += batch.length;
      cursor += batch.length;
      updateContentProgress({ done, total: candidates.length });
      await sleep(getContentPauseMs());
    }

    await setContentIndexMeta(candidates.length);
    await setMeta('lastContentIndexReason', reason);
  } catch (error) {
    indexState.contentLastError = String(error?.message || error);
    await setMeta('contentLastError', indexState.contentLastError);
    throw error;
  } finally {
    indexState.contentRunning = false;
    indexState.contentCurrentReason = null;
    if (!indexState.contentLastError) {
      updateContentProgress({
        done: indexState.contentProgressTotal,
        total: indexState.contentProgressTotal,
      });
    }
  }
}

async function runFullReindex(reason = 'manual') {
  if (indexState.running) return;
  indexState.running = true;
  indexState.lastError = null;
  indexState.currentReason = reason;
  let shouldScheduleContent = false;
  await setMeta('lastError', null);

  try {
    const tree = await chrome.bookmarks.getTree();
    const docs = flattenBookmarkTree(tree);
    updateProgress({ done: 0, total: docs.length });
    const existingDocs = await getAllDocuments();
    const staleIds = new Set(existingDocs.map((doc) => doc.id));

    let done = 0;
    let cursor = 0;
    while (cursor < docs.length) {
      const batchSize = getEmbedBatchSize();
      const batch = docs.slice(cursor, cursor + batchSize);
      const embeddings = await embedTexts(batch.map((d) => d.text));

      const enriched = batch.map((doc, idx) => ({
        ...doc,
        embedding: embeddings[idx],
      }));

      await putDocuments(enriched);
      for (const doc of batch) {
        staleIds.delete(doc.id);
      }
      done += batch.length;
      cursor += batch.length;
      updateProgress({ done, total: docs.length });
      await sleep(getIndexPauseMs());
    }

    for (const id of staleIds) {
      await deleteDocument(id);
    }

    await setIndexMeta(docs.length);
    await setMeta('lastIndexReason', reason);
    shouldScheduleContent = true;
  } catch (error) {
    indexState.lastError = String(error?.message || error);
    await setMeta('lastError', indexState.lastError);
    throw error;
  } finally {
    indexState.running = false;
    indexState.currentReason = null;
    if (!indexState.lastError) {
      updateProgress({ done: indexState.totalDocs, total: indexState.totalDocs });
    }
    if (shouldScheduleContent) {
      scheduleContentReindex(`meta-${reason}`).catch(() => {});
    }
  }
}

let pendingReindex = null;
let pendingContentReindex = null;
let queuedContentReindexReason = null;

function scheduleReindex(reason) {
  if (pendingReindex) return pendingReindex;
  pendingReindex = (async () => {
    try {
      await runFullReindex(reason);
    } finally {
      pendingReindex = null;
    }
  })();

  return pendingReindex;
}

function scheduleContentReindex(reason) {
  if (pendingContentReindex) {
    queuedContentReindexReason = reason;
    return pendingContentReindex;
  }

  pendingContentReindex = (async () => {
    try {
      await runContentReindex(reason);
    } finally {
      pendingContentReindex = null;
      if (queuedContentReindexReason) {
        const nextReason = queuedContentReindexReason;
        queuedContentReindexReason = null;
        scheduleContentReindex(nextReason).catch(() => {});
      }
    }
  })();

  return pendingContentReindex;
}

async function ensureIndexed() {
  const totalDocs = await getMeta('totalDocs');
  if (typeof totalDocs === 'number' && totalDocs > 0) {
    return;
  }
  if (!indexState.running) {
    scheduleReindex('first-search').catch(() => {});
  }
}

async function searchBookmarks(query) {
  const settings = await getSettings();
  await ensureIndexed();

  const docs = await getAllDocuments();
  if (!docs.length) {
    return {
      results: [],
      totalCount: 0,
      indexing: indexState.running,
      contentIndexing: indexState.contentRunning,
      usedVector: false,
    };
  }

  let queryEmbedding = null;
  let vectorWeight = settings.vectorWeight;

  // Keep UI responsive during either indexing phase by skipping query embeddings until indexing settles.
  if (!indexState.running && !indexState.contentRunning) {
    try {
      [queryEmbedding] = await embedTexts([query]);
    } catch {
      queryEmbedding = null;
      vectorWeight = 0;
    }
  } else {
    vectorWeight = 0;
  }

  const ranked = rankDocuments({
    query,
    queryEmbedding,
    documents: docs,
    vectorWeight,
  });

  return {
    results: ranked.results,
    totalCount: ranked.totalCount,
    indexing: indexState.running,
    contentIndexing: indexState.contentRunning,
    usedVector: Boolean(queryEmbedding) && vectorWeight > 0,
  };
}

async function handleAskRag(query) {
  const settings = await getSettings();
  const search = await searchBookmarks(query);
  const topDocs = search.results.slice(0, settings.topK);
  const rag = await generateAnswer({ query, documents: topDocs, settings });

  return {
    ...rag,
    indexing: search.indexing,
    contentIndexing: search.contentIndexing,
    usedVector: search.usedVector,
    sources: topDocs.map((doc, idx) => ({
      rank: idx + 1,
      title: doc.title,
      url: doc.url,
      score: doc.score,
      folderPath: doc.folderPath,
    })),
  };
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleReindex('install').catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleReindex('startup').catch(() => {});
});

chrome.bookmarks.onCreated.addListener(() => {
  scheduleReindex('bookmark-created').catch(() => {});
});

chrome.bookmarks.onChanged.addListener(() => {
  scheduleReindex('bookmark-changed').catch(() => {});
});

chrome.bookmarks.onRemoved.addListener((id) => {
  deleteDocument(id).catch(() => {});
  scheduleReindex('bookmark-removed').catch(() => {});
});

chrome.bookmarks.onMoved.addListener(() => {
  scheduleReindex('bookmark-moved').catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup-status') return;
  activePopupConnections += 1;
  port.onDisconnect.addListener(() => {
    activePopupConnections = Math.max(0, activePopupConnections - 1);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'SEARCH_BOOKMARKS': {
        const query = String(message.query || '').trim();
        const offset = Math.max(0, Number(message.offset) || 0);
        const rawLimit = Number(message.limit);
        const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : null;
        if (!query) {
          sendResponse({
            ok: true,
            results: [],
            totalCount: 0,
            offset,
            limit: limit ?? 0,
            indexing: indexState.running,
            contentIndexing: indexState.contentRunning,
            usedVector: false,
          });
          return;
        }
        const search = await searchBookmarks(query);
        const pageLimit = limit ?? 12;
        const paged = search.results.slice(offset, offset + pageLimit);

        const publicResults = paged.map((doc) => ({
          id: doc.id,
          title: doc.title,
          url: doc.url,
          folderPath: doc.folderPath,
          score: doc.score,
          vectorScore: doc.vectorScore,
          lexicalScore: doc.lexicalScore,
        }));

        sendResponse({
          ok: true,
          results: publicResults,
          totalCount: search.totalCount,
          offset,
          limit: pageLimit,
          indexing: search.indexing,
          contentIndexing: search.contentIndexing,
          usedVector: search.usedVector,
        });
        return;
      }

      case 'ASK_RAG': {
        const query = String(message.query || '').trim();
        if (!query) {
          sendResponse({ ok: true, answer: 'Enter a query first.', sources: [] });
          return;
        }
        const result = await handleAskRag(query);
        sendResponse({ ok: true, ...result });
        return;
      }

      case 'REINDEX': {
        scheduleReindex('manual').catch(() => {});
        sendResponse({ ok: true, started: true });
        return;
      }

      case 'GET_STATUS': {
        const [
          lastIndexedAt,
          totalDocs,
          lastError,
          lastIndexReason,
          contentLastIndexedAt,
          contentLastError,
          lastContentIndexReason,
        ] = await Promise.all([
          getMeta('lastIndexedAt'),
          getMeta('totalDocs'),
          getMeta('lastError'),
          getMeta('lastIndexReason'),
          getMeta('contentLastIndexedAt'),
          getMeta('contentLastError'),
          getMeta('lastContentIndexReason'),
        ]);

        const resolvedTotalDocs = indexState.running
          ? indexState.progressTotal
          : typeof totalDocs === 'number'
            ? totalDocs
            : indexState.totalDocs;

        sendResponse({
          ok: true,
          status: {
            ...indexState,
            lastIndexedAt: lastIndexedAt ?? indexState.lastIndexedAt,
            totalDocs: resolvedTotalDocs,
            lastError: indexState.lastError || lastError,
            lastIndexReason: indexState.running ? indexState.currentReason : lastIndexReason,
            contentLastIndexedAt: contentLastIndexedAt ?? indexState.contentLastIndexedAt,
            contentLastError: indexState.contentLastError || contentLastError,
            lastContentIndexReason: indexState.contentRunning
              ? indexState.contentCurrentReason
              : lastContentIndexReason,
          },
        });
        return;
      }

      default:
        return;
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});
