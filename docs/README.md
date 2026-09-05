# Vole documentation

Start here. Each guide is written for a specific job.

| If you want to… | Read |
|---|---|
| Understand what the project is and run it | [../README.md](../README.md) |
| Understand how it is put together | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Understand what each tool writes to disk | [DATA-SOURCES.md](DATA-SOURCES.md) |
| Set up, run, debug and test it | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Add a tool, a rule, or a panel | [EXTENDING.md](EXTENDING.md) |
| Understand *why* it looks like this | [DECISIONS.md](DECISIONS.md) |
| Find something worth building next | [ROADMAP.md](ROADMAP.md) |
| Read or share everything offline | **[Vole-Documentation.pdf](Vole-Documentation.pdf)** |

The PDF is generated from these markdown files by `pnpm docs:pdf`. The markdown is the source of
truth — regenerate the PDF after editing anything here.

---

## Suggested reading order

**If you are evaluating the project** (30 minutes)

1. [../README.md](../README.md) — what it does and the data-honesty model
2. [DECISIONS.md](DECISIONS.md) — the five bugs that shaped the architecture
3. Run `pnpm collect:once && pnpm verify` and read the output

**If you are going to work on it** (half a day)

1. [DEVELOPMENT.md](DEVELOPMENT.md) — get it running, learn the commands
2. [ARCHITECTURE.md](ARCHITECTURE.md) — module map, schema, layering rules
3. [DATA-SOURCES.md](DATA-SOURCES.md) — the domain knowledge, and where tools lie to you
4. [EXTENDING.md](EXTENDING.md) — pick a recipe and follow it end to end
5. [ROADMAP.md](ROADMAP.md) → *Good first issues*

**If you are debugging a wrong number**

1. [DEVELOPMENT.md → Debugging recipes](DEVELOPMENT.md#debugging-recipes)
2. [DATA-SOURCES.md](DATA-SOURCES.md) for the specific tool's traps
3. `pnpm verify`

---

## The one-paragraph summary

Vole reads the logs AI coding agents already write to disk, normalises them into a single
SQLite schema, and applies explainable rules to surface *misbehaviour* — runaway loops, burn spikes,
retry storms, rate-limit and context pressure — alongside spend, in a native macOS menu-bar app.
Its organising principle is that **different tools expose wildly different data, and the product
must never hide that difference**: every number is tagged `exact` or `activity_only` (there is no
"estimated" tier), absent data is `NULL` rather than `0`, and `pnpm verify` reconciles every stored
row against its own source record.
