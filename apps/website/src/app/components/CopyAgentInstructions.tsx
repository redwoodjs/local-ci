"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

const AGENT_INSTRUCTIONS = `## CI

Install the local-ci skill (one-time setup):

\`\`\`bash
npx skills add redwoodjs/local-ci --skill local-ci
\`\`\`

Before completing any work, run the \`local-ci\` skill to validate your changes locally. If it fails, fix the issue and re-run. Do not report work as done until it passes.`;

export function CopyAgentInstructions() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(AGENT_INSTRUCTIONS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-2 px-4 py-2 bg-[#161b18] border border-[#3f6f5e] text-[#9bc5b3] hover:bg-[#243c34] hover:text-[#e0eee5] transition-all rounded-sm font-mono text-sm uppercase tracking-wider"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied!" : "Copy agent instructions"}
    </button>
  );
}
