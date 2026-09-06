import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(HERE, 'config.json')
const STATE_PATH = path.join(HERE, 'state.json')
const REPORTS_DIR = path.join(HERE, 'reports')
const LOGS_DIR = path.join(HERE, 'logs')
const TASKS_DIR = path.join(HERE, 'tasks')
const PROMPTS_DIR = path.join(HERE, 'prompts')

const iso = () => new Date().toISOString()

async function readText(file) {
  return fs.readFile(file, 'utf8')
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function ensureRuntime() {
  await fs.mkdir(REPORTS_DIR, { recursive: true })
  await fs.mkdir(LOGS_DIR, { recursive: true })
  await fs.mkdir(TASKS_DIR, { recursive: true })

  const stateExample = path.join(HERE, 'state.example.json')
  if (!(await exists(STATE_PATH))) {
    await fs.copyFile(stateExample, STATE_PATH)
  }

  for (const name of ['claude-task', 'codex-task']) {
    const target = path.join(TASKS_DIR, `${name}.md`)
    const example = path.join(TASKS_DIR, `${name}.example.md`)
    if (!(await exists(target))) await fs.copyFile(example, target)
  }
}

async function loadConfig() {
  return JSON.parse(await readText(CONFIG_PATH))
}

async function loadState() {
  await ensureRuntime()
  return JSON.parse(await readText(STATE_PATH))
}

async function saveState(patch) {
  const current = await loadState()
  const next = { ...current, ...patch, updatedAt: iso() }
  await fs.writeFile(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function parseTaskMeta(text) {
  const phase = /^PIPELINE_PHASE:\s*(.+)$/mi.exec(text)?.[1]?.trim() || 'UNSPECIFIED'
  const risk = /^PIPELINE_RISK:\s*(LOCAL_ONLY|COMMIT_ALLOWED|DEPLOY_ALLOWED|PRODUCTION_WRITE_GATE)$/mi.exec(text)?.[1] || 'LOCAL_ONLY'
  return { phase, risk }
}

function parseVerdict(text) {
  const verdict = /PIPELINE_VERDICT:\s*(PASS|FAIL|HUMAN_GATE)/i.exec(text)?.[1]?.toUpperCase()
  const severity = /PIPELINE_SEVERITY:\s*(NONE|LOW|MEDIUM|HIGH|BLOCKER)/i.exec(text)?.[1]?.toUpperCase()
  const summary = /PIPELINE_SUMMARY:\s*(.+)/i.exec(text)?.[1]?.trim()
  return {
    verdict: verdict || 'FAIL',
    severity: severity || 'HIGH',
    summary: summary || 'Agent did not return the required pipeline contract.',
    contractFound: Boolean(verdict && severity && summary),
  }
}

function policyText(config, risk) {
  const p = config.riskPolicies[risk]
  if (!p) throw new Error(`Unknown risk policy: ${risk}`)
  return [
    `PIPELINE RISK POLICY: ${risk}`,
    `Claude may commit: ${p.claudeMayCommit ? 'YES' : 'NO'}`,
    `Claude may push: ${p.claudeMayPush ? 'YES' : 'NO'}`,
    `Claude may deploy: ${p.claudeMayDeploy ? 'YES' : 'NO'}`,
    `Production business-data writes: ${p.productionWrites ? 'YES' : 'NO'}`,
  ].join('\n')
}

async function commandExists(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', shell: false })
  return {
    ok: result.status === 0,
    detail: (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || `exit ${result.status}`,
  }
}

async function gitStatus(projectRoot) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', shell: false })
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function runAgent({ name, command, args, prompt, cwd, reportFile, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: false,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString()
      stdout += s
      process.stdout.write(s)
    })

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString()
      stderr += s
      process.stderr.write(s)
    })

    child.on('error', async (error) => {
      const synthetic = `# ${name} launch failure\n\n${error.stack || error.message}\n\nPIPELINE_VERDICT: FAIL\nPIPELINE_SEVERITY: BLOCKER\nPIPELINE_SUMMARY: ${name} could not be launched.\n`
      await fs.writeFile(reportFile, synthetic)
      await fs.writeFile(logFile, synthetic)
      resolve({ code: -1, stdout: synthetic, stderr: String(error) })
    })

    child.on('close', async (code) => {
      const report = stdout.trim() || `# ${name} returned no stdout\n\nPIPELINE_VERDICT: FAIL\nPIPELINE_SEVERITY: HIGH\nPIPELINE_SUMMARY: ${name} returned no report on stdout.\n`
      const log = [`# ${name} run`, `exit=${code}`, '', '## STDOUT', stdout, '', '## STDERR', stderr].join('\n')
      await fs.writeFile(reportFile, `${report.trim()}\n`)
      await fs.writeFile(logFile, `${log.trim()}\n`)
      resolve({ code, stdout: report, stderr })
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

async function buildClaudePrompt({ config, task, codexReport = '' }) {
  const wrapper = await readText(path.join(PROMPTS_DIR, 'claude-system.md'))
  const { risk } = parseTaskMeta(task)
  return [
    wrapper,
    '',
    policyText(config, risk),
    '',
    '# CURRENT CLAUDE TASK',
    task,
    codexReport ? '\n# CODEX FINDINGS TO REPRODUCE AND FIX\n' + codexReport : '',
  ].join('\n')
}

async function buildCodexPrompt({ task, claudeReport = '' }) {
  const wrapper = await readText(path.join(PROMPTS_DIR, 'codex-system.md'))
  return [
    wrapper,
    '',
    '# CURRENT CODEX QA TASK',
    task,
    claudeReport ? '\n# LATEST CLAUDE IMPLEMENTATION REPORT\n' + claudeReport : '',
  ].join('\n')
}

async function runClaude(config, projectRoot, iteration, task, codexReport = '') {
  const prompt = await buildClaudePrompt({ config, task, codexReport })
  const reportFile = path.join(REPORTS_DIR, 'claude-report.md')
  const logFile = path.join(LOGS_DIR, `claude-${String(iteration).padStart(2, '0')}.log`)
  const result = await runAgent({
    name: 'Claude',
    command: config.claude.command,
    args: config.claude.args,
    prompt,
    cwd: projectRoot,
    reportFile,
    logFile,
  })
  const parsed = parseVerdict(result.stdout)
  await saveState({ lastAgent: 'claude', lastVerdict: parsed.verdict, lastSeverity: parsed.severity, lastSummary: parsed.summary })
  return { ...result, ...parsed }
}

async function runCodex(config, projectRoot, iteration, task, claudeReport = '') {
  const prompt = await buildCodexPrompt({ task, claudeReport })
  const reportFile = path.join(REPORTS_DIR, 'codex-report.md')
  const logFile = path.join(LOGS_DIR, `codex-${String(iteration).padStart(2, '0')}.log`)
  const result = await runAgent({
    name: 'Codex',
    command: config.codex.command,
    args: config.codex.args,
    prompt,
    cwd: projectRoot,
    reportFile,
    logFile,
  })
  const parsed = parseVerdict(result.stdout)
  await saveState({ lastAgent: 'codex', lastVerdict: parsed.verdict, lastSeverity: parsed.severity, lastSummary: parsed.summary })
  return { ...result, ...parsed }
}

async function doctor() {
  const config = await loadConfig()
  const projectRoot = path.resolve(HERE, config.projectRoot)
  const checks = [
    ['node', process.execPath, ['--version']],
    ['git', 'git', ['--version']],
    ['claude', config.claude.command, ['--version']],
    ['codex', config.codex.command, ['--version']],
  ]

  console.log(`Project root: ${projectRoot}`)
  let failed = false
  for (const [label, command] of checks) {
    const result = await commandExists(command)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${label}: ${result.detail}`)
    if (!result.ok) failed = true
  }

  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, encoding: 'utf8', shell: false })
  const gitOk = git.status === 0
  console.log(`${gitOk ? 'PASS' : 'FAIL'} repository: ${(git.stdout || git.stderr).trim()}`)
  if (!gitOk) failed = true

  process.exitCode = failed ? 1 : 0
}

async function runPipeline({ qaFirst = false }) {
  await ensureRuntime()
  const config = await loadConfig()
  const projectRoot = path.resolve(HERE, config.projectRoot)
  const claudeTask = await readText(path.join(TASKS_DIR, 'claude-task.md'))
  const codexTask = await readText(path.join(TASKS_DIR, 'codex-task.md'))
  const meta = parseTaskMeta(qaFirst ? codexTask : claudeTask)

  if (config.requireCleanWorkingTreeBeforeStart) {
    const dirty = await gitStatus(projectRoot)
    if (dirty) {
      throw new Error(`Working tree is not clean before pipeline start:\n${dirty}\nCommit/stash unrelated work first. Runtime pipeline files should be gitignored.`)
    }
  }

  await saveState({
    status: 'running',
    phase: meta.phase,
    risk: meta.risk,
    iteration: 0,
    startedAt: iso(),
    lastAgent: null,
    lastVerdict: null,
    lastSeverity: null,
    lastSummary: null,
  })

  let latestClaudeReport = ''
  let latestCodexReport = ''

  if (qaFirst) {
    console.log('\n=== QA-FIRST: CODEX ===\n')
    const qa = await runCodex(config, projectRoot, 0, codexTask, '')
    latestCodexReport = qa.stdout
    if (qa.verdict === 'PASS') {
      await saveState({ status: 'passed', iteration: 0 })
      console.log('\nPIPELINE COMPLETE: Codex PASS\n')
      return
    }
    if (qa.verdict === 'HUMAN_GATE') {
      await saveState({ status: 'human_gate', iteration: 0 })
      console.log('\nPIPELINE PAUSED: human approval required.\n')
      return
    }
  }

  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    await saveState({ iteration })
    console.log(`\n=== ITERATION ${iteration}/${config.maxIterations}: CLAUDE ===\n`)

    const builder = await runClaude(config, projectRoot, iteration, claudeTask, latestCodexReport)
    latestClaudeReport = builder.stdout

    if (builder.verdict === 'HUMAN_GATE') {
      await saveState({ status: 'human_gate' })
      console.log('\nPIPELINE PAUSED: Claude reached a human gate.\n')
      return
    }
    if (builder.verdict !== 'PASS') {
      await saveState({ status: 'builder_failed' })
      console.log('\nPIPELINE STOPPED: Claude did not produce PASS.\n')
      return
    }

    console.log(`\n=== ITERATION ${iteration}/${config.maxIterations}: CODEX ===\n`)
    const qa = await runCodex(config, projectRoot, iteration, codexTask, latestClaudeReport)
    latestCodexReport = qa.stdout

    if (qa.verdict === 'PASS') {
      await saveState({ status: 'passed' })
      console.log('\nPIPELINE COMPLETE: Codex PASS\n')
      return
    }
    if (qa.verdict === 'HUMAN_GATE') {
      await saveState({ status: 'human_gate' })
      console.log('\nPIPELINE PAUSED: Codex reached a human gate.\n')
      return
    }

    console.log('\nCodex returned FAIL. Findings will be passed to Claude on the next iteration.\n')
  }

  await saveState({ status: 'iteration_limit' })
  console.log(`\nPIPELINE PAUSED: reached maxIterations=${config.maxIterations}. Human review required.\n`)
  process.exitCode = 2
}

async function status() {
  const state = await loadState()
  console.log(JSON.stringify(state, null, 2))
}

async function init() {
  await ensureRuntime()
  console.log('Runtime files initialized:')
  console.log(path.join(TASKS_DIR, 'claude-task.md'))
  console.log(path.join(TASKS_DIR, 'codex-task.md'))
  console.log(STATE_PATH)
}

const command = process.argv[2] || 'help'

try {
  if (command === 'doctor') await doctor()
  else if (command === 'init') await init()
  else if (command === 'run') await runPipeline({ qaFirst: false })
  else if (command === 'qa') await runPipeline({ qaFirst: true })
  else if (command === 'status') await status()
  else {
    console.log(`JMAC Agent Pipeline v1\n\nCommands:\n  init    create local runtime task/state files\n  doctor  verify node/git/claude/codex availability\n  run     Claude implementation first, then Codex QA\n  qa      Codex QA first; on FAIL loop into Claude fixes\n  status  print current pipeline state\n`)
  }
} catch (error) {
  console.error(error?.stack || String(error))
  try {
    await saveState({ status: 'error', lastSummary: error?.message || String(error) })
  } catch {}
  process.exitCode = 1
}
