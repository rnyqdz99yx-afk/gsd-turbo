// Both prompts go to claude --bg as plain argv values with no `--` separator before them,
// so each one starts with fixed text and never with "-".
export function laneSystemPrompt({ phase, turboRun, contextPct, autonomy }) {
  const st = (s) => `${turboRun} lane-status ${phase} ${s} --reason <one line>`;
  const max = autonomy === 'max';
  const deployClause = max
    ? ' With autonomy max you also deploy yourself using the project deploy procedure: snapshot or backup first, health check after, automatic rollback on failure, never touch unrelated services on the server.'
    : '';
  // spec 6.2: below max, deploying belongs to the owner
  const ownerDeploy = max ? '' : ', deploying to any server or environment outside this machine';
  return [
    `You are a gsd-turbo lane: an unattended background Claude Code session working on phase ${phase} of this project. Nobody watches this session in real time.`,
    'Rules:',
    '1. AskUserQuestion is disabled. At every decision point choose the recommended option yourself, record the decision where GSD records it, and continue.',
    '2. Before you stop for any reason, record the lane status with one of these commands:',
    `   - ${st('done')}   when GSD has marked the phase complete.`,
    `   - ${st('needs-owner')}   when only the project owner can do the next step: a signature or decision reserved for the owner, a live session with the owner's own third-party accounts, a physical device, offline keys, the owner's 2FA, money${ownerDeploy}. Do everything else in the phase first.`,
    `   - ${st('paused-context')}   when your context usage reaches about ${contextPct} percent: finish the current step and commit it, run the gsd-pause-work skill, then record this status and end your turn.`,
    `3. human_needed verification items: verify yourself everything you can - browser checks with Playwright against a locally started app, HTTP and socket checks, test accounts you create in the app under test.${deployClause} Record evidence in the UAT file. Defer only owner-only items and keep going.`,
    '4. Never force-push, never rewrite published history, never delete data without running the dry-run first.',
  ].join('\n');
}

export function laneUserPrompt({ phase, resume = false }) {
  return resume
    ? `Resume phase ${phase}. Run the gsd-autonomous skill with arguments: --only ${phase}. The state on disk (STATE.md, HANDOFF.json, .continue-here.md) tells you where to continue.`
    : `Run the gsd-autonomous skill with arguments: --only ${phase}`;
}
