export const meta = {
  name: 'pi-goal-ideation',
  description: 'Generate and consensus-vote the top-N pi-goal improvements from research + discovery',
  phases: [
    { title: 'Ideate', detail: 'diverse idea-generation lenses' },
    { title: 'Vote', detail: 'independent judges score the deduped idea pool' },
    { title: 'Rank', detail: 'aggregate votes into a ranked top-N' },
  ],
}

const PI_GOAL_CONTEXT = `
The "pi-goal" extension drives a goal-oriented continuous loop for the "pi" coding agent.
TODAY it: sets a GOAL; injects <goal_state> (tasks + next action) before every LLM call;
adds a mission system prompt; on agent_end runs a COMPLETION GATE that forces another turn
and blocks stopping until the agent calls goal_complete with required structured-evidence
fields (requirementsCovered, verificationsRun, taskEvidence, shortcutsConsidered); has a
goal_task todo tool; persists to SQLite per session.

pi extension API CAPABILITIES (what an improvement can use):
- Hooks: session_start, context (inject msgs before each LLM call), before_agent_start
  (modify system prompt), agent_start/end, turn_start/end, message_*, tool_call (CAN BLOCK
  via {block,reason}), tool_result (CAN MODIFY), tool_execution_*, before/after_provider_*,
  model_select, resources_discover (contribute skill/prompt PATHS), session_compact/tree.
- pi.exec(cmd,args,opts) runs shell commands (tests/lint/typecheck).
- pi.registerTool / registerCommand / registerShortcut / registerFlag / registerMessageRenderer.
- pi.setActiveTools/getActiveTools, pi.setModel, pi.setThinkingLevel, pi.appendEntry, pi.events bus.
- ctx.getContextUsage() (token usage), ctx.compact(), ctx.getSystemPrompt(), ctx.model, ctx.abort().
- Command ctx adds: newSession, fork, navigateTree, switchSession, waitForIdle, reload.
- @earendil-works/pi-ai exposes an Api/streaming surface usable to call a judge/sub-LLM directly.

CONFIRMED DISCOVERY (a known candidate to weigh, with reproduction):
- HEADLESS/PRINT-MODE BUG: in 'pi -p', session_start sees ctx.isIdle()===true while a prompt
  is about to process, so the goal injection takes the plain sendUserMessage() path (no
  deliverAs) and throws "Agent is already processing", killing the run with zero turns. With
  no positional prompt nothing runs at all, and it's unclear the completion-gate followUp loop
  re-triggers turns in print mode. Net: the goal loop is effectively broken in headless mode
  (the very mode used for autonomous/CI automation). Fixable + unit-testable deterministically.

GOAL OF IMPROVEMENTS: raise the QUALITY of the agent's final output for a task — via better
task breakdown, scope enforcement, test/lint as steering pressure, judge evaluation of
completion, specialised subagent workflows, and a background memory/skill-acquisition agent.
Each idea must be implementable inside this extension (no fork of pi core) and ideally
unit-testable with the existing bun test harness.
`

const IDEA_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'problem', 'mechanism', 'hook', 'impact', 'cost', 'risk', 'testable'],
        properties: {
          title: { type: 'string', description: 'short imperative name' },
          problem: { type: 'string', description: 'the quality failure mode it addresses' },
          mechanism: { type: 'string', description: 'how it works, grounded in research where possible' },
          hook: { type: 'string', description: 'which pi API hook/method it uses' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          cost: { type: 'string', enum: ['S', 'M', 'L'] },
          risk: { type: 'string', description: 'failure modes / why it might backfire' },
          testable: { type: 'string', description: 'how to unit/integration test it deterministically' },
        },
      },
    },
  },
}

const VOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['rankings'],
  properties: {
    rankings: {
      type: 'array',
      description: 'every idea scored, best first',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'impact', 'feasibility', 'evidence', 'scopeFit', 'total', 'note'],
        properties: {
          id: { type: 'number', description: 'idea id from the pool' },
          impact: { type: 'number', description: '0-10 expected quality lift' },
          feasibility: { type: 'number', description: '0-10 implementable+testable in this extension' },
          evidence: { type: 'number', description: '0-10 grounded in research/observed behavior' },
          scopeFit: { type: 'number', description: '0-10 fits pi-goal mission without bloat' },
          total: { type: 'number', description: 'weighted total 0-10' },
          note: { type: 'string' },
        },
      },
    },
  },
}

const brief = (args && args.brief) || 'No research brief provided; rely on the context and your knowledge.'

