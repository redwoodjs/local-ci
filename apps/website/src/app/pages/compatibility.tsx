import { CompatibilityMatrix } from "../components/CompatibilityMatrix";
import { Terminal as TerminalIcon } from "lucide-react";

export const Compatibility = () => {
  return (
    <div className="min-h-screen relative overflow-clip selection:bg-[#528b76] selection:text-[#f2f7f4]">
      {/* CRT Effects */}
      <div className="crt-flicker pointer-events-none" />
      <div className="scanline pointer-events-none" />

      {/* Background Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(43,72,62,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(43,72,62,0.1)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_20%,transparent_100%)] pointer-events-none" />

      {/* Sticky Navbar */}
      <nav className="sticky top-0 z-50 border-b border-[#2b483e] bg-[#0d110f]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 py-3 md:py-0 md:h-16 flex flex-wrap md:flex-nowrap justify-between items-center gap-2">
          <a href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#12211c] border border-[#528b76] flex items-center justify-center rounded-sm shadow-[0_0_10px_rgba(82,139,118,0.3)]">
              <TerminalIcon className="text-[#9bc5b3]" size={16} />
            </div>
            <span className="text-xl font-bold tracking-tight text-[#e0eee5] font-sans">
              AGENT-CI
            </span>
          </a>

          <div className="flex items-center gap-4 md:gap-8 text-xs md:text-sm font-medium text-[#9bc5b3] order-last md:order-none w-full md:w-auto">
            <a href="/#quick-start" className="hover:text-[#e0eee5] transition-colors">
              Docs
            </a>
            <a href="/#principles" className="hover:text-[#e0eee5] transition-colors">
              Principles
            </a>
            <a href="/compatibility" className="text-[#e0eee5]">
              Compatibility
            </a>
            <a href="/blog" className="hover:text-[#e0eee5] transition-colors">
              Blog
            </a>
            <a
              href="https://github.com/redwoodjs/local-ci"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#e0eee5] transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <h1 className="text-4xl font-bold text-[#e0eee5] font-serif">YAML Compatibility</h1>
            <div className="h-px bg-[#2b483e] flex-1"></div>
          </div>
          <p className="text-[#9bc5b3] text-lg max-w-2xl">
            Local CI aims to run real GitHub Actions workflows locally. Below is current support
            against the{" "}
            <a
              href="https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#71a792] hover:text-[#e0eee5] underline decoration-[#34594c] underline-offset-4 transition-colors"
            >
              official workflow syntax
            </a>
            .
          </p>
        </div>

        <CompatibilityMatrix />

        {/* Footer */}
        <footer className="border-t border-[#2b483e] pt-8 mt-12 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2 text-[#71a792] font-mono text-sm">
            <TerminalIcon size={16} />
            <span>AGENT-CI // LOCAL RUNNER</span>
          </div>
          <div className="text-[#528b76] text-sm font-mono">
            Built by{" "}
            <a
              href="https://rwsdk.com"
              className="text-[#9bc5b3] hover:text-[#e0eee5] transition-colors underline decoration-[#34594c] underline-offset-4"
            >
              RedwoodJS
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};
