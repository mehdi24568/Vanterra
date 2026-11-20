# Publishing the repository

**Status:** pushed to a **private** GitHub repository, `mehdi24568/vanterra`, branch `main` (tracking `origin/main`). Git is the portable install in `.tools/git` (put `.tools\git\cmd` on PATH). Authentication uses Git Credential Manager with the device-code flow, set in the repository's local config. Commits use the GitHub no-reply address. The steps below record how the repository was prepared, and what to check before making it public.

**Licensing:** no `LICENSE` file is included. For a private repository that means all rights reserved, which is fine. Before making it public, choose a licence: MIT or Apache-2.0 if you want reuse, or keep none if you want to show the work without granting rights.

## 1. Decide first

| Decision | Options | Note |
| --- | --- | --- |
| Visibility | public / private | Public is needed for a portfolio link |
| Licence | e.g. MIT, Apache-2.0, or none ("all rights reserved") | No `LICENSE` file is included; add one if you choose a licence |
| Repository name | suggested: `vanterra` | |
| Description | see docs/PORTFOLIO.md | |

## 2. Check before the first commit

Run these from the project root:

```bash
npm run check
```

```bash
git status --ignored
```

Confirm that the ignored list includes `node_modules/`, `dist/`, `.tools/` and any `.env.local`, and that **no `.env.local` or other file containing a key** is about to be committed. `.env.example` contains no values for secrets and is meant to be committed.

Search the tree for anything that looks like a key before committing:

```bash
git grep -n -I -E "sk-ant-|ANTHROPIC_API_KEY=.+" -- . ":!*.md" ":!.env.example"
```

It should print only the three lines in `server/atlasAi.test.ts` that use the deliberately fake fixture `sk-ant-test-not-a-real-key`. Anything else must be removed before committing.

## 3. Create the local repository

```bash
git init -b main
```

```bash
git add .
```

```bash
git commit -m "Vanterra: cyber-physical intelligence platform"
```

## 4. Publish with the GitHub CLI

```bash
gh repo create vanterra --public --source . --push --description "Cyber-physical intelligence platform: process anomaly detection, a simulated OT network with rule-based detection, evidence-bound cyber-physical assessment, a 3D digital twin, and a bounded five-agent LLM review with human-only confirmation. Simulated environment."
```

Use `--private` instead of `--public` if you prefer. Then add topics:

```bash
gh repo edit --add-topic cyber-physical-systems,ot-security,ics-security,industrial-ai,anomaly-detection,root-cause-analysis,digital-twin,llm-agents,explainable-ai,human-in-the-loop,typescript,threejs
```

**Without the GitHub CLI:** create an empty repository on github.com (no README, no .gitignore), then:

```bash
git remote add origin https://github.com/<your-account>/vanterra.git
```

```bash
git push -u origin main
```

## 5. After publishing

- Open the repository page and check that the README's screenshots render.
- Make sure the README's "AI status" note matches reality. If you have since run `npm run eval:live`, commit `eval/results/agentic-live.*`, update EVALUATION.md §4 and §5, and regenerate the AI screenshots with a real key (`npm run capture`).
- Optionally pin the repository on your profile.

## What a fresh clone needs

```bash
npm install
```

```bash
npm run dev
```

Node.js 20+ and a WebGL2 browser. Everything except AI review works with no configuration. AI review needs `ANTHROPIC_API_KEY` in `.env.local`.
