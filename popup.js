const PAGE_SIZE = 12;

const queryInput = document.getElementById('query');
const searchBtn = document.getElementById('searchBtn');
const askBtn = document.getElementById('askBtn');
const resultsList = document.getElementById('results');
const resultsCountEl = document.getElementById('resultsCount');
const answerBox = document.getElementById('answer');
const statusEl = document.getElementById('status');
const indexProgressEl = document.getElementById('indexProgress');
const indexProgressBarEl = document.getElementById('indexProgressBar');
const contentIndexProgressEl = document.getElementById('contentIndexProgress');
const contentIndexProgressBarEl = document.getElementById('contentIndexProgressBar');
const indexWarningEl = document.getElementById('indexWarning');
const contentIndexWarningEl = document.getElementById('contentIndexWarning');
const popupPort = chrome.runtime.connect({ name: 'popup-status' });

let activeQuery = '';
let loadedCount = 0;
let totalCount = 0;
let isLoadingPage = false;
let searchSeq = 0;

window.addEventListener('unload', () => {
  try {
    popupPort.disconnect();
  } catch {
    // No-op if already disconnected.
  }
});

function setStatus(text) {
  statusEl.textContent = text;
}

function setResultsCount(total) {
  resultsCountEl.textContent = `(${total})`;
}

function formatScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.000';
  return n.toFixed(3);
}

function updateProgressBar(el, barEl, running, done, total, ratioFallback = 0) {
  if (!running) {
    el.classList.remove('active');
    barEl.style.width = '0%';
    return;
  }

  const ratio = total > 0 ? done / total : Number(ratioFallback || 0);
  const pct = Math.max(2, Math.min(100, Math.round(ratio * 100)));
  el.classList.add('active');
  barEl.style.width = `${pct}%`;
}

function updateIndexProgress(status) {
  const bookmarkRunning = Boolean(status?.running);
  const contentRunning = Boolean(status?.contentRunning);
  indexWarningEl.hidden = !bookmarkRunning;
  contentIndexWarningEl.hidden = !contentRunning;

  if (!bookmarkRunning) {
    indexProgressEl.classList.remove('active');
    indexProgressBarEl.style.width = '0%';
  }

  if (!contentRunning) {
    contentIndexProgressEl.classList.remove('active');
    contentIndexProgressBarEl.style.width = '0%';
  }

  updateProgressBar(
    indexProgressEl,
    indexProgressBarEl,
    bookmarkRunning,
    Number(status.progressDone || 0),
    Number(status.progressTotal || 0),
    Number(status.progressPct || 0)
  );

  updateProgressBar(
    contentIndexProgressEl,
    contentIndexProgressBarEl,
    contentRunning,
    Number(status.contentProgressDone || 0),
    Number(status.contentProgressTotal || 0),
    Number(status.contentProgressPct || 0)
  );
}

async function refreshIndexStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (response?.ok) {
    updateIndexProgress(response.status);
  }
}

function renderResults(results, { append }) {
  if (!append) {
    resultsList.innerHTML = '';
  }

  for (const item of results) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = item.title || item.url;

    const meta = document.createElement('div');
    meta.style.fontSize = '11px';
    meta.style.color = '#475569';
    meta.textContent = `score=${formatScore(item.score)} | v=${formatScore(item.vectorScore)} | l=${formatScore(item.lexicalScore)} | ${item.folderPath || '/'}`;

    li.appendChild(a);
    li.appendChild(meta);
    resultsList.appendChild(li);
  }
}

function hasMoreResults() {
  return loadedCount < totalCount;
}

function updateSearchStatus() {
  if (totalCount === 0) {
    setStatus('No results.');
    return;
  }

  const base = `Showing ${loadedCount} of ${totalCount} results.`;
  if (!indexWarningEl.hidden || !contentIndexWarningEl.hidden) {
    const flags = [];
    if (!indexWarningEl.hidden) flags.push('bookmark metadata indexing');
    if (!contentIndexWarningEl.hidden) flags.push('bookmark content indexing');
    setStatus(`${base} ${flags.join(' and ')} in progress.`);
    return;
  }

  setStatus(base);
}

async function fetchResultsPage({ query, offset, append, seq }) {
  if (isLoadingPage) return;
  isLoadingPage = true;

  if (!append) {
    setStatus('Searching...');
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEARCH_BOOKMARKS',
      query,
      offset,
      limit: PAGE_SIZE,
    });

    if (seq !== searchSeq) return;

    if (!response?.ok) {
      setStatus(response?.error || 'Search failed.');
      return;
    }

    const page = response.results || [];
    if (!append) {
      loadedCount = 0;
    }

    renderResults(page, { append });
    loadedCount += page.length;
    totalCount = Number(response.totalCount || 0);
    setResultsCount(totalCount);
    updateIndexProgress({
      running: response.indexing,
      contentRunning: response.contentIndexing,
    });
    updateSearchStatus();

    if (!append && hasMoreResults() && resultsList.scrollHeight <= resultsList.clientHeight) {
      queueMicrotask(() => {
        loadMoreIfNeeded().catch((err) => setStatus(String(err?.message || err)));
      });
    }
  } finally {
    isLoadingPage = false;
  }
}

async function runSearch() {
  const query = queryInput.value.trim();
  searchSeq += 1;
  const seq = searchSeq;

  activeQuery = query;
  loadedCount = 0;
  totalCount = 0;
  setResultsCount(0);

  if (!query) {
    resultsList.innerHTML = '';
    setStatus('Enter a query.');
    return;
  }

  await fetchResultsPage({ query, offset: 0, append: false, seq });
}

async function loadMoreIfNeeded() {
  if (!activeQuery || isLoadingPage || !hasMoreResults()) return;

  const nearBottom =
    resultsList.scrollTop + resultsList.clientHeight >= resultsList.scrollHeight - 28;

  if (!nearBottom) return;

  await fetchResultsPage({
    query: activeQuery,
    offset: loadedCount,
    append: true,
    seq: searchSeq,
  });
}

async function runAsk() {
  const query = queryInput.value.trim();
  if (!query) {
    answerBox.textContent = 'Enter a query.';
    return;
  }

  answerBox.textContent = 'Generating answer...';
  const response = await chrome.runtime.sendMessage({ type: 'ASK_RAG', query });

  if (!response?.ok) {
    answerBox.textContent = response?.error || 'RAG request failed.';
    return;
  }

  const sourceLines = (response.sources || [])
    .slice(0, 5)
    .map((s) => `[${s.rank}] ${s.title || s.url} (${s.url})`)
    .join('\n');

  answerBox.textContent = `${response.answer || ''}\n\nSources:\n${sourceLines}`;
}

searchBtn.addEventListener('click', () => {
  runSearch().catch((err) => setStatus(String(err?.message || err)));
});

askBtn.addEventListener('click', () => {
  runAsk().catch((err) => {
    answerBox.textContent = String(err?.message || err);
  });
});

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    runSearch().catch((err) => setStatus(String(err?.message || err)));
  }
});

resultsList.addEventListener('scroll', () => {
  loadMoreIfNeeded().catch((err) => setStatus(String(err?.message || err)));
});

let debounceTimer = null;
queryInput.addEventListener('input', () => {
  if (!indexWarningEl.hidden || !contentIndexWarningEl.hidden) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    runSearch().catch((err) => setStatus(String(err?.message || err)));
  }, 220);
});

setInterval(() => {
  refreshIndexStatus().catch(() => {});
}, 1000);
refreshIndexStatus().catch(() => {});
setResultsCount(0);

queryInput.focus();
