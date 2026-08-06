// ─── Tree Renderer ────────────────────────────────────────────────────────────
// Renders a tree structure using Unicode box-drawing characters.
//
// Example output:
//   [*] tests.yml
//   └── [job] test
//       └── [run] local-ci-5
//           ├── [+] Set up job (1s)
//           ├── [>] Run pnpm check (12s...)
//           └── [ ] Pending...

export interface TreeNode {
  label: string;
  children?: TreeNode[];
}

/**
 * Render a tree of nodes into a string with box-drawing characters.
 *
 * @param nodes    One or more root-level nodes to render.
 * @param prefix   Internal — the leading whitespace/connector for the current depth.
 * @param isRoot   Internal — whether we're rendering top-level roots (no connectors).
 */
export function renderTree(nodes: TreeNode[], prefix = "", isRoot = true): string {
  const lines: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;

    if (isRoot) {
      // Root level — no connector
      lines.push(node.label);
    } else {
      const connector = isLast ? "└── " : "├── ";
      lines.push(prefix + connector + node.label);
    }

    if (node.children && node.children.length > 0) {
      let childPrefix: string;
      if (isRoot) {
        // Children of root nodes start at the base indentation
        childPrefix = "";
      } else {
        childPrefix = isLast ? prefix + "    " : prefix + "│   ";
      }
      lines.push(renderTree(node.children, childPrefix, false));
    }
  }

  const result = lines.filter((l) => l.length > 0).join("\n");
  // Add 1-space left padding only at the top-level call
  if (isRoot) {
    return result
      .split("\n")
      .map((l) => ` ${l}`)
      .join("\n");
  }
  return result;
}
