/**
 * v0.10.1 #2：文件预览 tab title 同名 disambiguation。
 *
 * 维护者 真机：多个 `.gitignore` 在不同目录都打开时，tab title 都显示 `.gitignore`，
 * 视觉上以为"重复 tab"。VS Code / Sublime 用"最短唯一后缀"算法。
 *
 * 算法：
 * 1. 按 basename 分组
 * 2. group 内只有 1 个文件 → 显示 basename
 * 3. group 内多个文件 → 每个找最短的"后缀 segments 列表"使它在 group 内唯一
 *    显示 `basename — parent1/parent2/...`（parents 不含 basename，斜杠分隔）
 *
 * 例子：
 *   ['/tmp/.gitignore', '/tmp/aitm/.gitignore']
 *   → {
 *       '/tmp/.gitignore': '.gitignore — sheng',
 *       '/tmp/aitm/.gitignore': '.gitignore — aitm',
 *     }
 */

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 给一组 path 计算每个的 disambiguated 显示 label。
 *
 * 返回 Map<path, label>。同 basename 唯一的直接返回 basename；多个的返回
 * `basename — parents/segs`。
 */
export function disambiguateLabels(paths: string[]): Map<string, string> {
  const result = new Map<string, string>();

  // 按 basename 分组
  const groupedByBase = new Map<string, string[]>();
  for (const p of paths) {
    const base = basename(p);
    const arr = groupedByBase.get(base) ?? [];
    arr.push(p);
    groupedByBase.set(base, arr);
  }

  groupedByBase.forEach((groupPaths, base) => {
    if (groupPaths.length === 1) {
      result.set(groupPaths[0], base);
      return;
    }

    // 多个同 basename：每个找最短唯一后缀
    // segments 是 path split 后 filter 掉空段（消去前导 '/' 产生的空 element）
    const splitSegs = groupPaths.map((p) =>
      p.split(/[\\/]/).filter((s) => s.length > 0),
    );

    groupPaths.forEach((p, idx) => {
      const segs = splitSegs[idx];
      const others = splitSegs.filter((_, i) => i !== idx);
      // basename 在 segs 末尾。从 take=2 开始（basename + 1 父级）尝试，直到 unique
      let chosenSegs: string[] = segs.slice(-1); // fallback: 只 basename
      for (let take = 2; take <= segs.length; take++) {
        const candidate = segs.slice(-take);
        const candidateStr = candidate.join("/");
        const isUnique = others.every((other) => {
          const otherCandidate = other.slice(-take).join("/");
          return otherCandidate !== candidateStr;
        });
        chosenSegs = candidate;
        if (isUnique) break;
      }

      if (chosenSegs.length <= 1) {
        // 同 basename 且所有 path 完全相同（理论不应发生，path 是 dedup key）
        result.set(p, base);
      } else {
        const parents = chosenSegs.slice(0, -1).join("/");
        result.set(p, `${base} — ${parents}`);
      }
    });
  });

  return result;
}
