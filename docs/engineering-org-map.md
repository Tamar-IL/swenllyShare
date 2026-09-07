# World-Class Engineering Org Map — v1.2
### A Foundation Document for Building an AI Agent Team That Mirrors a Top-Tier Software Company

> **Purpose:** Map every role, discipline, and axis that makes up a world-class
> AI-native engineering organization — as the basis for building a team of sub-agents
> where each agent is a specialist "worker" at Staff/Principal level. Mapping phase.
>
> **Status:** Revised draft · Version 1.2
>
> **What changed from v1.1:**
> - **Tier column** on every role (T1 build-first / T2 on-demand / T3 reference) — so a
>   complete *taxonomy* never gets mistaken for a *build list*.
> - **The 3-tier agent hierarchy** (Orchestrator → Domain Leads → Specialists), plus the
>   **human at the apex** and the **requisition-based recruiting** model.
> - **New roles:** Prototyper/POC (Discover), **AI Red Team** & **LLM Observability**
>   (AI-Ops — found missing in final review), Advisor/Consultant, Team Composer/Staffing,
>   Recruiter.
> - **Two new meta-insights:** the *Proof-Gate Spine* and the *Self-Improving Org*.
> - **Part 6 expanded:** the **four "attackers" disambiguation** — the single most
>   important naming decision before the build.
> - Design principle: agents inherit a role's **strengths, not the human's defects**.

---

## Part 0 — The Meta-Framework: Five Super-Domains

The team is not a flat list of roles. It splits into **super-domains** along one question:
*what is the work for?*

| Super-domain | The question it answers | Nature |
|---|---|---|
| **① DISCOVER** | What should we build? Will it work? | Continuous |
| **② BUILD** | How do we build it right? | Project-based |
| **③ RUN & SCALE** | How do we run at scale without breaking? | Continuous |
| **④ IMPROVE** | How do we improve and not break under growth? | Continuous |
| **⑤ AI OPERATIONS** | How do the AI/agent systems themselves run, improve & stay safe? | Continuous |
| **⊕ CROSS-CUTTING** | What accelerates and secures everything else | Infrastructure |

**Guiding principle:** Most failures of growing companies are not in BUILD but in
DISCOVER (building the wrong thing), IMPROVE (breaking under weight), and — for an
AI-native org — **AI OPERATIONS** (the agents silently degrade, drift, hallucinate, or
get jailbroken, and no one owns it).

---

## Part 1 — The Three Axes + The Hierarchy

### Axis A — Discipline (Function) — *what you specialize in.* See Part 2.
### Axis B — Seniority (Level) — *how deep/wide you operate.* See Part 3.
### Axis C — Track — *specialist IC vs. manager.* Two ladders; IC reaches the top.

> **"Ace engineer, 20 years"** = a *specific discipline* × *Staff/Principal level* × *IC track*.
> Each agent carries **seniority traits**: thinks in tradeoffs before implementing, no
> shortcuts, justifies decisions, sets standards.

### The Agent Hierarchy (how the roles are wired together)

At your scale, collapse the hyperscaler's 4 management layers into **3 agent tiers**:

```
        YOU (founder / final authority — sets priorities, approves, breaks ties)
          │
   ┌──────┴───────┐
   │  TIER 0      │  Orchestrator / "Chief" — receives the goal, decomposes,
   │  Orchestrator│  routes, synthesizes the final result. One.
   └──────┬───────┘
   ┌──────┴───────┐
   │  TIER 1      │  Domain Leads — one per super-domain (Discover/Build/Run&Scale/
   │  Domain Leads│  Improve/AI-Ops). Decompose domain work, delegate, raise
   └──────┬───────┘  recruiting requisitions.
   ┌──────┴───────┐
   │  TIER 2      │  Specialist Workers — the ~45 IC roles. Do the actual work.
   │  Specialists │
   └──────────────┘

   Cross-cutting reviewers (Critic, Architecture Reviewer, AI Red Team, a11y, Trust &
   Safety…) JOIN at the review gate — they don't own standing work of their own.
```

**Two rules that keep the hierarchy from sprawling:**
1. **Advisors before decisions, Critics after work.** An agent doesn't decide unilaterally —
   it consults an **Advisor** (Staff/Principal) *before* committing. A **Critic** attacks
   the *output* *after* it exists. Different agents, different timing.
