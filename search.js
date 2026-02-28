function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lexicalScore(qTokens, docSearchText) {
  if (!qTokens.length) return 0;
  if (!docSearchText) return 0;
  let hits = 0;
  for (const token of qTokens) {
    if (docSearchText.includes(token)) hits += 1;
  }

  return hits / qTokens.length;
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankDocuments({
  query,
  queryEmbedding,
  documents,
  limit,
  offset = 0,
  vectorWeight = 0.75,
}) {
  const lexicalWeight = 1 - vectorWeight;
  const qTokens = tokenize(query);

  const ranked = documents
    .map((doc) => {
      const docSearchText = String(doc.searchText || doc.text || '').toLowerCase();
      const lScore = lexicalScore(qTokens, docSearchText);
      const baseVector = queryEmbedding ? cosineSimilarity(queryEmbedding, doc.embedding) : 0;
      const contentVector =
        queryEmbedding && doc.contentEmbedding
          ? cosineSimilarity(queryEmbedding, doc.contentEmbedding)
          : 0;
      const vScore = contentVector > 0 ? baseVector * 0.7 + contentVector * 0.3 : baseVector;
      const combinedScore = vectorWeight * vScore + lexicalWeight * lScore;

      return {
        ...doc,
        score: combinedScore,
        lexicalScore: lScore,
        vectorScore: vScore,
      };
    })
    .sort((a, b) => b.score - a.score);

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Number(limit)) : null;
  const paged =
    safeLimit === null ? ranked.slice(safeOffset) : ranked.slice(safeOffset, safeOffset + safeLimit);

  return {
    results: paged,
    totalCount: ranked.length,
  };
}
