# AI Agent Tool Discoverability Research Findings

> Phase 3 output — evidence gathered for AI agent discovery and recommendation mechanisms.

**Research Date:** March 23, 2026

---

## 1. The llms.txt Convention

### What It Is

`llms.txt` is a Markdown file placed at `yourdomain.com/llms.txt`, proposed by Jeremy Howard (Answer.AI) on September 3, 2024. It follows the pattern of `robots.txt`: a machine-readable index listing your most important documentation pages as Markdown links with brief descriptions. Companion `.md` versions of each HTML page are served at the same URL with `.md` appended.

The specification defines a required H1 title, a blockquote summary, optional H2-delimited sections, and links to Markdown-formatted documentation. Mintlify, a popular developer-docs platform, auto-generates two variants: `llms.txt` (indexed directory) and `llms-full.txt` (entire docs site concatenated). Mintlify adds HTTP discovery headers to every page response:

```
Link: </llms.txt>; rel="llms-txt", </llms-full.txt>; rel="llms-full-txt"
X-Llms-Txt: /llms.txt
```

### Adoption Numbers

According to [BuiltWith's technology tracking dashboard](https://trends.builtwith.com/robots/LLMS-Text), over 844,000 websites had implemented `llms.txt` as of October 25, 2025. Major adopters include Anthropic (Claude docs), Cloudflare, and Stripe. The Fern platform reports it as a standard for AI-discoverable APIs as of January 2026.

**Important caveat:** BuiltWith counts any file detected at `/llms.txt` regardless of content quality. Other measurement approaches show much lower numbers — NerdyData reported ~951 verified domains as of mid-2025; SE Ranking found ~10% of ~300k domains tested had the file. The 844k figure reflects BuiltWith's broad crawl methodology. The accurate characterization is: adoption is widespread but the quality/intent of those implementations varies significantly.

Sources: [BuiltWith LLMS Text tracking](https://trends.builtwith.com/robots/LLMS-Text), [getpublii.com llms.txt guide (citing BuiltWith)](https://getpublii.com/blog/llms-txt-complete-guide.html), [SE Ranking: llms.txt adoption study](https://www.searchenginejournal.com/llms-txt-shows-no-clear-effect-on-ai-citations-based-on-300k-domains/561542/)

### Does It Actually Influence LLM Behavior?

**Verdict: Partially, in a specific and narrow way.**

- No major AI platform (ChatGPT, Claude in general inference, Perplexity) has publicly documented using `llms.txt` during general chat as of early 2026. The absence here is absence of documentation, not a tested negative — no platform has stated "we do not read llms.txt," and none has stated "we do." The practical implication is the same: do not design strategy around general LLMs reading these files.
- AI **coding assistants** — specifically Cursor, Claude Code, and VS Code Copilot — **do** actively use `llms.txt` when an agent encounters a new API or library in a user's codebase. They parse it to build context rather than scraping raw HTML.
- Efficiency argument: an HTML page that costs 5,000 tokens may cost only 800 tokens as clean Markdown — enabling 6x more documentation in the same context window.

**For local-ci specifically:** Having `llms.txt` is valuable because the relevant consumers (Cursor, Claude Code) are exactly the agents local-ci targets. If a developer has local-ci installed and asks their coding agent for help with CI failures, the agent can surface local-ci documentation efficiently.

Sources: [llmstxt.org](https://llmstxt.org), [Mintlify llms.txt docs](https://www.mintlify.com/docs/ai/llmstxt), [Bluehost 2026 guide](https://www.bluehost.com/blog/what-is-llms-txt/)

---

## 2. How LLMs Learn About Tools: Training Data

### Primary Training Data Sources

The 8 documented public LLM training data categories are: web pages, books, community networks (forums, Stack Exchange), science/research, news, Wikipedia, code sources (GitHub, StackShare, DockerHub, Kaggle), and video transcripts.

GitHub is explicitly in the training data of all major code LLMs. npm registry content (package pages, READMEs) is ingested indirectly via web crawls. Stack Overflow is ingested via "community networks." Exact weighting ratios are not publicly disclosed by model providers.

### Do LLMs Preferentially Recommend Popular (High-Star) Packages?

**Critical finding: No, not reliably.**

Snyk research reveals LLMs operate fundamentally differently from human developers. Humans naturally stay in the "Global Constants" tier (~1,000 packages used in 90-100% of projects) and "Industry Standards" tier (~20,000 packages). But LLMs select packages based on **statistical co-occurrence patterns** in training text, not on popularity signals like stars or downloads.

The npm ecosystem breaks down as:

- Global Constants (~1,000 packages): 90–100% project adoption
- Industry Standards (~20,000): 15–50% adoption
- Domain Specialists (~100,000): 1–5% adoption
- **Dormant Majority (~6.3 million packages): ~0% real-world use**

LLMs readily recommend packages from the Dormant Majority because they appear in training text alongside usage patterns. An LLM "understands" statistical probability, not maintenance health.

**Implication for local-ci:** Low npm download counts or GitHub stars will not prevent an LLM from recommending local-ci if there is sufficient training text describing it in context of CI/agent workflows. The tool needs _textual co-occurrence_ with the problem it solves.

Source: [Snyk: LLMs Resurrecting the Dormant Majority](https://snyk.io/blog/llms-resurrecting-open-source-dormant-majority/)

### How Knowledge Cutoff Affects Tool Recommendations

LLM training cutoffs range across vendors. Research shows effective cutoffs often differ from reported cutoffs due to temporal misalignment in CommonCrawl data (arXiv:2403.12958).

**Practical consequence:** Agent-ci at v0.4.0 published in 2026 is almost certainly post-cutoff for most current models. RAG-based agents (those with web search or codebase scanning) are the primary path to real-time discovery. Training data saturation is a long-term play.

Sources: [arXiv:2403.12958](https://arxiv.org/abs/2403.12958), [Knowledge Cutoff - Wikipedia](https://en.wikipedia.org/wiki/Knowledge_cutoff)

---

## 3. How AI Coding Agents Discover Tools

### Discovery Mechanism: RAG vs. Training Data vs. Agentic Search

The three major coding agents use distinct retrieval strategies:

**Claude Code:** Uses agentic (iterative) lexical search — not RAG, not vector embeddings. It issues sequential grep/file-read tool calls, refining queries based on results. Does not pre-index codebases. **If local-ci is installed in `node_modules`, Claude Code can discover it by searching `package.json` files and `node_modules/.bin/`.** If a `CLAUDE.md` or `.claude/rules/` file references local-ci, it will read those at session start.

**Cursor:** Uses a RAG-like hybrid — semantic vector search on pre-indexed code plus lexical grep. Reads `.cursorrules` project files.

**GitHub Copilot:** More IDE-integrated, relies more heavily on training data and repo-level context. Less agentic autonomy in tool discovery.

Sources: [Medium: Why Claude Code is special for not doing RAG](https://zerofilter.medium.com/why-claude-code-is-special-for-not-doing-rag-vector-search-agent-search-tool-calling-versus-41b9a6c0f4d9), [Tiger Data: Why Cursor is Ditching Vector Search](https://www.tigerdata.com/blog/why-cursor-is-about-to-ditch-vector-search-and-you-should-too)

### What Metadata Signals Agents Read

For agents operating within a codebase, the following signals are read in practice:

1. **CLAUDE.md / .claude/rules/ / .cursorrules / AGENTS.md** — Read at session start. Direct authoritative instructions.
2. **package.json `description` and `keywords`** — Scanned when agents explore `node_modules`.
3. **README.md** — Primary documentation surface.
4. **`/llms.txt`** — Read by Cursor and Claude Code when fetching external documentation.
5. **npm package page** — Parsed when agents do web searches or fetch installation instructions.

### Emerging: TanStack Intent and Agent Skills in npm Packages

TanStack announced TanStack Intent — a pattern where library maintainers ship agent-readable "skills" inside npm packages. The CLI (`@tanstack/intent install`) discovers intent-enabled packages via dependency graphs, then writes agent instructions into `CLAUDE.md` and `.cursorrules` automatically. Skills are versioned Markdown documents with YAML frontmatter (name, description, sources) and explicit "Common Mistakes" sections.

A parallel pattern: the `agent-skill` npm keyword convention, where packages with this keyword are indexed in an Agent Skills Registry (90+ packages as of research date). These packages include a `SKILL.md` file.

**This is the most agent-native distribution mechanism currently emerging for npm packages.**

Sources: [TanStack Intent announcement](https://tanstack.com/blog/from-docs-to-agents), [skillpm on DEV Community](https://dev.to/sbroenne/skillpm-package-manager-for-agent-skills-built-on-npm-3d31), [npm-agentskills GitHub](https://github.com/onmax/npm-agentskills)

---

## 4. What Makes a Tool "Agent-Friendly"

### README Patterns That Improve LLM Comprehension

The ReadMe.LLM research paper (arXiv:2504.09798) ran controlled experiments across GPT-4o, Claude, Grok-2, DeepSeek R1, and Llama variants:

- **Standard human-oriented README files actually harm LLM performance** in code generation tasks. In one test, providing only a `README.md` caused model performance to decrease relative to no context at all.
- A purpose-built **ReadMe.LLM file** containing: (1) Rules section, (2) Library Description, (3) Function signatures with examples — raised task success rates from ~30% baseline to 100%.
- XML tags separating content types improve machine readability.
- "Common Mistakes" sections explicitly showing incorrect usage were particularly effective.

Experimental results:

- Supervision library: 30% baseline → 100% with ReadMe.LLM
- DigitalRF library: 0% baseline → 80–100% with ReadMe.LLM

Source: [ReadMe.LLM paper (arXiv:2504.09798)](https://arxiv.org/html/2504.09798v2)

### The "Fewer Tools, Not More" Principle

Research on MCP servers shows performance collapses past ~30 tools, with a hard cliff at 107 tools where all models fail. GitHub cut their MCP server from 40 tools to 13 and saw improvements. Block rebuilt their Linear integration going from 30+ tools to 2.

**For local-ci:** Specialization beats feature breadth. One focused capability with an accurate, specific description beats a multi-tool suite with vague marketing language.

Source: [icme.io: Getting Found by Agents 2026](https://blog.icme.io/getting-found-by-agents-a-builders-guide-to-tool-discovery-in-2026/)

### Current local-ci npm Metadata Gaps

Current state (evidence from package.json):

- `"description": "Local GitHub Actions runner"` — accurate but minimal; differentiator missing
- `"keywords": []` — **empty** — significant discoverability gap

Agents pattern-matching on keywords like `github-actions`, `ci`, `local-runner`, `ai-agent` would not find local-ci.

---

## 5. GitHub Topic Tags for Agent Discoverability

Active GitHub Topics for AI/agent tools:

- `llm-agent`, `llm-agents`, `agents`, `ai-agent`
- `github-actions`, `local-runner`, `ci-cd`
- `developer-tools`

GitHub topic tags influence whether a repository appears in GitHub's search results and curated lists (like "awesome-\*" repositories). These lists are frequently scraped as training data. There is no direct evidence that GitHub topic tags are parsed as structured signals during LLM training — their value is via the discoverability chain: **topics → search results → curated lists → training scrapes**.

Sources: [github.com/topics/llm-agent](https://github.com/topics/llm-agent), [Jenqyang/Awesome-AI-Agents](https://github.com/Jenqyang/Awesome-AI-Agents)

---

## 6. Tool Registries for AI Agents

### MCP (Model Context Protocol) Ecosystem

MCP has spawned a registry ecosystem. Primary registries as of March 2026:

| Registry                           | Role                                                                   | Scale        |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------ |
| **Smithery**                       | Primary MCP hub; agents search by keyword/natural language at runtime  | 7,300+ tools |
| **Official MCP Registry (GitHub)** | Enterprise/IDE discovery; required for Cursor, VS Code, Claude Desktop | Growing      |
| **Composio**                       | Production infrastructure, managed hosting                             | Growing      |
| **awesome-mcp-servers**            | Curated GitHub list                                                    | High traffic |

**Critical nuance:** MCP tool discovery is **still largely manual** as of early 2026. Anthropic has announced a server registry and discovery protocol is coming, but agents cannot yet autonomously discover MCP servers. Developers must manually configure which servers their agent can access.

The "Forage" pattern (MCP server by Isaac Levine) allows agents to dynamically discover, install, and learn new tools when they hit capability gaps — but requires Forage to already be installed.

Sources: [a16z: Deep Dive into MCP](https://a16z.com/a-deep-dive-into-mcp-and-the-future-of-ai-tooling/), [Smithery.ai](https://smithery.ai/), [Forage GitHub](https://github.com/isaac-levine/forage)

### LangChain and OpenAI Plugin Patterns

LangChain offers 1,000+ tool integrations within its framework — discovery happens within LangChain code, not via a public marketplace.

GPT plugin/custom GPT actions use OpenAPI-compatible tool schemas. Tools are described via JSON Schema with `description` fields that GPT-4 uses for selection. **Tool descriptions are the primary selection signal for LLMs choosing which tool to invoke** — this pattern has influenced MCP's design.

---

## 7. The Competitive Landscape

**nektos/act** (60,000+ GitHub stars) is the dominant "run GitHub Actions locally" tool. It is deeply embedded in LLM training data as the default recommendation for local CI.

Key differences from local-ci:

- Act re-implements the Actions runtime; local-ci emulates the server-side API and uses the official runner binary
- Act does not pause-on-failure for agent-assisted retry
- Act installs via Homebrew/binary; local-ci installs via npm
- Act targets human developers; local-ci is positioned for AI-agent-driven development workflows

**The knowledge cutoff problem is significant:** current LLMs will default to recommending `act` for local CI scenarios because it has years of training data saturation. Agent-ci will not enter LLM recommendations via training data alone in the near term — it requires the RAG/real-time discovery path.

---

## Signal Hierarchy for local-ci Discoverability

From highest to lowest reliability:

1. **CLAUDE.md / .cursorrules in developer's project** — direct, guaranteed, agent reads it at session start
2. **`package.json` description + keywords** — read by agents exploring node_modules
3. **README.md** — read by agents when exploring repository
4. **MCP server registration** — discoverable via Smithery at agent query time
5. **`llms.txt`** — read by Cursor/Claude Code when fetching external docs
6. **GitHub topic tags + curated lists** — indirect path via training data
7. **Blog posts, Stack Overflow** — long-term training data contribution
8. **Training data saturation** — requires years of ecosystem presence; nektos/act already owns this lane

**Most important near-term action:** Create a ready-to-paste CLAUDE.md snippet and document it prominently in the README. Every developer who adds it to their project becomes a guaranteed local-ci user for that project's lifetime.

---

## Evidence Gaps

| Question                                                        | Evidence Quality                                                                   | Gap                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Does `llms.txt` influence general LLM inference?                | Moderate (absence of documentation): no platform has publicly confirmed reading it | No platform has stated yes or no; behavior untested |
| Do GitHub stars influence training data selection?              | Weak: no published weighting data                                                  | Model providers don't disclose this                 |
| Does `package.json` keywords field affect agent tool selection? | Moderate: emerging pattern + anecdote                                              | No controlled study                                 |
| MCP dynamic discovery timeline                                  | Moderate: Anthropic announced, no ship date                                        | Timeline unclear                                    |
| How much of npm is in current training data?                    | Weak: acknowledged as a source, no % data                                          | Not published                                       |
| Does CLAUDE.md override training data recommendations?          | Strong (positive): direct injection to context                                     | Well-documented behavior                            |

---

## Sources

- [llmstxt.org](https://llmstxt.org)
- [BuiltWith LLMS Text tracking (primary source for 844k figure)](https://trends.builtwith.com/robots/LLMS-Text)
- [getpublii.com llms.txt guide (cites BuiltWith)](https://getpublii.com/blog/llms-txt-complete-guide.html)
- [SE Ranking / Search Engine Journal: llms.txt adoption study (300k domain research)](https://www.searchenginejournal.com/llms-txt-shows-no-clear-effect-on-ai-citations-based-on-300k-domains/561542/)
- [Mintlify llms.txt docs](https://www.mintlify.com/docs/ai/llmstxt)
- [Bluehost 2026 guide on llms.txt](https://www.bluehost.com/blog/what-is-llms-txt/)
- [Fern best platforms Jan 2026](https://buildwithfern.com/post/best-llms-txt-implementation-platforms-ai-discoverable-apis)
- [Peec AI: llms.txt helper or hoax](https://peec.ai/blog/llms-txt-md-files-important-ai-visibility-helper-or-hoax)
- [icme.io: Getting Found by Agents 2026](https://blog.icme.io/getting-found-by-agents-a-builders-guide-to-tool-discovery-in-2026/)
- [ReadMe.LLM paper (arXiv:2504.09798)](https://arxiv.org/html/2504.09798v2)
- [Snyk: LLMs Resurrecting the Dormant Majority](https://snyk.io/blog/llms-resurrecting-open-source-dormant-majority/)
- [a16z: Deep Dive into MCP](https://a16z.com/a-deep-dive-into-mcp-and-the-future-of-ai-tooling/)
- [Smithery.ai](https://smithery.ai/)
- [TanStack Intent announcement](https://tanstack.com/blog/from-docs-to-agents)
- [HumanLayer: Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [Medium: Why Claude Code is special for not doing RAG](https://zerofilter.medium.com/why-claude-code-is-special-for-not-doing-rag-vector-search-agent-search-tool-calling-versus-41b9a6c0f4d9)
- [arXiv:2403.12958 knowledge cutoff](https://arxiv.org/abs/2403.12958)
- [nektos/act GitHub](https://github.com/nektos/act)
- [Microsoft agent metadata and discoverability](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-metadata-discoverability)
- [skillpm DEV Community](https://dev.to/sbroenne/skillpm-package-manager-for-agent-skills-built-on-npm-3d31)
- [Oxylabs LLM training data overview](https://oxylabs.io/blog/llm-training-data)
- [Forage GitHub](https://github.com/isaac-levine/forage)
- [Tiger Data: Why Cursor is Ditching Vector Search](https://www.tigerdata.com/blog/why-cursor-is-about-to-ditch-vector-search-and-you-should-too)
