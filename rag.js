function formatContext(documents) {
  return documents
    .map((doc, index) => {
      return [
        `[${index + 1}] ${doc.title || '(untitled)'}`,
        `URL: ${doc.url}`,
        `Folder: ${doc.folderPath || '/'}`,
        `Similarity: ${doc.score.toFixed(3)}`,
      ].join('\n');
    })
    .join('\n\n');
}

function localFallbackAnswer(query, documents) {
  if (!documents.length) {
    return `No bookmark matches were found for "${query}".`;
  }

  const lines = [
    `Top bookmark matches for "${query}":`,
    ...documents.slice(0, 5).map((doc, i) => `${i + 1}. ${doc.title || doc.url} - ${doc.url}`),
  ];

  return lines.join('\n');
}

async function callOpenAI({ apiKey, model, endpoint, query, context }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a bookmark assistant. Use only the provided bookmark context. Include citation numbers like [1], [2]. If context is insufficient, say so.',
        },
        {
          role: 'user',
          content: `Question: ${query}\n\nBookmark context:\n${context}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

export async function generateAnswer({ query, documents, settings }) {
  const context = formatContext(documents);

  if (!settings.apiKey) {
    return {
      mode: 'local-fallback',
      answer: localFallbackAnswer(query, documents),
      context,
    };
  }

  const answer = await callOpenAI({
    apiKey: settings.apiKey,
    endpoint: settings.endpoint,
    model: settings.model,
    query,
    context,
  });

  return {
    mode: 'llm-rag',
    answer: answer || localFallbackAnswer(query, documents),
    context,
  };
}
