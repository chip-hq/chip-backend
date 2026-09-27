/**
 * Minimal line diff (no dependencies). Used by the code-review flow:
 * the dashboard IDE paints removed lines red / added lines green, and
 * Claude reads the same diff through get_code_diff.
 *
 * Returns a flat op list: { type: 'same'|'del'|'add', oldNo, newNo, text }
 * plus { added, removed } counts.
 */

export function diffLines(oldText, newText, { maxCells = 4_000_000 } = {}) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');

  // Common prefix / suffix never enter the DP table.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const ops = [];

  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'same', oldNo: i + 1, newNo: i + 1, text: a[i] });
  }

  if (midA.length === 0) {
    midB.forEach((text, i) => ops.push({ type: 'add', oldNo: null, newNo: prefix + i + 1, text }));
  } else if (midB.length === 0) {
    midA.forEach((text, i) => ops.push({ type: 'del', oldNo: prefix + i + 1, newNo: null, text }));
  } else if (midA.length * midB.length > maxCells) {
    // Huge rewrite — report as block replace instead of exploding memory.
    midA.forEach((text, i) => ops.push({ type: 'del', oldNo: prefix + i + 1, newNo: null, text }));
    midB.forEach((text, i) => ops.push({ type: 'add', oldNo: null, newNo: prefix + i + 1, text }));
  } else {
    // LCS DP over the changed middle only.
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    const at = (i, j) => dp[i * (m + 1) + j];
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = midA[i] === midB[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    let oldNo = prefix + 1;
    let newNo = prefix + 1;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'same', oldNo, newNo, text: midA[i] });
        i++; j++; oldNo++; newNo++;
      } else if (at(i + 1, j) >= at(i, j + 1)) {
        ops.push({ type: 'del', oldNo, newNo: null, text: midA[i] });
        i++; oldNo++;
      } else {
        ops.push({ type: 'add', oldNo: null, newNo, text: midB[j] });
        j++; newNo++;
      }
    }
    while (i < n) {
      ops.push({ type: 'del', oldNo, newNo: null, text: midA[i] });
      i++; oldNo++;
    }
    while (j < m) {
      ops.push({ type: 'add', oldNo: null, newNo, text: midB[j] });
      j++; newNo++;
    }
  }

  const tailStartOld = a.length - suffix;
  const tailStartNew = b.length - suffix;
  for (let k = 0; k < suffix; k++) {
    ops.push({ type: 'same', oldNo: tailStartOld + k + 1, newNo: tailStartNew + k + 1, text: a[tailStartOld + k] });
  }

  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.type === 'add') added++;
    if (o.type === 'del') removed++;
  }
  return { ops, added, removed };
}

/** Compact unified-style text for chat/Claude consumption. */
export function diffToText(diff, { context = 2 } = {}) {
  const lines = [];
  const ops = diff.ops;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type !== 'same') {
      for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
    }
  });
  let lastKept = -2;
  ops.forEach((o, i) => {
    if (!keep[i]) return;
    if (i - lastKept > 1) lines.push('…');
    lastKept = i;
    const no = o.type === 'add' ? `+${o.newNo}` : o.type === 'del' ? `-${o.oldNo}` : ` ${o.oldNo}`;
    const sign = o.type === 'add' ? '+' : o.type === 'del' ? '-' : ' ';
    lines.push(`${no} ${sign} ${o.text}`);
  });
  if (lines.length === 0) lines.push('(no changes)');
  return `+${diff.added} added, -${diff.removed} removed\n` + lines.join('\n');
}
