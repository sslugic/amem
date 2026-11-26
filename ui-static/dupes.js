// Group exact and near-duplicate facts so Tidy up can show "×N" and merge them.
// Pure functions, unit tested in test/ui-dupes.test.mjs.

/** Text normalized for exact-duplicate checks: case, whitespace, punctuation and a leading date. */
export function normalizeFactText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/^\s*\d{4}-\d{2}-\d{2}\s*:?\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Exact duplicates: same normalized text within the same memory (merging only works
 * inside one memory). The newest fact is kept; returns groups of 2+, biggest first.
 */
export function exactDuplicateGroups(claims) {
  const groups = new Map();
  for (const c of claims || []) {
    const norm = normalizeFactText(c.text);
    if (norm.length < 12) continue;
    const key = `${c.repo_id || ""}\u0000${norm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = [...g].sort(
        (a, b) => Number(b.pinned || 0) - Number(a.pinned || 0) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
      );
      return { keep: sorted[0], drop: sorted.slice(1), count: g.length };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Near-duplicate pairs from the hygiene report → clusters around one fact to keep.
 * Pairs that chain (A~B, B~C) end up in one cluster.
 */
export function clusterDuplicatePairs(pairs) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  const keepVotes = new Map();
  for (const p of pairs || []) {
    parent.set(find(p.dropId), find(p.keepId));
    keepVotes.set(p.keepId, (keepVotes.get(p.keepId) || 0) + 1);
  }
  const clusters = new Map();
  for (const p of pairs || []) {
    for (const id of [p.keepId, p.dropId]) {
      const root = find(id);
      if (!clusters.has(root)) clusters.set(root, { ids: new Set(), similarity: 0 });
      clusters.get(root).ids.add(id);
    }
    const c = clusters.get(find(p.keepId));
    c.similarity = Math.max(c.similarity, p.similarity || 0);
  }
  return [...clusters.values()]
    .map(({ ids, similarity }) => {
      const list = [...ids];
      const keepId = list.sort((a, b) => (keepVotes.get(b) || 0) - (keepVotes.get(a) || 0))[0];
      return { keepId, dropIds: list.filter((id) => id !== keepId), count: list.length, similarity };
    })
    .sort((a, b) => b.count - a.count);
}
