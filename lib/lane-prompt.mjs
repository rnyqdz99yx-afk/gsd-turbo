// Both prompts go to claude --bg as plain argv values with no `--` separator before them,
// so each one starts with fixed text and never with "-".
export function laneSystemPrompt({ phase, turboRun, contextPct, autonomy, mode = 'safe', tmpDir = '' }) {
  const st = (s) => `${turboRun} lane-status ${phase} ${s} --reason <one line>`;
  const max = autonomy === 'max';
  const deployClause = max
    ? ' With autonomy max you also deploy yourself using the project deploy procedure: snapshot or backup first, health check after, automatic rollback on failure, never touch unrelated services on the server.'
    : '';
  // spec 6.2: below max, deploying belongs to the owner
  const ownerDeploy = max ? '' : ', deploying to any server or environment outside this machine';
  const full = mode === 'full';
  const doneWhen = full
    ? 'only when the turbo-phase skill reaches its close step (GSD may mark the phase complete earlier; that is not the end)'
    : 'when GSD has marked the phase complete';
  // full mode: the turbo-phase skill owns every stop and the UAT file; it has no deploy step
  const stopLead = full
    ? "2. Stop only the way the turbo-phase skill says: needs-owner and failed only through its Stopping early section, which restores GSD's gates first. The lane statuses:"
    : '2. Before you stop for any reason, record the lane status with one of these commands:';
  const uatRule = full
    ? `3. human_needed verification items are handled only by the turbo-phase skill's uat step (the turbo-uat agent and ${turboRun} uat record): never check them yourself and never edit the UAT file.`
    : `3. human_needed verification items: verify yourself everything you can - browser checks with Playwright against a locally started app, HTTP and socket checks, test accounts you create in the app under test.${deployClause} Record evidence in the UAT file. Defer only owner-only items and keep going.`;
  return [
    `You are a gsd-turbo lane: an unattended background Claude Code session working on phase ${phase} of this project. Nobody watches this session in real time.`,
    'Rules:',
    '1. AskUserQuestion is disabled. At every decision point choose the recommended option yourself, record the decision where GSD records it, and continue.',
    stopLead,
    `   - ${st('done')}   ${doneWhen}.`,
    `   - ${st('needs-owner')}   when only the project owner can do the next step: a signature or decision reserved for the owner, a live session with the owner's own third-party accounts, a physical device, offline keys, the owner's 2FA, money${ownerDeploy}.${full ? '' : ' Do everything else in the phase first.'}`,
    `   - ${st('paused-context')}   when ${turboRun} context ${phase} reports ${contextPct} percent or more: finish the current step and commit it, run the gsd-pause-work skill, then record this status and end your turn. Run ${turboRun} context ${phase} before each step of the skill you run (and before each wave or plan you dispatch); context: unknown (...) means go on. Never estimate your context by hand and never use GSD's context_window for this decision.`,
    uatRule,
    '4. Never force-push, never rewrite published history, never delete data without running the dry-run first.',
    ...(tmpDir ? [`5. Temporary files, stands and copies of data go under ${String(tmpDir).replace(/\\/g, '/')} (TMP, TEMP and TMPDIR of this session point there), never /tmp or the system temp directory. ${turboRun} lane-status ${phase} done removes that directory.`] : []),
  ].join('\n');
}

// Full mode runs /turbo-phase; safe mode (doctor: untested GSD or missing stage-2 pieces) keeps
// gsd-autonomous, after putting back any GSD gates and docs commits an earlier turbo-phase run
// left off (spec §8).
export function laneUserPrompt({ phase, resume = false, mode = 'safe', turboRun = '' }) {
  if (mode === 'full') {
    return resume
      ? `Resume phase ${phase}. Run the turbo-phase skill with arguments: ${phase} --resume`
      : `Run the turbo-phase skill with arguments: ${phase}`;
  }
  const run = `${turboRun ? `First run ${turboRun} gates restore ${phase} and then ${turboRun} gates docs-restore ${phase} (no-ops unless an earlier turbo-phase run switched GSD gates or docs commits off). Then run` : 'Run'} the gsd-autonomous skill with arguments: --only ${phase}`;
  return resume
    ? `Resume phase ${phase}. ${run}. The state on disk (STATE.md, HANDOFF.json, .continue-here.md) tells you where to continue.`
    : run;
}
