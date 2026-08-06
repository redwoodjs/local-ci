import { allPosts } from "content-collections";
import { Terminal as TerminalIcon } from "lucide-react";

export function Blog() {
  const posts = allPosts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="min-h-screen relative overflow-clip selection:bg-[#528b76] selection:text-[#f2f7f4]">
      <div className="crt-flicker pointer-events-none" />
      <div className="scanline pointer-events-none" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(43,72,62,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(43,72,62,0.1)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_20%,transparent_100%)] pointer-events-none" />

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
            <a href="/compatibility" className="hover:text-[#e0eee5] transition-colors">
              Compatibility
            </a>
            <a href="/blog" className="text-[#e0eee5]">
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

      <div className="max-w-3xl mx-auto px-6 py-12 relative z-10">
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <h1 className="text-4xl font-bold text-[#e0eee5] font-serif">Blog</h1>
            <div className="h-px bg-[#2b483e] flex-1"></div>
          </div>
          <p className="text-[#9bc5b3] text-lg">Articles and updates from the Local CI team.</p>
        </div>

        <div className="flex flex-col gap-6">
          {posts.map((post) => {
            const slug = post._meta.path.replace(/\.md$/, "");
            return (
              <article
                key={post._meta.path}
                className="border border-[#2b483e] rounded-sm bg-[#12211c] p-6 hover:border-[#3f6f5e] transition-colors"
              >
                <h2 className="text-xl font-bold font-serif text-[#e0eee5] mb-2 leading-snug">
                  <a href={`/blog/${slug}`} className="hover:text-[#9bc5b3] transition-colors">
                    {post.title}
                    {post.protected && (
                      <span className="ml-2 text-sm text-[#71a792] font-mono">🔒</span>
                    )}
                  </a>
                </h2>

                <div className="flex items-center gap-3 text-xs font-mono text-[#71a792] mb-3 uppercase tracking-wider">
                  <span>{post.author}</span>
                  <span className="text-[#34594c]">·</span>
                  <time>
                    {new Date(post.date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </time>
                </div>

                <p className="text-[#9bc5b3] text-sm leading-relaxed mb-4">{post.summary}</p>

                <a
                  href={`/blog/${slug}`}
                  className="text-[#528b76] hover:text-[#9bc5b3] text-sm font-mono transition-colors"
                >
                  Read more →
                </a>
              </article>
            );
          })}
        </div>

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
}
