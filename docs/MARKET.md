# Market — why companies buy AI-agent telemetry, and who else sells it

Research compiled 2026-09-07 by a 13-agent web survey: 275 sourced findings, 62 competing
products, 27 dated incidents, and the on-disk footprint of 22 AI tools. Every claim carries a
source URL and date; claims marked **[secondary]**, **[single-source]** or **[contested]** were
not confirmed against a primary. Structured extracts — the competitor matrix, the incident table
and the per-tool artifact map — are in [`enterprise/market.json`](enterprise/market.json).

The features this evidence argues for are in [ENTERPRISE-ROADMAP.md](ENTERPRISE-ROADMAP.md).

---

## 1. Why companies need this

**Drivers**

- Coding agents are now mainstream and multi-vendor. 49.5% of developers used a coding assistant by Dec 2025 (from ~20% in Jan); the share using two or more doubled to 32%; 63% of engineers run them on macOS (Cyberhaven 2026 report, https://info.cyberhaven.com/hubfs/Webflow_Resources/Cyberhaven-AI-Risk-Report-2026.pdf, 2026). Claude Code reached 18% work adoption (24% US/Canada), tied with Cursor, behind Copilot 29% (40% in >5,000-employee firms) (JetBrains, https://blog.jetbrains.com/research/2026/04/which-ai-coding-tools-do-developers-actually-use-at-work/, 2026-04). Codex passed 5M WAU (Constellation, https://www.constellationr.com/insights/news/openai-touts-broadening-codex-usage-5-million-weekly-active-users, 2026-06-02) **[secondary; OpenAI post 403]**.
- Spend exists. Coding tools were $4.0B of enterprise GenAI spend in 2025, up from ~$550M (Menlo Ventures, https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/, 2025-12-09). Anthropic run-rate passed $47B with >1,000 customers spending >$1M/yr (https://www.anthropic.com/news/series-h, 2026-05-28).
- Personal accounts dominate exactly where agents run. 58.2% of Claude usage is via personal accounts vs 32.3% for ChatGPT (Cyberhaven 2026). 47% of workplace GenAI users use personal accounts; average org logs 223 GenAI policy violations/month (Netskope via Infosecurity, https://www.infosecurity-magazine.com/news/personal-llm-accounts-drive-shadow/, 2026-01-07) **[secondary]**. 67% of AI access on corporate devices uses non-corporate accounts; source code was the #1 data type across 858,440 DLP events (DBIR 2026 via Kiteworks, https://www.kiteworks.com/cybersecurity-risk-management/shadow-ai-data-leakage-governance/, 2026-05-20) **[secondary]**.
- Endpoint agents are the new risk surface. Endpoint-based AI agent adoption grew 276% YoY (Cyberhaven, https://www.cyberhaven.com/press-releases/cyberhaven-closes-the-ai-security-gap-amid-the-meteoric-rise-of-agentic-ai, 2026-03-24). Zscaler: many orgs "still lack a basic inventory of active AI models"; Codeium alone logged 242M DLP violations (https://www.zscaler.com/press/zscaler-2026-ai-threat-report-83-year-over-year-surge-ai-activity-creates-growing-oversight, 2026-01-27).
- Agents act out of scope and nobody can prove what they did. 65% of enterprises saw agents act outside intended scope; 46% cannot produce a 30-day audit trail; 47% lack an agent inventory (EMA/Cequence via Infosecurity, https://www.infosecurity-magazine.com/news/65-percent-enterprises-ai-agents/, 2026-09-01).
- Breach economics. Shadow AI added USD 670K to average breach cost; 97% of AI-incident orgs lacked AI access controls (IBM 2025, https://www.ibm.com/think/x-force/2025-cost-of-a-data-breach-navigating-ai, 2025-07-30). 2026 edition: $4.99M average; 21% had AI model/app incidents (https://newsroom.ibm.com/2026-07-29-ibm-study-one-in-four-malicious-breaches-are-ai-enabled,-costing-companies-6-million-on-average, 2026-07-29); shadow-AI share of breaches 43%, $5.39M average, audits for unsanctioned AI fell to 29% (ComplexDiscovery analysis, https://complexdiscovery.com/policy-without-control-the-ai-governance-gap-in-ibms-2026-cost-of-a-data-breach-report/, 2026) **[secondary]**.
- Board and analyst pressure. 72% of S&P 500 disclose material AI risk (Harvard Law Forum, https://corpgov.law.harvard.edu/2025/10/15/ai-risk-disclosures-in-the-sp-500-reputation-cybersecurity-and-regulation/, 2025-10-15). Gartner: >40% of orgs will suffer shadow-AI incidents by 2030; "conduct regular audits for shadow AI" (via Infosecurity, https://www.infosecurity-magazine.com/news/gartner-40-firms-hit-shadow-ai/, 2025-11-20) **[secondary; Gartner 403]**. Gartner sizes "AI Usage Control" at $433M→$749M (+73%) in 2027 (via cloudnews.tech, https://cloudnews.tech/ai-security-spending-takes-off-market-to-hit-4-8-billion-in-2027/, 2026-08-26) **[secondary]**.
- Vendors disclaim detection. Anthropic: "Claude Code emits the raw event stream only. Anomaly detection, baselining, correlation across sessions, and alerting are the responsibility of your SIEM" (https://code.claude.com/docs/en/monitoring-usage, accessed 2026-09-06).

**Incident timeline** (see structured `incidents` for detectability)

- 2023-05 Samsung bans GenAI after engineers paste source code into ChatGPT (https://techcrunch.com/2023/05/02/samsung-bans-use-of-generative-ai-tools-like-chatgpt-after-april-internal-data-leak/).
- 2025-03-18 Rules File Backdoor: hidden Unicode in .cursorrules/copilot-instructions (https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents).
- 2025-04-01 MCP tool poisoning leaks ~/.ssh/id_rsa via Cursor (https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks).
- 2025-05-26 GitHub MCP toxic flow: private repo → public PR (https://invariantlabs.ai/blog/mcp-github-vulnerability).
- 2025-06 EchoLeak CVE-2025-32711, zero-click M365 Copilot exfil (https://www.hackthebox.com/blog/cve-2025-32711-echoleak-copilot-vulnerability).
- 2025-07-08 Supabase MCP + Cursor leaks integration_tokens under service_role (https://generalanalysis.com/blog/supabase-mcp-blog).
- 2025-07-21 Replit agent deletes prod DB during code freeze (https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/).
- 2025-07-23 Amazon Q 1.84.0 ships attacker-committed wipe prompt (https://github.com/aws/aws-toolkit-vscode/security/advisories/GHSA-7g7f-ff96-5gcw).
- 2025-07-28 Gemini CLI README hijack exfiltrates env vars (https://tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack).
- 2025-08-05 Cursor MCPoison CVE-2025-54136 / CurXecute CVE-2025-54135 (https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/).
- 2025-08-19 Amazon Q `find -exec` RCE via readonly allowlist (https://embracethered.com/blog/posts/2025/amazon-q-developer-remote-code-execution/).
- 2025-08-26 Nx s1ngularity uses `claude --dangerously-skip-permissions` for secret recon; >1,700 users leaked (https://www.wiz.io/blog/s1ngularitys-aftermath, 2025-09-03).
- 2025-10-08 CamoLeak CVSS 9.6 Copilot Chat exfil (https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code).
- 2025-12-03 Claude Code CVE-2025-66032 $IFS bypass (https://github.com/advisories/GHSA-xq4m-mc3c-vvg3).
- 2025-12-08 Claude Code `rm -rf ... ~/` wipes a Mac (https://www.docker.com/blog/coding-agent-horror-stories-the-rm-rf-incident/, 2026-06-01).
- 2025-12-16 Claude Code/Cursor .env and API-key leak incidents (https://www.knostic.ai/blog/claude-cursor-env-file-secret-leakage).
- 2026-02-24 Claude Code project-file RCE + API key exfil via ANTHROPIC_BASE_URL, CVE-2025-59536/CVE-2026-21852 (https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/).
- 2026-04-27 Live credentials in 33 .claude/settings.local.json files on npm (https://bdtechtalks.com/2026/04/27/claude-code-api-token-leak/) **[secondary; Lakera post 404]**.
- 2026-05-11 Claude Code prints PINECONE_API_KEY despite CLAUDE.md rule; closed not planned (https://github.com/anthropics/claude-code/issues/58043).
- 2026-05-27 Malware-Slop npm package uploads Claude working dir (https://thehackernews.com/2026/05/malicious-npm-package-stole-files-from.html).
- 2026-06-12 Agentjacking via Sentry MCP into Claude Code/Cursor/Codex (https://labs.cloudsecurityalliance.org/research/csa-research-note-agentjacking-mcp-sentry-injection-20260612/).
- 2026-07-02 Cursor DuneSlide CVE-2026-50548/9 sandbox escape (https://thehackernews.com/2026/07/critical-cursor-flaws-could-let-prompt.html).
- 2026-08-04 Keyv npm worm plants Claude Code/VS Code hooks (https://thehackernews.com/2026/08/keyv-linked-npm-worm-poisons-hundreds.html).
- 2026-08-31 METR API key stolen from vibe-coded app, ~$600K burned in 3 weeks (https://www.infosecurity-magazine.com/news/attackers-steal-metr-api-key/, 2026-09-01).
- 2026-09-01 CrowdStrike Falcon Guardian ships shadow-agent inventory (https://www.crowdstrike.com/en-us/press-releases/crowdstrike-unveils-falcon-guardian-ai-agent-security/).
- 2026-09-04 Self-audit of 59 Claude Code transcripts finds 71 secrets incl. live AWS keys (https://dev.to/crypled/i-audited-my-own-claude-code-logs-and-found-real-leaked-credentials-3oo).

**Regulation**

- EU AI Act: Annex III high-risk deferred to 2027-12-02 by Regulation (EU) 2026/1744 (CSA, https://labs.cloudsecurityalliance.org/research/csa-research-note-eu-ai-act-high-risk-deadline-omnibus-20260/, 2026-08-01). Annex III 4(b) covers systems that "monitor and evaluate the performance and behaviour" of workers (https://artificialintelligenceact.eu/annex/3/, 2024-07-12). Art. 26(6) logs ≥6 months; 26(7) worker notice (https://artificialintelligenceact.eu/article/26/). Art. 12 automatic event logging (https://artificialintelligenceact.eu/article/12/). Art. 4 literacy enforcement from 2026-08-02 (https://digital-strategy.ec.europa.eu/en/faqs/ai-literacy-questions-answers, 2026-07-27).
- GDPR Art. 88 names "monitoring systems at the work place" (https://gdpr-info.eu/art-88-gdpr/). Germany § 87(1) Nr. 6 BetrVG; ArbG Hamburg 24 BVGa 1/24 found no co-determination only because the employer had no usage data (https://dejure.org/dienste/vernetzung/rechtsprechung?Text=24%20BVGa%201/24, 2024-01-16). France CNIL: proportionality, CSE consultation, prior notice (https://www.cnil.fr/fr/controle-de-lactivite-des-personnes-employees, 2026-07-09). Netherlands WOR Art. 27 consent once "prompts and usage are logged per employee" (https://www.praxikon.com/en/posts/works-council-consent-ai-in-the-workplace, 2026-07-30).
- California CPPA: ADMT rules from 2027-01-01, risk assessments incl. employment profiling (https://cppa.ca.gov/announcements/2025/20250923.html, 2025-09-23).

## 2. What buyers ask for, by role

- **CISO**: sanctioned vs unsanctioned agent/model/provider inventory per employee and host (Gartner trend #1 2026 via https://softwarestrategiesblog.com/2026/02/10/gartner-cybersecurity-trends-2026/ **[secondary]**); monthly violation and personal-account benchmarks comparable to Netskope's 223/month; agent action trail ≥30 days (EMA); shadow MCP/hook detection (CSA Agentjacking mitigation #1); SIEM-native events not a new console (Nightfall/MintMCP export lists).
- **DPO / works council**: proof no prompt text is stored; pseudonymous per-employee rows; retention ≥6 months but capped; employee transparency screen; no performance scoring (GDPR 88, BetrVG, CNIL, Annex III 4(b), Kolide Privacy Center precedent https://www.1password.community/kb/deploying-1password-device-trust/frequently-asked-questions/152630, 2025-03-04).
- **Platform / security engineering lead**: no proxy in the request path, no base-URL rewrites, no latency; works for subscription-auth agents that gateways cannot see (Bifrost admission https://www.getmaxim.ai/articles/top-5-ai-governance-tools-for-coding-agents-in-2026/, 2026-08-26; Tailscale Aperture https://tailscale.com/blog/aperture-ga, 2026-08-26); policy-drift checks on managed-settings.json / requirements.toml / Gemini system settings, which vendors say are bypassable (https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/enterprise.md); version-vs-CVE floor table; MDM-deployable signed pkg with PPPC profile (https://simplemdm.com/blog/how-to-deploy-crowdstrike-falcon-sensor-with-simplemdm/, 2023-08-23).
- **FinOps**: exact per-user/team/model/session tokens and cost incl. subagent roll-up and cache economics — Cursor's OTel export lacks per-session tool attribution and subagent roll-up and calls cost "best-effort" (https://cursor.com/docs/enterprise/opentelemetry-export); Claude Code Analytics is daily and excludes Bedrock/Vertex (https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api); reconciliation against vendor usage APIs to find shadow spend; "premium model on trivial task" (Island, https://www.island.io/ai).
- **Engineering manager**: adoption phase and surface (terminal/IDE) per tool like Copilot's cohorts (https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics, 2025-10-28); coaching not blocking — blocking is "futile" (Harmonic, https://www.harmonic.security/resources/what-22-million-enterprise-ai-prompts-reveal-about-shadow-ai-in-2025, 2026-01-15).
- **Developer**: zero friction, no hook fragility (redaction-hooks author: "DO NOT rely on this tool", https://raw.githubusercontent.com/l-mb/claude-code-redaction-hooks/main/README.md); open source they can read; own cost/anomaly view for free.

## 3. Competitive landscape

One row per vendor. Full fields in the structured `competitor_matrix`; condensed here. "Stores prompts" = inspects/retains prompt or tool content off-device.

| Vendor | Category | Deployment | Coding-agent coverage | Stores prompts | Pricing |
|---|---|---|---|---|---|
| Cyberhaven | Endpoint DLP + Agentic AI Security | ES-level endpoint sensor + browser ext, cloud | Yes: Claude Code, Cursor, Copilot, Windsurf, Cline, Codex, Antigravity, Gemini; MCP inventory | Yes (lineage/content) | Quote; ~$30-48K/yr est. [secondary] |
| Nightfall | AI-native DLP, agent hooks | Endpoint agent ~50MB/1% CPU + hooks, cloud | Yes: Claude Code CLI/IDE, Cursor, VS Code; stdio/remote MCP discovery | Yes, in-path scan | Per user/yr, amounts hidden |
| Harmonic | GenAI DLP, endpoint + browser + MCP gw | Endpoint agent, ext, OTel ingest | Yes: Claude Code, Codex, Cursor, Copilot, Ollama, MCP; reads full content | Yes | Per user/yr via AWS Marketplace; ~$26M raised |
| Forcepoint | Legacy DLP + AI Data Security | Endpoint DLP agent | Partial: "vibe-coding tools and MCP clients", personal vs corp accounts | Yes | Quote |
| Proofpoint (+Acuvity) | Human-centric suite, agent gateway | Endpoint DLP + MCP gateway + Claude Compliance API | Indirect via Compliance API (Claude Enterprise only) | Yes | Quote |
| Microsoft Purview | DSPM for AI / Endpoint DLP | Browser ext + device onboarding | No: domain wildcard list of browser sites | Yes (audit log) | M365 + PAYG |
| LayerX / Akamai | Browser-extension DLP | Extension via MDM | None verified [contested] | Yes | Per user; ~$205M acq, ~$10M ARR |
| Island | Enterprise browser | Chromium browser | Claimed Bash/MCP/agent discovery; mechanism undocumented | Yes | Quote |
| Menlo Security | Browser isolation | Cloud browser + ext | None | Browser DLP | Variable per user |
| Netskope | SASE inline proxy | Client → cloud proxy | Traffic-level only [contested; pages JS-only] | Inline inspection | Quote |
| Zscaler | SASE + AI Access Security | Client Connector proxy | Traffic-level only | Inline inspection | Quote |
| Palo Alto (AI Access, AIRS 3.0, Koi) | SASE + AI runtime + agentic endpoint (pending) | Proxy, gateway, Cortex XDR | Announced post-Koi close; today network/gateway | Inline | Quote |
| Cato / Aim | SASE shadow AI | Cato client | Cursor/Copilot as traffic | Inline | Bundled |
| SentinelOne / Prompt Security | EDR + GenAI runtime | ES sysext + NE + ext + MCP gw | Claude Code endpoint support since 2025-06-26 | Inline | Bundled; ~$250M acq [secondary] |
| Check Point / Lakera | Runtime guardrails | Guard API | Via API only | Prompts sent to API | Quote; ~$300M acq [secondary] |
| CrowdStrike Falcon AIDR / Guardian | EDR-centric AI agent security | Falcon sensor + proxies/ext/SDK | Yes: shadow-agent inventory macOS/Windows, causal chain | Inspects/redacts inline; SIEM retention | Per endpoint |
| Sysdig | Runtime security (Falco) | Kernel agent | Claude Code, Codex, Gemini, Cursor detections | No (syscall) | Subscription |
| HiddenLayer | Endpoint agentic runtime | Endpoint agent | Generic agentic runtime | Not stated | Quote |
| Zenity | AI agent security (AISPM+AIDR) | Native hooks + OTel, SaaS, no sensor | Claude Code, Cowork, Codex, Copilot, Cursor; MCP inventory; taint tracking | Not stated; collects MCP content | Quote; $125M Series C 2026-08 |
| Noma | Agent security platform | SaaS API connectors | No laptop CLI collector | Not stated | Quote; $100M B |
| WitnessAI | AI usage control | SaaS/gateway | Agent-generic | Not stated | Quote; $58M |
| Straiker | Agentic AI security | SaaS | Coding agents named, mechanism absent | Not stated | Quote; $64M A |
| Pillar | AI-SPM, red team | Self-hosted VPC | Rules-file scanner; catalog scope | Customer-controlled | Quote; $9M seed |
| Lasso | AI security + OSS MCP gateway | Route MCP via gateway | Claude Code/Desktop, Cursor, Windsurf, Codex | Gateway inspects | OSS gw + quote |
| Knostic (Kirin) | IDE-layer agent security | MCP proxy | Copilot, Cursor, Claude Code | Not stated | Not public |
| Operant | Runtime/endpoint/MCP | Endpoint agent + gateway | Claude Code, Cursor, Copilot on devices | Not stated | Quote; $13.5M A |
| General Analysis | AI detection & response | SaaS, in-path guardrails | Codex, Cowork, Copilot, Cursor claimed | Likely | Demo-gated |
| MintMCP | MCP gateway + Agent Monitor | Local hooks + cloud | Claude Code, Cowork, Cursor, Codex, Copilot; tokens by model/user | Yes | Not public; SOC 2 II |
| Speakeasy | MCP gateway + device identity | Gateway + device component | Claude, Cursor, Codex, OpenCode via gateway | Tool args/results | Page exists |
| Bifrost / Maxim | OSS LLM/MCP gateway | Self-host; Edge alpha | Only routed agents; admits rest is shadow AI | Gateway logs | OSS + enterprise |
| Snyk Agent Scan / Invariant | OSS agent/MCP/skill scanner + guardrails | Local CLI, cloud API, proxy | Config discovery: Claude, Cursor, Windsurf, Gemini CLI, Codex, OpenCode, Antigravity, Kiro, Amp, Q, OpenClaw | Proxy sees content | Free CLI; enterprise |
| Cisco AI Defense / Astrix / MCP Scanner | AI security platform, NHI | Cloud + SDK; OSS scanner | Not endpoint | Not stated | Cisco; Astrix ~$400M |
| Wiz AI-SPM | CNAPP | Agentless cloud | None | No | Platform |
| Nudge / Obsidian / Reco | SaaS/identity discovery | API connectors | None on endpoint | No content | Quote |
| Token / Oasis (Cyera $1B) | NHI + agent identity | SaaS connectors | Identity only | N/A | Quote |
| Docker Sandboxes/AI Governance | Execution isolation | Docker Desktop | Sandboxed runs only | Unknown | Business $24/user/mo |
| Legit / Cycode | ASPM | SCM/CI SaaS | Repo signals only | No | Quote |
| Tessl / Semgrep MCP | Skills registry / SAST tool | Registry / local MCP | Not monitors | N/A | OSS / not public |
| Anthropic native (OTel, Analytics API, Compliance API, apps gateway) | Vendor telemetry | Client OTel, Admin APIs, self-hosted gateway | Claude Code only; excludes API-key/Bedrock/personal/Cursor/Codex | Redacted by default; Cowork OTel includes prompts; gateway stores none | Bundled |
| OpenAI Codex (requirements.toml, Analytics, Compliance API) | Vendor telemetry | Workspace console + OTel opt-in | Codex under workspace accounts only; metrics default to OpenAI statsig | OTel off by default | Bundled Enterprise |
| GitHub Copilot (metrics, OTel, audit streaming) | Vendor telemetry | GitHub cloud + client OTel | Copilot family only; ~2 days late; local prompts not in audit log | Audit stream can carry 1MB bodies | Bundled Business/Enterprise |
| Cursor (Admin/Analytics API, OTel export, hooks) | Vendor telemetry | Server-side push/pull | Cursor only; per-event tokens/cents; no per-session tool attribution | No content | Enterprise only |
| Windsurf / Cognition | Vendor telemetry | Pull API | Credits and aggregate tool counts only | No | Enterprise |
| Gemini CLI telemetry | Vendor telemetry | Client OTel/file/GCP | Gemini CLI incl. Zed/Xcode/JetBrains hosts | logPrompts default TRUE | Free |
| Amazon Q dashboards | Vendor telemetry | AWS console/CloudTrail | Q only; acceptance rates, no tokens | No | Pro tier |
| JetBrains Console | Vendor telemetry | Cloud console | Junie, Claude Agent, Codex, Copilot inside IDE; excludes BYOK/provider accounts | No | Bundled |
| Entra Agent ID / Okta for AI Agents | IdP agent identity | Cloud IdP | Only IdP-authenticated agents | No | Entra free; Agent 365 licence |
| Datadog Agent Observability | APM LLM observability | SDK/OTLP | Only via vendor OTel | Yes | $160/mo per 100k spans +$3.50-5/10k |
| Langfuse | OSS LLM observability | SDK/OTLP; MIT self-host | Only via OTLP | Yes | Free/$29/$199/$2,499; $6-8/100k units |
| LangSmith / Helicone / Portkey / Braintrust / Arize / W&B / Honeycomb / New Relic / AgentOps / Galileo / Traceloop | App observability & gateways | SDK or base-URL proxy | None natively | Yes (most by default) | Per seat/trace/GB/request |
| LiteLLM Proxy | OSS gateway | Self-host | Routed agents only | Metadata-only default | OSS + enterprise |
| Kong / Cloudflare AI Gateway | API/edge gateways | Proxy | Routed CLIs only | Kong configurable; Cloudflare stores prompts by default | Kong per service/req; CF free core |
| Tailscale Aperture | AI gateway | Proxy in path | Routed only | Audit trails; unclear | Unpublished |
| Fleet / osquery | Endpoint governance, open-core | osquery agent, MDM | Inventory of MCP/agents/skills/token usage for Claude, OpenAI, Cursor, Windsurf; depth undocumented | No | $0 / $7 host/mo |
| Jamf Protect / SentinelOne / Huntress / Santa / Kolide | Mac EDR/posture | ES sysext via MDM | Process-level only | No | Per device |
| ccusage | OSS local cost CLI | npm local | 18 sources incl. Copilot CLI, Goose, Amp, Gemini CLI, Grok | No | Free MIT |
| TruffleHog / Gitleaks-Betterleaks / detect-secrets / Titus / Kingfisher / GitGuardian / GitHub Secret Protection | Secret scanners | CLI/SaaS | None agent-aware | Findings contain secret unless redacted | OSS / per dev |
| agent-audit / claude-code-redaction-hooks | OSS Claude Code auditors | Local | Claude Code only | No / local mapping file | Free |

**White space analysis**

1. **Nobody is out-of-path, exact, and prompt-free at once.** All 27 security vendors that cover coding agents sit in the request path (hooks, gateways, sensors) and most inspect content; none states prompt retention (Nightfall comparison, https://www.nightfall.ai/blog/ai-agent-security-platforms-securing-claude-code, 2026-08-17). None offers exact per-session token/cost. That intersection is Vole's.
2. **Vendor consoles are single-tool and identity-fragmented**: email vs user_login vs IAM vs credits; each blind to personal accounts, API keys, Bedrock, and other vendors' agents (https://code.claude.com/docs/en/monitoring-usage; https://learn.chatgpt.com/docs/enterprise/admin-setup; https://www.jetbrains.com/help/jetbrains-console/ai-adoption-and-usage.html, 2026-08-27).
3. **Nobody names OpenCode, Grok CLI, Devin or Antigravity** at runtime; only Snyk scans their configs (https://raw.githubusercontent.com/snyk/agent-scan/main/README.md).
4. **Where Vole is a genuine differentiator**: shadow accounts and shadow agents (auth-path-agnostic, plan-agnostic); works-council/DPO acceptability; exact cost + security in one collector; zero developer friction; open source answering the "do you store prompts" question by construction; resilience to macOS point releases that break ES agents (https://support.guardz.com/en/articles/16618592-sentinelone-agent-requirements-on-macos).
5. **Where it is a handicap, stated plainly**: no fleet view today (rows never leave the laptop until sync ships); no real-time blocking (buyers on Harmonic's "phase two" will want inline; Vole must hand off via webhook/hooks); blind to non-CLI shadow AI (web chat, ChatGPT desktop content, hosted agents: Copilot cloud, Codex cloud, Claude Managed Agents https://platform.claude.com/docs/en/managed-agents/overview); blind to npm postinstall stealers and extension compromises (Nx telemetry.js, https://www.wiz.io/blog/s1ngularity-supply-chain-attack, 2025-08-27); Claude Code transcripts are "internal and change between versions" so parsers are a maintenance liability; local evidence is deleted after 30 days by default (https://github.com/anthropics/claude-code/issues/23710); CrowdStrike/PANW/Cisco have distribution Vole cannot match — coexist, do not compete on sensors.

## 4. Vendor-native telemetry per tool and what it does not cover

- **Claude Code**: opt-in OTel (CLAUDE_CODE_ENABLE_TELEMETRY=1), 8 metrics, events tool_decision (source config/hook/user_*), permission_mode_changed, auth, mcp_server_connection, plugin_installed, hook_*; prompts/tool args/content redacted unless OTEL_LOG_* set; MCP names collapse to "custom"/"mcp_tool"; OTEL_* not passed to Bash/hooks/MCP; identity only on OAuth (API-key/Bedrock get user.id only); managed settings can pin OTLP (v2.1.217+). Not covered: anomaly detection, other agents, sessions without telemetry enabled (https://code.claude.com/docs/en/monitoring-usage). Analytics API daily per-user, 1h lag, Claude API only (https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api). Compliance API excludes API-key, Bedrock/Vertex/Foundry, personal accounts, Cursor/Codex (Speakeasy, https://www.speakeasy.com/blog/where-claude-falls-short-in-ai-security, 2026-05-15). Apps gateway: identity-stamped, no prompt storage, Claude only (https://code.claude.com/docs/en/claude-apps-gateway). Cowork OTel includes full prompts by default, Team/Enterprise only (https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry).
- **Codex CLI**: [otel] in user config.toml, exporter none by default, metrics default to OpenAI statsig, log_user_prompt false; ignored in project-local config; `codex exec` no metrics, `codex mcp-server` no telemetry (issue #12913, 2026-02-26). Governance only for ChatGPT-workspace accounts (https://developers.openai.com/codex/config-reference; https://developers.openai.com/codex/enterprise/governance). approval_policy=untrusted retired in 0.149.0 without deprecation (https://github.com/openai/codex/issues/39973, 2026-08-20).
- **GitHub Copilot**: usage metrics disabled by default, depend on IDE telemetry, ~2-day lag, AI credits not tokens; audit log excludes local prompts; EMU streaming of full bodies in preview with 48h REST window (https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics; https://github.blog/changelog/2026-07-02-copilot-agent-session-streaming-is-now-in-public-preview/). Content exclusion unsupported in Edit/Agent modes (https://docs.github.com/en/copilot/concepts/context/content-exclusion). Copilot CLI OTel excludes prompts; local session store holds prompts (https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle).
- **Cursor**: Enterprise-only Admin/Analytics APIs with per-event tokens, chargedCents, MCP adoption, audit events privacy_mode/mcp_server_config; server-side OTel push: no prompts, no traces, no backfill, no per-session tool attribution, no subagent roll-up, cost best-effort (https://cursor.com/docs/account/teams/admin-api; https://cursor.com/docs/enterprise/opentelemetry-export). Personal-account login blocked only via MDM Allowed Team IDs (https://cursor.com/docs/enterprise/privacy-and-data-governance).
- **Windsurf/Devin**: daily aggregates, credits, tool-category counts, no tokens, CLI rows lack mode (https://docs.windsurf.com/windsurf/accounts/api-reference/cascade-analytics).
- **Gemini CLI**: richest schema (tool_call decision, tool_type, mcp_server_name, conseca verdicts, approval_mode) but logPrompts defaults true and system settings are "not a foolproof security boundary" (https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md; .../enterprise.md).
- **Amazon Q**: acceptance rates, CloudTrail events, no tokens, no prompts (https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/monitoring-telemetry.html).
- **JetBrains Console**: credits across Junie/Claude Agent/Codex/Copilot in-IDE; excludes BYOK and provider-account agents; audit/API "upcoming" (https://www.jetbrains.com/help/jetbrains-console/ai-adoption-and-usage.html, 2026-08-27).
- **Common gap**: none sees a competitor's agent, a personal account, or a raw-key session; none ships anomaly detection; freshness 5 min–2 days.

## 5. Standards and frameworks mapping

| Framework | Control | Vole evidence |
|---|---|---|
| NIST AI 600-1 (https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf, 2024-07-25) | GV-1.6-001 inventory GAI systems; GV-6.1-007 third-party inventory/approved provider list; GV-6.2-004 continuous monitoring; MS-2.7-004 unauthorized access attempts | Per-host agent/model/provider inventory; sanctioned tags; denied-tool counts |
| NIST COSAiS 800-53 overlays (https://csrc.nist.gov/Projects/cosais/use-cases, 2026-01-08) | AU-2/AU-3/AU-6/AU-12, SI-4, AC-6 | Session/tool-call rows with who/what/when/outcome; permission-mode records |
| ISO/IEC 42001 A.6.2.8 / A.6.2.6 (https://www.isms.online/iso-42001/annex-a-controls/a-6-ai-system-life-cycle/a-6-2-8-ai-system-recording-of-event-logs/, 2025) [secondary] | Event-log recording in use phase; tamper-resistant logs | Hash-chained SQLite export with real identities |
| SOC 2 CC6/CC7.1/CC9.1 (https://linfordco.com/blog/shadow-ai-soc-2/, 2026-03-18) | Approved vs unauthorized tool inventory; detection | Approved/unapproved per user report |
| CSA AICM v1.1 / AI-CAIQ (https://cloudsecurityalliance.org/blog/2026/07/14/ai-controls-matrix-v1-1-strengthening-the-foundation-for-trustworthy-ai) | 247 objectives incl. Model Security | Pre-filled CAIQ answers |
| OWASP LLM Top 10 2025 (https://genai.owasp.org/llm-top-10/) | LLM02, LLM06, LLM10 | Secret detector, permission anomalies, token spikes |
| OWASP Agentic Top 10 (https://genai.owasp.org/2025/12/09/...) and ACS (https://genai.owasp.org/resource/agent-control-standard-acs/, 2026-09-01) | ASI02/03/05/10; "inspectable, traceable" | Incident tags; Vole is the inspect/trace layer |
| OWASP MCP Top 10 (https://raw.githubusercontent.com/OWASP/www-project-mcp-top-10/main/index.md) | MCP08 audit/telemetry; MCP09 shadow MCP | MCP inventory with change alerts |
| MITRE ATLAS v5.6.0 (https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/ATLAS.yaml) | AML.T0098, T0086, T0101, T0034.002, T0112.000 | Credential-path reads, read-then-egress, delete bursts, token burn |
| EU AI Act Art. 12, 26(6), 26(7), Art. 4 | Logging, ≥6-month retention, worker notice, literacy record | Retention floor, transparency notice, per-user tool list |
| CSA Agentic RMF profile (https://labs.cloudsecurityalliance.org/agentic/agentic-nist-ai-rmf-profile-v1/, 2026-03-27) | AG-MS.1 action velocity, AG-GV.3 registry, AG-MS.2 drift | Tool-call rate metrics, MCP config hashes |
| COSO GenAI (https://www.journalofaccountancy.com/news/2026/feb/coso-creates-audit-ready-guidance-for-governing-generative-ai/, 2026-02-26) | Illustrative metrics | Metrics pack export |

Caveat: whether a rule-based engine is an "AI system" under Annex III 4(b) is unsettled; keep detections deterministic and never emit performance scores.

## 6. Detection technology choices

- **Source of truth = on-disk logs already written** (Claude Code JSONL carries permissionMode, entrypoint, version, cwd, gitBranch, Bash input.command, hook/MCP attachments; Vole currently discards most — file://packages/core/src/collectors/claude-code.ts). Versioned parsers with fixtures and a schema-drift incident are mandatory (Anthropic warning).
- **Secrets**: keyword prefilter → provider regex → entropy + stopword + token-ratio → dedupe by keyed fingerprint (Gitleaks https://raw.githubusercontent.com/gitleaks/gitleaks/master/README.md; Betterleaks https://raw.githubusercontent.com/betterleaks/betterleaks/main/docs/config.md; detect-secrets hashed baseline https://github.com/Yelp/detect-secrets/blob/master/docs/design.md; Nosey Parker dedupe https://raw.githubusercontent.com/praetorian-inc/noseyparker/main/README.md). Entropy alone fails (https://github.com/gitleaks/gitleaks/issues/1830). JWT: decode offline, keep alg/iss/exp only (https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/pkg/detectors/jwt/jwt.go). Verification off by default (network); opt-in via TruffleHog/Kingfisher (https://trufflesecurity.com/blog/how-trufflehog-verifies-secrets; https://raw.githubusercontent.com/mongodb/kingfisher/main/README.md). Use GitHub's detector taxonomy for naming (https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns, 2026-03-10).
- **PII/PCI/PHI**: checksum-gated regex (Luhn, IBAN) + context words per Presidio (https://data-privacy-stack.github.io/presidio/supported_entities/); HIPAA 18 identifiers (https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html); no NER on-device — label as not detected.
- **Behaviour**: command-string classifier (rm -rf ~, force-push, find -exec, curl|sh, $IFS, whitespace padding), sensitive-path reads, read-then-publish sequences, config-file hash drift (MCP/hooks/rules), hidden-Unicode scan, version-vs-CVE floors, bypass-mode sessions. All derivable from tool names + coarse args; never store the string beyond a pattern id.
- **Do not build**: prompt-injection classifiers (Lakera space), kernel/ES sensors, NetworkExtension DNS attribution (DoH bypass, https://fleetdm.com/guides/monitor-dns-traffic-on-macos), MCP scanners (Snyk/Cisco are free).
- **Cheap adjuncts**: unprivileged socket sampling for agent PIDs (https://fleetdm.com/tables/process_open_sockets); local-LLM ports 11434/1234/1337/4891 (https://www.splunk.com/en_us/blog/artificial-intelligence/detecting-local-llms-shadow-ai-splunk.html, 2025-12-04); code-signing identity via SecStaticCode (Santa pattern, https://raw.githubusercontent.com/northpolesec/santa/main/README.md); optional localhost OTLP receiver.
- **Export**: OTLP with gen_ai.* (provider.name, input_tokens/output_tokens, never input.messages) pinned to a semconv snapshot — conventions are still Development with no tagged release (https://github.com/open-telemetry/semantic-conventions-genai/releases; https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke, 2026-07-16). Audit rows shaped like IETF draft-klrc-aiagent-auth-03 (https://www.ietf.org/archive/id/draft-klrc-aiagent-auth-03.html, 2026-07-06).

## 7. Endpoint architecture and privacy patterns to copy

- **Signing/notarisation first**: Sequoia removed Control-click override (https://developer.apple.com/news/?id=saqachfa, 2024-08-06). ES entitlement is a multi-month Apple process and unnecessary for file reading (https://www.huntress.com/blog/endpoint-security-in-a-macos-world, 2023-04-25).
- **MDM kit**: PPPC SystemPolicyAllFiles by bundle ID + code requirement, profile before pkg (CrowdStrike recipe, https://simplemdm.com/blog/how-to-deploy-crowdstrike-falcon-sensor-with-simplemdm/). Reduced-functionality state when FDA missing: report unknown, not zero.
- **Four-part layout** (Santa): app, launchd collector, optional sync, CLI.
- **Privacy Center** (Kolide): per-user manifest of every path read and field stored; Honest Security tenets (https://www.1password.community/kb/deploying-1password-device-trust/frequently-asked-questions/152630).
- **Metadata-only default** (LiteLLM spend logs, Anthropic gateway) with pseudonymous enterprise mode, admin re-identification, retention cap, no performance views.
- **Footprint bar**: ~50MB/1% CPU, MDM rollout ~30 min (Nightfall claim, https://www.nightfall.ai/blog/ai-agent-security-platforms-securing-claude-code) **[vendor claim]**.
- **Fleet/osquery integration** rather than a second agent: expose Vole tables (https://fleetdm.com/endpoint-governance).
- **Trust page** before first pilot: SOC 2 timeline, pen test, subprocessors, DPA, region choice (https://copla.com/blog/third-party-risk-management/guide-to-vendor-security-and-risk-assessment-questionnaires/, 2026-06-02); SAML + SCIM (Cyberhaven lacks SCIM, https://www.stitchflow.com/scim/cyberhaven).

## 8. GTM, pricing and licence recommendation

- **Licence**: keep collectors, rules, schema and Mac app MIT; put fleet sync, SSO/SCIM, audit log, retention, RBAC in `/ee` behind a licence key (Langfuse https://langfuse.com/pricing-self-host; PostHog https://posthog.com/docs/self-host/open-source/disclaimer.md; Fleet MIT + ee/). Keep the endpoint permissive regardless of server terms (Grafana pattern, https://grafana.com/blog/grafana-loki-tempo-relicensing-to-agplv3/, 2021-04-21). If hosted clones become a fear, FSL on the server only (https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding, 2023-11-17).
- **Pricing**: per "active agent host" (≥1 session in last 30 days; Snyk's 90-day contributing-developer model https://snyk.io/plans/) at ~$7–10/host/month (Fleet $7/host https://fleetdm.com/endpoint-governance; Semgrep $30/contributor https://semgrep.dev/pricing). Free ≤10 hosts; licence required for the signed binary above ~100 employees while source stays MIT (Teleport, https://goteleport.com/blog/teleport-community-license/, 2024-03-08). Flat, no per-span/GB meter — the explicit contrast to Datadog/W&B/Braintrust. Export (OTel/SIEM) is the paid gate (Tailscale gates log streaming at Premium).
- **Buyer and budget**: sell from the security budget ("AI Usage Control", +73%) to platform/security teams at firms paying >$1M/yr to Anthropic or Cursor; not the dev-tools budget.
- **Motion**: bottom-up free Mac app → 5–8 design partners for ~6 months with a written agreement and a hard convert-or-leave date (Bessemer, https://www.bvp.com/atlas/design-partners-the-pre-launch-edge-most-ai-founders-ignore, 2026-05-05).
- **Positioning**: "The endpoint evidence layer beside your gateway and EDR: sees every agent, every account, exact cost, never a prompt, never in your request path." Coexist with CrowdStrike/Zscaler/LiteLLM via export; coverage report = agents Vole sees minus agents the gateway sees.
- **Reasoning**: incumbents own blocking and content inspection with sensors and proxies; Vole cannot win there. Open source + local-first shrinks the security questionnaire and passes works councils; per-host flat pricing undercuts per-user multi-year DLP contracts and metered observability; a free tier lands on developer laptops before procurement.

## 9. What we need to do — ordered

1. Developer ID signing, hardened runtime, notarisation, pkg; MDM kit with PPPC profile; FDA-missing state.
2. Extract already-present Claude Code fields (permissionMode, entrypoint, version, gitBranch, Bash command, hook/MCP attachments) and Codex approval/sandbox/shell payloads; add schema-drift incident and per-version fixtures.
3. Session identity classifier (org OAuth / personal OAuth / API key / Bedrock-Vertex-Foundry / workspace vs personal) → "shadow account" incident.
4. Secret/PII scanner in the JSONL tail: `secret_sightings` table with HMAC fingerprint, class, provider, session, offset, status; never the text; scan settings.local.json, MCP configs, spill files.
5. Behaviour rule pack named after Anthropic's event vocabulary: bypass-mode session, destructive command, sensitive-path read, read-then-publish, MCP first-seen/changed, hook added, hidden-Unicode rules file, base-URL override, version below CVE floor; tag with OWASP/ATLAS IDs.
6. Endpoint inventory collectors: installed AI apps (cask-derived bundle IDs), local model runtimes (ports + dirs, no content), MCP servers from config, code-signing identity, socket sampling (low confidence).
7. Widen agents by payoff: Copilot CLI (exact tokens), Gemini CLI, Goose, Amp, Continue; activity-only with "no tokens" badge for Windsurf, Zed, Kiro, Cline/Roo; honour CLAUDE_CONFIG_DIR (Xcode).
8. Privacy Center + data manifest + pseudonymous mode + retention cap + no-performance-score guarantee; DPIA/works-council notice template.
9. Enterprise sync (`/ee`): normalised rows only, OTLP gen_ai.* + Splunk HEC/JSON/syslog, IETF-shaped audit fields, hash-chained export, SAML+SCIM, reconcile job against Anthropic/Cursor/Copilot usage APIs, optional localhost OTLP receiver, read-only MCP server over Vole's SQLite.
10. Trust page, supported-macOS matrix, published footprint numbers; design-partner programme; explicit scope statement (hosted agents, postinstall malware, web chat content out of scope).

## 10. Open unknowns

- Gartner (2025-11-19, 2026-02-05, 2026-08-26), Netskope 2026, IBM 2026 shadow-AI detail, DBIR 2026 and Codex 5M WAU figures are all secondary; primaries were 403/gated/JS-only.
- Whether Claude Code, Codex, Cursor and OpenCode local logs reliably expose account type, org id, email and auth path; whether tool_decision source and permission_mode_changed trigger exist on disk, not just in OTel.
- Whether Codex logs record effective approval_policy/sandbox_mode per session; whether OpenCode/Grok CLI logs carry full shell arguments and approval state.
- Pricing for Cyberhaven, Nightfall, Harmonic, Island, Proofpoint, Forcepoint, SASE vendors, CrowdStrike AIDR, Fleet Premium beyond list; whether any retains prompt text and where.
- Whether Zscaler/Netskope/PANW TLS-inspect CLI API traffic and attribute it to a process; Netskope AgentSkope and Speakeasy Observe unread.
- LayerX IDE coverage [contested]; Palo Alto–Koi close status; Portkey acquisition by PANW seen only via MintMCP.
- Runtime coverage of OpenCode, Grok CLI, Devin, Antigravity by any vendor; Sysdig's macOS mechanism.
- Google Antigravity drive-deletion incident (Dec 2025) not sourced; malware targeting ~/.claude/.credentials.json or ~/.codex/auth.json not confirmed.
- Ollama server.log token logging; Windsurf .pb, Zed threads.db, Kiro CLI session, Warp, Raycast, Perplexity, JetBrains AI on-disk formats.
- Copilot CLI session store SQLite schema; whether events.jsonl always carries token events (version-dependent).
- Whether security buyers accept on-device SQLite as compliance evidence vs demanding server-side retention — design-partner question.
- Whether Vole's rule engine is an "AI system" under the AI Act; AICPA SOC 2 AI updates; ISO 42001 revision status.
- Datadog per-10k overage ($3.50 vs $8 in secondary guides); LangSmith overage; AgentOps pricing (404).
- Regex-scan throughput on Apple Silicon in TypeScript is unbenchmarked.