2. **Recruiting is requisition-based, never self-initiated.** A Domain Lead that hits a
   missing skill raises a **requisition**; the **Recruiter** agent fulfills it *only* on
   that request, from a template, with your approval — like a talent recruiter who hires
   to a manager's req, not on a whim. This is the structural brake on over-spawning.

---

## Part 2 — The Full Map

**Tier key:** **T1** = build first (the core senior team) · **T2** = add on demand ·
**T3** = reference (exists in world-class orgs; you'll likely never instantiate at your scale).

### ① DISCOVER — Who Brings and *Proves* Ideas

Core pattern: the **"product trio"** (PM + Designer + Engineer) in **dual-track** —
discovery and delivery run in parallel; discovery never ends. Cagan's 4 tests for any
idea: *valuable? usable? feasible? strategic?*

| Role | Tier | What it owns |
|---|---|---|
| **Product Manager (PM)** | T1 | The "what" & "why" — vision, roadmap, priorities, requirements |
| **Prototyper / POC / Spike Engineer** *(new)* | **T1** | Builds *throwaway* technical proofs to de-risk feasibility *before* commitment — distinct from market-demand testing |
| **Product Discovery Lead** | T2 | Separates good ideas from bad fast; output = validated backlog |
| **Experimentation Engineer** | T2 | A/B infra, fake-door tests — proving *demand* before building |
| **Growth Engineer / Growth PM** | T2 | Experiments, funnels, activation, retention |
| **Product Analyst** | T2 | Post-launch metrics — did the feature actually work (closes the loop) |
| **Market / Business / Pricing Strategist** | T2 | Market analysis, business feasibility, monetization/pricing |
| **Solution Architect** | T2 | Assesses technical feasibility at idea stage; bridge to dev |
| **Technical Program Manager (TPM)** | T2 | Cross-team coordination, dependencies, timelines, risk |

### ② BUILD — Building It Right

**B.1 Design & Experience**

| Role | Tier | What it owns |
|---|---|---|
| **Product Designer** | T1 | Holistic: business + UX + branding across the lifecycle |
| **UI / Visual Designer** | T1 | Aesthetics — typography, color, pixel-perfect screens |
| **UX Researcher** | T2 | Interviews, usability tests, surveys |
| **UX Designer** | T2 | User flows, journey maps, wireframes |
| **Content Designer / UX Writer** | T2 | In-product content — labels, CTAs, errors; voice & tone |
| **Design Systems Engineer** | T2 | Components, tokens, cross-product consistency |
| **Interaction / Motion Designer** | T3 | Behavior, transitions, micro-interactions |
| **Design Ops** | T3 | Design tooling, process, asset/handoff pipelines |

**B.2 Core Engineering**

| Role | Tier | What it owns |
|---|---|---|
| **Software Architect** | T1 | System boundaries, layering, high-level decisions, tradeoffs |
| **Backend Engineer** | T1 | Server-side logic, APIs, business logic |
| **Frontend Engineer** | T1 | Web UI in code — HTML/CSS/JS, state management |
| **Full-Stack Engineer** | T2 | Both layers, end-to-end |
| **API Designer** | T2 | API consistency, API UX, SDK design (≠ API Platform infra in ③) |
| **Mobile Engineer (iOS/Android)** | T3 | Native/cross-platform apps, app-store cycles |
| **Embedded / Firmware Engineer** | T3 | Hardware/microcontroller software — only if hardware is in scope |

**B.3 Data & AI (Classic Data + Science)** — *the foundation-model/agent layer is now ⑤.*

| Role | Tier | What it owns |
|---|---|---|
| **Database Engineer / DBA** | T1 | Schema, indexes, query optimization, migrations |
| **Data Engineer** | T2 | Pipelines, ETL, data infrastructure |
| **Analytics Engineer** | T2 | Data modeling for consumption (dbt, etc.) |
| **Data Scientist** | T3 | Analytics, statistics, visualization |
| **Data Architect** | T3 | Enterprise-wide data modeling & standards |
| **ML / AI Engineer (classic)** | T3 | Classic ML — models, training, inference |
| **Research Scientist / Research Engineer** | T3 | Invents/adapts methods; runs model experiments |

**B.4 Security**

| Role | Tier | What it owns |
|---|---|---|
| **Application Security (AppSec)** | T1 | OWASP, code-level vulnerabilities, authz/authn |
| **Identity / Authentication (IAM)** | T2 | SSO, OAuth, RBAC, permissions, auth infra |
| **Security Engineer / DevSecOps** | T2 | Security across the pipeline, secrets, dependencies |
| **Security Operations / IR (SecOps)** | T3 | Threat detection, monitoring, breach response |
| **Offensive Security / Penetration Tester** | T3 | Attacks the *system's classic security* (see Part 6) |
| **Compliance / GRC** | T3 | SOC2, ISO 27001, HIPAA, PCI, audits, SBOM |

### ③ RUN & SCALE — Running at Scale

> DevOps is a *culture* ("class SRE implements DevOps"), not an agent. SRE is the concrete
> implementation with SLOs and error budgets.

| Role | Tier | What it owns |
|---|---|---|
| **Platform / Infrastructure Engineer** | T1 | The platform everyone builds on — *absorbs networking, storage, systems at this scale* |
| **DevOps Engineer** | T1 | CI/CD, automation, IaC |
| **Site Reliability Engineer (SRE)** | T2 | Uptime, SLOs, incident response & on-call command, scale |
| **Cloud Engineer** | T2 | Cloud architecture, resource management |
| **Release Engineer** | T2 | The build & deploy process itself |
| **Integration / API Platform Engineer** | T2 | Stable API contracts, versioning, webhooks |
| **Capacity / Cost / FinOps Engineer** | T2 | Resource planning, cloud **and LLM-token** cost monitoring |
| **Data Governance / Privacy Engineer** | T3 | GDPR, PII, data retention |

### ④ IMPROVE — Improving Without Breaking

| Role | Tier | What it owns |
|---|---|---|
| **Performance Engineer** | T1 | Latency, throughput, profiling, optimization |
| **Code Reviewer** | T1 | Independent *line-level* reviewer in a clean context |
| **Critic / Adversarial Reviewer** | T1 | Attacks the *work product* (design, logic, quality) — *NOT security; see Part 6* |
| **Architecture Reviewer** | T2 | Reviews system design, scalability, tradeoffs, future impact |
| **Observability Engineer (classic)** | T2 | Logs, metrics, traces, dashboards |
| **Internationalization (i18n) Engineer** | T2 | Code readiness for locales — RTL, formatting, encoding |
| **Localization (L10n) Engineer** | T2 | Content adaptation — translation, currency, market nuance (*i18n is code; L10n is content*) |
| **Accessibility (a11y) Engineer** | T2 | WCAG, screen readers, keyboard navigation |
| **Tech Debt / Code Health Engineer** | T2 | Systematic refactoring, cleanup, modernization |

### ⑤ AI OPERATIONS — Running the AI/Agent Systems Themselves

> For an org built *of* AI agents, this is not one "ML Engineer" — it is a full discipline,
> as fundamental as Frontend and Backend are to a traditional company.

| Role | Tier | What it owns |
|---|---|---|
| **AI / LLM Platform Engineer** | **T1** | Model routing, inference optimization, vector DB, **caching, context & memory** — *absorbs Retrieval, Memory & Routing as components* |
| **Prompt / Agent Behavior Engineer** | **T1** | System prompts, agent behavior, reasoning policies, tool definitions, hallucination reduction |
| **Eval / Model-Quality Engineer** | **T1** | Benchmark suites, golden datasets, regression tests, quality scoring — *the agent org's QA; non-optional* |
| **Trust & Safety / Guardrails Engineer** | **T1** | Builds defenses — prompt-injection defense, output guardrails, content safety (*the defender; see Part 6*) |
| **AI Red Team / Adversarial AI Engineer** *(new)* | **T1** | *Attacks the agents* — jailbreaks, prompt injection, tool-poisoning, agent misuse. Failing traces become regression datasets (*≠ Trust & Safety, ≠ Pen-Test; see Part 6*) |
| **LLM Observability Engineer** *(new)* | T2 | Production traces, hallucination/drift monitoring, token-usage & quality-aware alerts — *distinct from classic Observability* |
| **Retrieval / Search (IR) Engineer** | T2 | Indexing, ranking, semantic search — the RAG backbone (folds into Platform until volume demands it) |
| **MLOps Engineer** | T2 | Training/inference pipelines, model registry, drift detection, fine-tuning |
| **Knowledge / Ontology Engineer** | T3 | Knowledge graphs, retrieval structured for machine consumption |
| **Human-Data / RLHF Ops** | T3 | The labeled-data & annotation pipeline |

### ⊕ CROSS-CUTTING — Quality, Velocity, Knowledge, Customer/Org Surface

| Role | Tier | What it owns |
|---|---|---|
| **QA Engineer** | T1 | Quality assurance — documentation, testing, measurement at every stage |
| **Technical Writer / Scribe** | T1 | Docs, READMEs, API docs, runbooks |
| **Advisor / Consultant** *(new)* | **T1** | Staff/Principal consulted *before* a decision — agents don't decide unilaterally |
| **SDET** | T2 | Test infrastructure in code — automation |
| **Engineering Productivity (EngProd)** | T2 | Internal tooling, CI/CD, build systems — *absorbs Build-Systems* |
| **Developer Experience (DX) Engineer** | T2 | Scaffolding, templates, "new service in one command" |
| **Knowledge / Onboarding Engineer** | T2 | Docs that accelerate onboarding, knowledge management |
| **Support / Escalation Engineer** | T3 | Technical escalations; feeds prod bugs back into DISCOVER |
| **Developer Relations / Advocate** | T3 | External developer adoption, SDK education |
| **Sales / Solutions / Forward-Deployed Engineer** | T3 | Customer-facing technical delivery |
| **Eng Ops / Chief of Staff** | T3 | Standing-org glue across teams |

### ⊗ The Orchestration Layer (the "management" that *does* translate)

| Role | Tier | What it owns |
|---|---|---|
| **Orchestrator / Chief (Tier 0)** | **T1** | Decompose → route → synthesize. Absorbs delegation. |
| **Domain Lead (Tier 1)** *(×5)* | **T1** | Owns a super-domain; delegates; raises recruiting reqs |
| **Team Composer / Staffing** *(new)* | T2 | Tailors which agents deploy *per project* — boosts focus & effectiveness |
| **Recruiter / Talent Acquisition** *(new)* | T2 | Fulfills requisitions from Domain Leads (req-based, approved) |

> **People-management does NOT translate** (reviews, careers, 1:1s, hiring humans). What
> translates is *orchestration* — decompose, delegate, synthesize, recruit — which lives in
> the tiers above + `CLAUDE.md`/shared rules + Eval + you. Don't build an "Engineering
> Manager agent"; it would have nothing to do.

---

## Part 3 — Seniority Levels (the IC Ladder)

| Level | Title | Scope | Meaning |
|---|---|---|---|
| L3 | Engineer II | Task | Executes defined tasks |
| L4 | Engineer III | Component | Owns a component |
| L5 | Senior | Feature | Leads features, junior mentor |
| **L6** | **Staff** | **System** | **Architecture, sets standards** |
| **L7** | **Senior Staff** | **Multiple systems** | **Cross-team influence** |
| **L8** | **Principal** | **Organization** | **Org-wide technical direction** |
| L9 | Distinguished | Company/industry | Influences the industry |

> **"Ace, 20 years" = L6–L8.** Target zone for every agent's seniority traits.

---

## Part 4 — Five Meta-Insights for Building the Agents

**1. Role vs. Culture** (the DevOps lesson). Some things are **agents** (role); some are
**shared rules** every agent inherits (culture — via Skill/injected block). "Backend
Engineer" = agent. "Write tests, no shortcuts" = culture.

**2. Continuous vs. Project-based.** DISCOVER, IMPROVE and AI-OPS run *continuously* (even
on a live product); BUILD is *triggered per task*. Determines **when** each agent fires.

**3. Horizontal Capabilities → Review-Gate Agents.** Guilds/councils/champions
(Security, Architecture, Reliability, a11y, Trust & Safety) become **cross-cutting reviewer
agents that join at the review gate**, not standing teams. Cleanest way to enforce
consistency without spawning an org per standard.

**4. The Proof-Gate Spine** *(new).* "Proof" is not one role — it's a **gate at every
stage**, and it's the backbone that produces rare-quality results:
`POC (technical feasibility) → Experiment (market demand) → Eval (AI output quality) →
QA/Test (code correctness) → Architecture Review (design soundness) → AI Red Team (agent
safety)`. Every artifact passes a proof gate appropriate to its stage *before* it advances.
This is the structural reason POC matters — it's the first gate of a continuous spine.

**5. The Self-Improving Org** *(new).* The AI-native superpower. A closed loop:
a failure caught (by Critic, Eval, or AI Red Team) becomes a **regression dataset** → feeds
Eval → updates the shared **culture/Skills** → the whole org gets permanently better. Humans
forget lessons between projects; this org *compounds* them. Pair this with the design
principle below.

> **Design principle — inherit strengths, not defects.** Model the *role's expertise*, never
> the human's flaws: no sloppiness, no fatigue limits (agents run continuously), no ego,
> politics, turf, knowledge-silos, handoff-loss, or resistance to feedback. Take the
> 20-years-of-judgment; leave the bad Monday morning.

---

## Part 5 — Grounding (Where This Comes From)

- **Claude Code team:** Engineers, PM, Design, Data Science — a full product team.
- **Anthropic compiler experiment:** specialized parallel agents — coalescing duplicate
  code, performance, efficient output, design critique, documentation.
- **Google:** 8 engineering job families + IC ladder (L3–L9) + dedicated roles.
- **SRE/DevOps:** "class SRE implements DevOps" — culture vs. implementation.
- **Product Discovery:** Cagan (4 questions), Torres (product trio, continuous discovery).
- **Mixture-of-Agents (MoA):** querying multiple LLMs + an aggregator beats single models —
  the validated basis for a multi-model product.
- **AI Red Teaming (2026):** Anthropic, Google, OpenAI, Microsoft all run dedicated AI Red
  Teams; the work is now *agent-orchestrated* (agents attacking agents). AI red teaming ≠
  safety benchmarking ≠ classic pen-testing — it's its own discipline, and failing traces
  feed back into evals (the self-improving loop).

---

## Part 6 — Reconciled Overlaps: Do NOT Build These as Separate Agents

The biggest build-phase risk is **over-spawning**: three near-identical agents where one
belongs. Build the **left**, not the right.

| Build this one agent | Do NOT also spawn | Why |
|---|---|---|
| **Platform / Infrastructure** | Networking, Storage, Systems | Platform specialties; split only at massive scale |
| **EngProd** | Build-Systems Engineer | Build/monorepo perf is an EngProd concern here |
| **Capacity / Cost / FinOps** | a separate "FinOps Agent" | Same role; FinOps is its modern name |
| **SRE** | Incident Commander | Incident command is a *hat the SRE wears* |
| **Release Engineer** | Release Manager | Fold cross-product coordination into TPM |
| **AI / LLM Platform** | Memory, Context, Routing, Retrieval Eng | *Components* of the Platform role, not 4 agents |
| **Software Architect** | Enterprise Architect | Product company ≠ legacy-integration shop |
| **Analytics Engineer** | BI Engineer | Thin distinction at this scale |
| **Data Engineer** | Data Quality Engineer | Validation/lineage is a Data-Eng responsibility |

### ⚠️ The Four "Attackers" — the single most important disambiguation

Four roles live in the "adversarial" neighborhood and *will* collide if not named
precisely. Three attack; one defends:

| Agent | Attacks / Owns | Question it asks |
|---|---|---|
| **Critic / Adversarial Reviewer** (④) | The **work product** — design, logic, code quality | "Is this *good work*?" |
| **Offensive Security / Pen-Tester** (②) | The **system's classic security** — infra, app, network | "Can I *break in*?" |
| **AI Red Team / Adversarial AI** (⑤) | The **AI/agent behavior** — jailbreaks, prompt injection, tool-poisoning | "Can I make the *agent misbehave*?" |
| **Trust & Safety / Guardrails** (⑤) | *Builds the defenses* the AI Red Team tries to break | "Will the defenses *hold*?" |

Keep these four named unambiguously, or you'll build one agent doing four jobs badly.

---

*End of map v1.2. Next phase: capabilities, traits, and knowledge per role — starting with
the T1 core.*
