import { describe, it, expect } from "vitest";
import { renderTree, type TreeNode } from "./tree-renderer.ts";

describe("renderTree", () => {
  it("renders a single root node", () => {
    const nodes: TreeNode[] = [{ label: "[*] tests.yml" }];
    expect(renderTree(nodes)).toBe(" [*] tests.yml");
  });

  it("renders a linear chain", () => {
    const tree: TreeNode[] = [
      {
        label: "[*] tests.yml",
        children: [
          {
            label: "[job] test",
            children: [{ label: "[run] local-ci-5" }],
          },
        ],
      },
    ];
    const expected = [" [*] tests.yml", " └── [job] test", "     └── [run] local-ci-5"].join("\n");
    expect(renderTree(tree)).toBe(expected);
  });

  it("renders multiple siblings with correct connectors", () => {
    const tree: TreeNode[] = [
      {
        label: "[*] tests.yml",
        children: [
          {
            label: "[job] test",
            children: [
              {
                label: "[run] local-ci-5",
                children: [
                  { label: "[+] Set up job (1s)" },
                  { label: "[+] actions/checkout@v4 (2s)" },
                  { label: "[>] Run pnpm check (12s...)" },
                  { label: "[ ] Pending..." },
                ],
              },
            ],
          },
        ],
      },
    ];
    const expected = [
      " [*] tests.yml",
      " └── [job] test",
      "     └── [run] local-ci-5",
      "         ├── [+] Set up job (1s)",
      "         ├── [+] actions/checkout@v4 (2s)",
      "         ├── [>] Run pnpm check (12s...)",
      "         └── [ ] Pending...",
    ].join("\n");
    expect(renderTree(tree)).toBe(expected);
  });

  it("renders multiple root nodes", () => {
    const tree: TreeNode[] = [{ label: "[*] a.yml" }, { label: "[*] b.yml" }];
    const expected = [" [*] a.yml", " [*] b.yml"].join("\n");
    expect(renderTree(tree)).toBe(expected);
  });

  it("renders deep nesting with mixed siblings", () => {
    const tree: TreeNode[] = [
      {
        label: "[*] tests.yml",
        children: [
          {
            label: "[job] test",
            children: [
              {
                label: "[run] local-ci-5",
                children: [
                  { label: "[+] Set up job (1s)" },
                  {
                    label: "[>] Run pnpm check (12s...)",
                    children: [{ label: "[output] Checking 142 files..." }],
                  },
                  { label: "[ ] Pending..." },
                ],
              },
            ],
          },
        ],
      },
    ];
    const expected = [
      " [*] tests.yml",
      " └── [job] test",
      "     └── [run] local-ci-5",
      "         ├── [+] Set up job (1s)",
      "         ├── [>] Run pnpm check (12s...)",
      "         │   └── [output] Checking 142 files...",
      "         └── [ ] Pending...",
    ].join("\n");
    expect(renderTree(tree)).toBe(expected);
  });

  it("handles nodes with empty children arrays", () => {
    const tree: TreeNode[] = [
      {
        label: "root",
        children: [],
      },
    ];
    expect(renderTree(tree)).toBe(" root");
  });
});
