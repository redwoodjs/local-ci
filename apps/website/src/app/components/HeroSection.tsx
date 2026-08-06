import { Panel } from "./Panel";
import { CopyAgentInstructions } from "./CopyAgentInstructions";
import { Play as PlayIcon } from "lucide-react";

export function HeroSection() {
  return (
    <div className="grid lg:grid-cols-2 gap-16 items-center mb-32 mt-8">
      <div className="animate-fade-in-up">
        <h2 className="text-5xl lg:text-7xl font-bold tracking-tight mb-6 text-[#f2f7f4] leading-[1.1] font-serif">
          Run GitHub Actions on your machine.
        </h2>
        <p className="text-xl text-[#9bc5b3] mb-8 leading-relaxed font-sans max-w-xl">
          Caching in ~0 ms. Pause on failure. Let your AI agent fix it and retry — without pushing.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 mb-8">
          <a
            href="#quick-start"
            className="flex items-center justify-center gap-2 px-6 py-3 bg-[#528b76] text-[#0d110f] hover:bg-[#71a792] font-mono font-bold uppercase tracking-wider rounded-sm transition-colors shadow-[0_0_15px_rgba(82,139,118,0.4)]"
          >
            <PlayIcon size={18} />
            Quick start
          </a>
          <CopyAgentInstructions />
        </div>
      </div>

      <div className="animate-fade-in-scale relative">
        <Panel title="local-ci-terminal" glow className="flex flex-col">
          <div className="font-mono text-sm text-[#9bc5b3] space-y-2 flex-1 overflow-y-auto">
            <p>
              <span className="text-[#528b76]">❯</span> npx run-local-ci run --workflow
              .github/workflows/ci.yml
            </p>
            <p className="text-[#71a792]">Initializing local runner environment...</p>
            <p className="text-[#71a792]">Mounting local workspace: /Users/dev/project</p>
            <p className="text-[#71a792]">Starting job: test-and-build</p>
            <br />
            <p>✓ Run actions/checkout@v4 (0s)</p>
            <p>✓ Run actions/setup-node@v4 (0s)</p>
            <p>✓ Run npm install (0s - cached)</p>
            <p className="text-[#e0eee5]">▶ Run npm run test</p>
            <p className="text-red-400"> ✖ 1 failing test</p>
            <p className="text-red-400"> Error: Expected true to be false</p>
            <br />
            <p className="text-yellow-400 font-bold">⚠️ Step failed. Runner paused.</p>
            <p className="text-[#71a792]">Container state preserved. Fix the issue and run:</p>
            <p className="text-[#e0eee5] bg-[#243c34] inline-block px-2 py-1 mt-1">
              npx run-local-ci retry --name runner-test-and-build
            </p>
            <div className="w-2 h-4 bg-[#528b76] inline-block ml-2 align-middle animate-blink" />
          </div>
        </Panel>
      </div>
    </div>
  );
}
