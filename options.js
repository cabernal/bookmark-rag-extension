const DEFAULT_SETTINGS = {
  topK: 12,
  vectorWeight: 0.75,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
};

const apiKeyEl = document.getElementById('apiKey');
const endpointEl = document.getElementById('endpoint');
const modelEl = document.getElementById('model');
const topKEl = document.getElementById('topK');
const vectorWeightEl = document.getElementById('vectorWeight');
const saveBtn = document.getElementById('saveBtn');
const reindexBtn = document.getElementById('reindexBtn');
const statusEl = document.getElementById('status');
const indexProgressEl = document.getElementById('indexProgress');
const indexProgressBarEl = document.getElementById('indexProgressBar');

function setStatus(text) {
  statusEl.textContent = text;
}

function updateIndexProgress(status) {
  const running = Boolean(status?.running);
  if (!running) {
    indexProgressEl.classList.remove('active');
    indexProgressBarEl.style.width = '0%';
    return;
  }

  const total = Number(status.progressTotal || 0);
  const done = Number(status.progressDone || 0);
  const ratio = total > 0 ? done / total : Number(status.progressPct || 0);
  const pct = Math.max(2, Math.min(100, Math.round(ratio * 100)));

  indexProgressEl.classList.add('active');
  indexProgressBarEl.style.width = `${pct}%`;
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!response?.ok) return;

  const s = response.status;
  updateIndexProgress(s);
  setStatus(
    [
      `Indexed docs: ${s.totalDocs ?? 0}`,
      `Last indexed: ${s.lastIndexedAt ? new Date(s.lastIndexedAt).toLocaleString() : 'never'}`,
      `Last reason: ${s.lastIndexReason || 'n/a'}`,
      `Running: ${s.running ? `yes (${s.progressDone || 0}/${s.progressTotal || 0})` : 'no'}`,
      `Content indexed: ${s.contentLastIndexedAt ? new Date(s.contentLastIndexedAt).toLocaleString() : 'never'}`,
      `Content reason: ${s.lastContentIndexReason || 'n/a'}`,
      `Content running: ${s.contentRunning ? `yes (${s.contentProgressDone || 0}/${s.contentProgressTotal || 0})` : 'no'}`,
      `Content error: ${s.contentLastError || 'none'}`,
      `Last error: ${s.lastError || 'none'}`,
    ].join('\n')
  );
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

  apiKeyEl.value = settings.apiKey;
  endpointEl.value = settings.endpoint;
  modelEl.value = settings.model;
  topKEl.value = settings.topK;
  vectorWeightEl.value = settings.vectorWeight;
  await refreshStatus();
}

async function saveSettings() {
  const settings = {
    apiKey: apiKeyEl.value.trim(),
    endpoint: endpointEl.value.trim(),
    model: modelEl.value.trim(),
    topK: Number(topKEl.value || DEFAULT_SETTINGS.topK),
    vectorWeight: Number(vectorWeightEl.value || DEFAULT_SETTINGS.vectorWeight),
  };

  await chrome.storage.local.set({ settings });
  setStatus('Settings saved.');
}

async function reindex() {
  setStatus('Reindexing started...');
  const response = await chrome.runtime.sendMessage({ type: 'REINDEX' });

  if (!response?.ok) {
    setStatus(response?.error || 'Reindex failed.');
    return;
  }

  setStatus('Reindex started in background. Results may be incomplete until indexing finishes.');
  await refreshStatus();
}

saveBtn.addEventListener('click', () => {
  saveSettings().catch((err) => setStatus(String(err?.message || err)));
});

reindexBtn.addEventListener('click', () => {
  reindex().catch((err) => setStatus(String(err?.message || err)));
});

loadSettings().catch((err) => setStatus(String(err?.message || err)));

setInterval(() => {
  refreshStatus().catch(() => {});
}, 1000);
