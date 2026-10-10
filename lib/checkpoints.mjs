// Checkpoint tasks of a GSD plan (GSD 1.16: gsd-core references/checkpoints.md and templates/phase-prompt.md):
//   <task type="checkpoint:decision" gate="blocking|blocking-human" [auto_select="<option id>"]> with <decision>,
//     <context>, <options><option id="…"><name> <pros> <cons></option></options>, <resume-signal>;
//   <task type="checkpoint:human-verify" gate="…"> with <what-built>, <how-to-verify>, <resume-signal>;
//   <task type="checkpoint:human-action" gate="…"> with <action>, <instructions>, <verification>, <resume-signal>.
// Deterministic: the same plan text gives the same checkpoints. A task's number is its position among the <task>
// elements of <tasks>, the way GSD's executor counts them ("Task N", "Progress: n/total").
export const CHECKPOINT_KINDS = Object.freeze(['decision', 'human-verify', 'human-action']);

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", amp: '&' };
const decode = (s) => String(s).replace(/&(lt|gt|quot|apos|#39|amp);/g, (_, e) => ENTITIES[e]);
const squash = (s) => decode(s).replace(/\s+/g, ' ').trim();

// Fenced code (an example a plan quotes) is never a task: its lines read as empty. As in CommonMark, a fence is
// closed only by a run of its own character at least as long as the opener, without an info string: a line like
// ```js inside it is content. A plan's tag on the closing line (~~~</action>) is no info string, so it still closes.
function stripFences(text) {
  let fence = null;
  return String(text).split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (m && fence === null) {
      fence = m[1];
      return '';
    }
    const rest = m ? m[2].trim() : '';
    if (m && m[1][0] === fence[0] && m[1].length >= fence.length && (!rest || rest.startsWith('<'))) {
      fence = null;
      return '';
    }
    return fence === null ? line : '';
  }).join('\n');
}

// Attribute values in double or single quotes.
function attrs(text) {
  const out = {};
  for (const m of String(text).matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

const tagRe = (tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
const field = (body, tag) => {
  const m = tagRe(tag).exec(body);
  return m ? squash(m[1]) : '';
};

function decisionOptions(body) {
  const block = tagRe('options').exec(body)?.[1] || '';
  return [...block.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((m) => ({
    id: attrs(m[1]).id || '',
    name: field(m[2], 'name'),
    pros: field(m[2], 'pros'),
    cons: field(m[2], 'cons'),
  }));
}

export function parseCheckpoints(text) {
  const body = stripFences(text);
  const scope = tagRe('tasks').exec(body)?.[1] ?? body;
  const out = [];
  let n = 0;
  for (const m of scope.matchAll(/<task\b([^>]*)>([\s\S]*?)<\/task>/g)) {
    n += 1;
    const a = attrs(m[1]);
    const kind = /^checkpoint:([a-z-]+)$/.exec(a.type || '')?.[1];
    if (!CHECKPOINT_KINDS.includes(kind)) continue;
    const t = m[2];
    out.push({
      task: n,
      kind,
      gate: a.gate === 'blocking-human' ? 'blocking-human' : 'blocking',
      autoSelect: a.auto_select || null,
      decision: field(t, 'decision'),
      context: field(t, 'context'),
      options: kind === 'decision' ? decisionOptions(t) : [],
      resumeSignal: field(t, 'resume-signal'),
      whatBuilt: field(t, 'what-built'),
      howToVerify: field(t, 'how-to-verify'),
      action: field(t, 'action'),
      instructions: field(t, 'instructions'),
      verification: field(t, 'verification'),
    });
  }
  return out;
}

// The word a resume signal asks for ('Type "approved" or describe issues' -> approved), else the fallback.
export function quotedSignal(resumeSignal, fallback) {
  const m = /["“]([^"”]{1,40})["”]/.exec(String(resumeSignal ?? ''));
  return m ? m[1].trim() : fallback;
}