const LENSES = [
  { key: 'completion-honesty', angle: 'Focus on COMPLETION CORRECTNESS: preventing false "done", validation contracts / pre-written acceptance criteria, judge evaluation of the goal_complete evidence against the real diff, verifier-in-the-loop.' },
  { key: 'scope-discipline', angle: 'Focus on SCOPE ENFORCEMENT: tool_call blocking of out-of-scope edits, declared file allowlists, detecting and resisting scope creep, spec adherence.' },
  { key: 'env-pressure', angle: 'Focus on ENVIRONMENT PRESSURE: auto-running tests/typecheck/lint via exec and feeding failures back, treating a red suite as a hard block on completion, definition-of-done as command exit codes.' },
  { key: 'decomposition', angle: 'Focus on TASK BREAKDOWN: auto-decomposition of the goal into tracked subtasks, dependency ordering, progress accounting, mid-turn re-planning.' },
  { key: 'subagent-workflows', angle: 'Focus on SPECIALISED SUBAGENT WORKFLOWS: letting the main agent define/spawn specialised helpers (reviewer, tester, researcher) via pi-ai or pi -p, and orchestrating them; consider omegacode-style patterns.' },
  { key: 'background-learning', angle: 'Focus on a BACKGROUND MEMORY/SKILL-ACQUISITION agent that watches the main agent work (turn_end/tool_result) and patches AGENTS.md, rules, and skills; mid-session steering to fix observed weaknesses (cf. Cursor continual-learning).' },
  { key: 'efficiency-meta', angle: 'Focus on EFFICIENCY & META-CONTROL: token/iteration efficiency, dynamic thinking-level/model adjustment, compaction strategy, avoiding gate-induced thrashing, headless-mode robustness.' },
]

phase('Ideate')
const ideaLists = (await parallel(LENSES.map(l => () =>
  agent(`${PI_GOAL_CONTEXT}\n\nRESEARCH BRIEF:\n${brief}\n\nYOUR LENS: ${l.angle}\n\nPropose 4-7 CONCRETE, implementable improvements to pi-goal through this lens. Each must name the exact pi hook/API it uses and how to test it. Prefer ideas grounded in the research brief. Avoid vague or duplicate ideas; be specific and technical.`,
    { label: `ideate:${l.key}`, phase: 'Ideate', model: 'sonnet', schema: IDEA_SCHEMA })
))).filter(Boolean)

// Flatten + assign stable ids (plain code — barrier already happened above).
const pool = []
for (const r of ideaLists) for (const idea of (r.ideas || [])) pool.push({ id: pool.length + 1, ...idea })
log(`Idea pool: ${pool.length} ideas from ${ideaLists.length} lenses`)

const poolText = pool.map(i => `#${i.id} [${i.impact}/${i.cost}] ${i.title} — problem: ${i.problem} | mechanism: ${i.mechanism} | hook: ${i.hook} | risk: ${i.risk} | test: ${i.testable}`).join('\n')

phase('Vote')
const JUDGES = ['pragmatic-shipper', 'quality-maximalist', 'skeptical-reviewer', 'systems-architect', 'eval-scientist']
const votes = (await parallel(JUDGES.map(j => () =>
  agent(`${PI_GOAL_CONTEXT}\n\nYou are the "${j}" judge. Score EVERY idea in the pool below on impact, feasibility, evidence, scopeFit (each 0-10), and a weighted total (weights: impact 0.35, feasibility 0.25, evidence 0.20, scopeFit 0.20). Be discriminating — do not cluster scores. Penalise ideas that bloat scope, can't be tested, or could induce gate-thrashing.\n\nIDEA POOL:\n${poolText}`,
    { label: `vote:${j}`, phase: 'Vote', model: 'sonnet', schema: VOTE_SCHEMA })
))).filter(Boolean)

// Aggregate votes by idea id (mean total, mean per-dimension).
const agg = new Map()
for (const v of votes) for (const r of (v.rankings || [])) {
  const a = agg.get(r.id) || { id: r.id, totals: [], impact: [], feasibility: [], evidence: [], scopeFit: [], notes: [] }
  a.totals.push(r.total); a.impact.push(r.impact); a.feasibility.push(r.feasibility)
  a.evidence.push(r.evidence); a.scopeFit.push(r.scopeFit); if (r.note) a.notes.push(`${'note'}: ${r.note}`)
  agg.set(r.id, a)
}
const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
const ranked = [...agg.values()].map(a => ({
  id: a.id, idea: pool.find(p => p.id === a.id),
  meanTotal: +mean(a.totals).toFixed(2), nVotes: a.totals.length,
  meanImpact: +mean(a.impact).toFixed(2), meanFeasibility: +mean(a.feasibility).toFixed(2),
  meanEvidence: +mean(a.evidence).toFixed(2), meanScopeFit: +mean(a.scopeFit).toFixed(2),
  notes: a.notes,
})).sort((x, y) => y.meanTotal - x.meanTotal)

phase('Rank')
const topForSynth = ranked.slice(0, 12)
const synthesis = await agent(
  `${PI_GOAL_CONTEXT}\n\nThe ideation panel produced these consensus-ranked top ideas (mean judge scores, JSON):\n${JSON.stringify(topForSynth, null, 2)}\n\nWrite a markdown decision memo: (1) the TOP 5-6 improvements to prototype in parallel worktrees, each with a one-line spec, the pi hook it uses, the deterministic test that proves it, and expected quality impact; (2) which can be combined vs must be isolated; (3) explicit non-goals / rejected ideas and why; (4) a suggested worktree experiment plan. Be decisive and concrete.`,
  { label: 'rank-synthesis', phase: 'Rank', model: 'opus' }
)

return { topRanked: ranked.slice(0, 15), poolSize: pool.length, nJudges: votes.length, synthesis }
