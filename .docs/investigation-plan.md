# Local CI Marketing & Adoption Investigation Plan

## What local-ci Actually Is

local-ci is a **local GitHub Actions runner** that replaces the GitHub cloud API with local emulation. Key capabilities:

- Runs the **official, unmodified** GitHub Actions runner binary locally
- **~0 ms caching** via bind-mounts (no upload/download cycles)
- **Pause on failure** — container stays alive; fix the issue and retry just the failed step
- Ideal for **AI-agent-driven development**: an agent can fix CI failures in a tight loop without full remote CI cycles
- Install: `npm install -D local-ci`

The "AI-aware" angle is about workflow: local-ci creates an environment where AI coding agents (Claude, Copilot, etc.) can iterate on CI failures efficiently — not about writing CI in natural language.

---

## Track 1: Human Developer Discovery & Adoption

### Key Questions

1. **Package Discoverability**: How do developers discover CI tools?
2. **Decision Drivers**: What factors influence CI tool adoption?
3. **Developer Channel Strategy**: Which channels are highest-ROI for CI tools?
4. **Messaging Angle**: What resonates with developers?
5. **Competitive Position**: How do similar tools market themselves?

### Hypotheses

- **H1**: CI tool discovery is heavily GitHub-driven; README, topics, and stars are highest-ROI
- **H2**: "AI-agent workflows" is a strong differentiator in 2026 for this specific tool
- **H3**: Developer communities (HackerNews, Reddit r/devops) are high-quality acquisition channels
- **H4**: Proof points ("reduced CI iteration from 8 min to 30 sec") drive adoption more than feature lists
- **H5**: OSS maintainers are high-influence adopters for CI tooling

### Analyst Queries

1. "local GitHub Actions runner tools alternatives act"
2. "how developers choose CI tool decision factors survey"
3. "GitHub Actions alternatives market 2025 2026"
4. "HackerNews CI deployment tool discussions"
5. "Reddit r/devops popular CI tools 2025"
6. "developer tool adoption marketing channels"
7. "OSS maintainer CI workflow tools"
8. "act nektos local GitHub Actions runner"

---

## Track 2: AI Agent Discoverability & Recommendation

### Key Questions

1. **LLM Training Data**: How do LLMs learn about tools?
2. **Tool Discovery Mechanisms**: How do AI coding agents discover CLI tools?
3. **Recommendation Surfacing**: How do agents recommend tools?
4. **Knowledge Source Priority**: Which sources do agents weight most?
5. **Agent Awareness Tactics**: What makes a tool "discoverable" to agents?
6. **Prompt Surface**: How can local-ci surface itself in agent prompts?

### Hypotheses

- **H6**: Agents rely primarily on GitHub READMEs and package registry metadata
- **H7**: llms.txt convention will become "SEO for agents"; early adoption positions local-ci as agent-friendly
- **H8**: Agents weight recency and GitHub stars heavily (flywheel effect with human adoption)
- **H9**: Integration with popular coding agent frameworks is necessary but not sufficient
- **H10**: High-quality blog posts and documentation have outsized impact on agent training data

### Analyst Queries

1. "llms.txt convention agent discovery tools site:llmstxt.org OR site:github.com"
2. "how AI coding agents discover recommend tools"
3. "LLM training data sources GitHub npm documentation"
4. "Anthropic Claude tool discovery recommendations"
5. "AI agent CI workflow automation tools"
6. "GitHub topic tags SEO agent discoverability"
7. "tool registries AI agents LangChain CrewAI"
8. "LLM knowledge cutoff tool recommendations 2025"
9. "AI agent pair programming CI workflow"

---

## Quality Criteria

### Strong Evidence

- Quantitative data: download stats, GitHub stars, survey results
- Official documentation: LLM training pipelines, tool-calling specs
- Reproducible examples: case studies with before/after metrics
- Community validation: HN/Reddit rankings, dev surveys

### Weak Evidence

- Anecdotes from single blog posts
- Outdated data (>2 years old)
- Vendor claims without third-party validation
- Speculation about LLM training

---

## Output Definition

**Phase 6 deliverable:** `.docs/marketing-strategy.md`

1. Executive summary: local-ci positioning for devs and agents
2. Track 1 tactics: prioritized channels, messaging, proof points, quick wins
3. Track 2 tactics: agent discoverability roadmap
4. Integrated timeline: phased approach (quick wins, medium-term, long-term)
5. Success metrics: how to measure adoption for each audience
