import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function resolveBin(name = 'claude', { platform = process.platform, exec = execFileSync } = {}) {
  try {
    const out = String(exec(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (platform === 'win32') {
      const pick = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0];
      if (pick) return { cmd: pick, shell: /\.(cmd|bat)$/i.test(pick) };
    } else if (lines[0]) {
      return { cmd: lines[0], shell: false };
    }
  } catch {
    // not on PATH: fall through to the bare name
  }
  return { cmd: name, shell: false };
}

export function parseAgents(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map((a) => ({
    id: String(a.id || ''),
    name: a.name || '',
    kind: a.kind || '',
    state: a.state || a.status || '',
    status: a.status || '',
    cwd: a.cwd || '',
    startedAt: a.startedAt || 0,
  }));
}

export function laneSessionName(root, phase) {
  const slug = path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `turbo-${slug}-p${String(phase).replace(/\./g, '-')}`;
}

export function buildBgArgs({ name, prompt, systemPrompt, permissionMode, model }) {
  return [
    '--bg', '--name', name,
    '--permission-mode', permissionMode,
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', systemPrompt,
    ...(model ? ['--model', model] : []),
    prompt,
  ];
}

export function parseBgLaunch(stdout) {
  const m = /backgrounded\s*·\s*([0-9a-f]+)/i.exec(String(stdout));
  return m ? m[1] : null;
}

export function createClaude({ bin = resolveBin(), exec = execFileSync } = {}) {
  const run = (args, cwd) => String(exec(bin.cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: bin.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }));
  return {
    launchBg(opts, cwd) {
      const id = parseBgLaunch(run(buildBgArgs(opts), cwd));
      if (!id) throw new Error('claude --bg did not report a session id');
      return id;
    },
    list: () => parseAgents(run(['agents', '--json', '--all'])),
    stop: (id) => run(['stop', id]),
    rm: (id) => run(['rm', id]),
  };
}
