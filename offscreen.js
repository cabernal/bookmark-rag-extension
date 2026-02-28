import { env, pipeline } from './vendor/transformers/transformers.min.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;

const wasmBase = chrome.runtime.getURL('vendor/transformers/');
env.backends.onnx.wasm.wasmPaths = wasmBase;

let embedderPromise = null;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', MODEL_ID);
  }
  return embedderPromise;
}

function tensorToVectors(tensor, itemCount) {
  const data = Array.from(tensor.data || []);
  const dims = tensor.dims || [];

  if (itemCount === 1 && dims.length === 1) {
    return [data];
  }

  if (dims.length === 2) {
    const rows = dims[0];
    const cols = dims[1];
    const vectors = [];
    for (let row = 0; row < rows; row += 1) {
      const start = row * cols;
      vectors.push(data.slice(start, start + cols));
    }
    return vectors;
  }

  if (itemCount > 0) {
    const width = Math.floor(data.length / itemCount);
    const vectors = [];
    for (let row = 0; row < itemCount; row += 1) {
      const start = row * width;
      vectors.push(data.slice(start, start + width));
    }
    return vectors;
  }

  return [];
}

async function embedTexts(texts) {
  const embedder = await getEmbedder();
  const tensor = await embedder(texts, {
    pooling: 'mean',
    normalize: true,
  });

  return tensorToVectors(tensor, texts.length);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'EMBED_TEXTS') {
    return false;
  }

  (async () => {
    const texts = Array.isArray(message.texts)
      ? message.texts.map((x) => String(x || ''))
      : [];

    if (!texts.length) {
      sendResponse({ ok: true, embeddings: [] });
      return;
    }

    const embeddings = await embedTexts(texts);
    sendResponse({ ok: true, embeddings });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});
