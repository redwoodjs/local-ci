import { allPosts } from "content-collections";
import { Terminal as TerminalIcon } from "lucide-react";
import { RequestInfo } from "rwsdk/worker";

function PageShell({ children }: { children: React.ReactNode }) {
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

      <div className="max-w-3xl mx-auto px-6 py-12 relative z-10">{children}</div>
    </div>
  );
}

export function BlogPost({ params, ctx }: RequestInfo) {
  const { slug } = params;
  const post = allPosts.find((p) => p._meta.path.replace(/\.md$/, "") === slug);

  if (!post) {
    return (
      <PageShell>
        <div className="text-center py-24">
          <h1 className="text-3xl font-bold font-serif text-[#e0eee5] mb-4">Post not found</h1>
          <p className="text-[#9bc5b3] mb-8">The blog post you're looking for doesn't exist.</p>
          <a
            href="/blog"
            className="text-[#528b76] hover:text-[#9bc5b3] font-mono transition-colors"
          >
            ← Back to blog
          </a>
        </div>
      </PageShell>
    );
  }

  if (post.protected && !ctx.user) {
    return (
      <PageShell>
        <div className="text-center py-24">
          <h1 className="text-3xl font-bold font-serif text-[#e0eee5] mb-4">Login Required</h1>
          <p className="text-[#9bc5b3] mb-8">This post requires you to be logged in to view it.</p>
          <div className="flex gap-4 justify-center">
            <a
              href="/user/login"
              className="px-6 py-2.5 bg-[#161b18] border border-[#3f6f5e] text-[#9bc5b3] hover:bg-[#243c34] hover:text-[#e0eee5] transition-all rounded-sm font-mono text-sm"
            >
              Login
            </a>
            <a
              href="/blog"
              className="text-[#528b76] hover:text-[#9bc5b3] font-mono text-sm self-center transition-colors"
            >
              ← Back to blog
            </a>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <nav className="mb-8">
        <a
          href="/blog"
          className="text-[#528b76] hover:text-[#9bc5b3] text-sm font-mono transition-colors"
        >
          ← Back to blog
        </a>
      </nav>

      <article>
        <header className="mb-8 pb-8 border-b border-[#2b483e]">
          <h1 className="text-4xl font-bold font-serif text-[#e0eee5] leading-tight mb-4">
            {post.title}
          </h1>
          <div className="flex items-center gap-3 text-xs font-mono text-[#71a792] uppercase tracking-wider">
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
        </header>

        <div className="mb-8 px-4 py-3 border border-[#2b483e] rounded-sm bg-[#12211c] text-[#71a792] text-xs font-mono">
          This post was written with the help of AI.
        </div>

        <div
          className="blog-content text-[#c2ddd0] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: post.html }}
        />
      </article>

      <footer className="border-t border-[#2b483e] pt-8 mt-12 flex flex-col md:flex-row justify-between items-center gap-4">
        <a
          href="/blog"
          className="text-[#528b76] hover:text-[#9bc5b3] font-mono text-sm transition-colors"
        >
          ← Back to all posts
        </a>
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
    </PageShell>
  );
}
