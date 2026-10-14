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

// Fenced code (an example a plan quotes) is never a task. As in CommonMark, a fence is closed only by a run of its own
// character at least as long as the opener, without an info string: a line like ```js inside it is content; and a
// backtick run whose info string holds a backtick (```npm test``` at the start of a line) is inline code, no fence. A
// plan's tag on the closing line (~~~</action>) is no info string: it closes the fence and stays.
// [^\n], not .: a CRLF line keeps its \r here
const FENCE_LINE = /^(\s*)(`{3,}|~{3,})([^\n]*)$/;
function fenceOf(line) {
  const m = FENCE_LINE.exec(line);
  return m && !(m[2][0] === '`' && m[3].includes('`')) ? { indent: m[1], run: m[2], rest: m[3] } : null;
}

// Every line of the text with its offsets and its role: text, open (a fence opens), code (inside), close.
function fenceLines(text) {
  const out = [];
  let open = null;
  let at = 0;
  for (const line of text.split('\n')) {
    const f = fenceOf(line);
    let role = 'text';
    if (open === null && f) {
      open = f.run;
      role = 'open';
    } else if (open !== null) {
      const rest = f ? f.rest.trim() : '';
      if (f && f.run[0] === open[0] && f.run.length >= open.length && (!rest || rest.startsWith('<'))) {
        open = null;
        role = 'close';
      } else {
        role = 'code';
      }
    }
    out.push({ start: at, end: at + line.length, line, role, fence: f });
    at += line.length + 1;
  }
  return out;
}

// An inline code span on one line (CommonMark: closed by a backtick run of the opener's length). A span that would
// hold a closing tag is none: an unpaired backtick before a field's end tag never hides the plan's tags.
const INLINE_CODE = /(?<!`)(`+)(?!`)(.*?[^`])\1(?!`)/g;
const blankCode = (m, run, body) => (/<\/[a-z][\w-]*>/i.test(body) ? m : ' '.repeat(m.length));

// The text with every fence line and fenced line turned into spaces of the same length (a closing line keeps the tag
// after its run), and every inline code span too: tasks and fields are found here, so an example inside a fence is
// none, and a tag a plan names in inline code (an action's "present the `<what-built>` summary") is no element: a
// field is never cut from there. Their offsets hold in the original text, where a field's content is read.
const blanked = (lines) => lines.map((l) => {
  if (l.role === 'text') return l.line.replace(INLINE_CODE, blankCode);
  if (l.role === 'close') return ' '.repeat(l.fence.indent.length + l.fence.run.length) + l.fence.rest;
  return ' '.repeat(l.line.length);
}).join('\n');

// The original text between two offsets (outside any fence), a fenced block read as inline code: its lines joined
// with "; " in backticks, so a command the owner runs or checks stays in the question (spec §5.1). The inline code
// keeps the fence's indent: the owner card reads a field's lines by their indent.
function textAt(src, lines, from, to) {
  const out = [];
  let code = null;
  let indent = '';
  const inline = () => `${indent}\`${code.filter(Boolean).join('; ')}\``;
  for (const l of lines) {
    if (l.end < from || l.start >= to) continue;
    if (l.role === 'text') out.push(src.slice(Math.max(l.start, from), Math.min(l.end, to)));
    else if (l.role === 'open') {
      code = [];
      indent = l.fence.indent;
    }
    else if (l.role === 'code') code?.push(l.line.trim());
    else {
      const rest = l.start + l.fence.indent.length + l.fence.run.length;
      out.push(`${code ? inline() : ''}${src.slice(rest, Math.min(l.end, to))}`);
      code = null;
    }
  }
  if (code) out.push(inline());
  return out.join('\n');
}

// Attribute values in double or single quotes.
function attrs(text) {
  const out = {};
  for (const m of String(text).matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

// d: the offsets of the content, found in the blanked text and read in the original one
const tagRe = (tag, flags = 'd') => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, flags);

// The parsed text: the original, its lines and its blanked copy. Ranges are [from, to) offsets into both.
function scanner(text) {
  const src = String(text);
  const lines = fenceLines(src);
  const blank = blanked(lines);
  // the first <tag> within a range: the [from, to) of its content, or null
  const find = ([from, to], tag) => {
    const m = tagRe(tag).exec(blank.slice(from, to));
    return m ? [from + m.indices[1][0], from + m.indices[1][1]] : null;
  };
  // a field's text with its lines (no \r), entities kept: the owner card reads its lines (questions.mjs)
  const raw = (range, tag) => {
    const r = range && find(range, tag);
    return r ? textAt(src, lines, r[0], r[1]).replace(/\r(?=\n|$)/g, '') : '';
  };
  const field = (range, tag) => squash(raw(range, tag));
  return { blank, find, field, raw };
}

function decisionOptions(s, task) {
  const block = s.find(task, 'options');
  if (!block) return [];
  return [...s.blank.slice(block[0], block[1]).matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gd)].map((m) => {
    const range = [block[0] + m.indices[2][0], block[0] + m.indices[2][1]];
    return { id: attrs(m[1]).id || '', name: s.field(range, 'name'), pros: s.field(range, 'pros'), cons: s.field(range, 'cons') };
  });
}

// The fields whose lines the owner card reads ([key, tag]): the same text as the squashed field, line by line.
const RAW_FIELDS = [['name', 'name'], ['decision', 'decision'], ['context', 'context'], ['whatBuilt', 'what-built'],
  ['howToVerify', 'how-to-verify'], ['action', 'action'], ['instructions', 'instructions'], ['verification', 'verification']];

export function parseCheckpoints(text) {
  const s = scanner(text);
  const scope = s.find([0, s.blank.length], 'tasks') ?? [0, s.blank.length];
  const out = [];
  let n = 0;
  for (const m of s.blank.slice(scope[0], scope[1]).matchAll(/<task\b([^>]*)>([\s\S]*?)<\/task>/gd)) {
    n += 1;
    const a = attrs(m[1]);
    const kind = /^checkpoint:([a-z-]+)$/.exec(a.type || '')?.[1];
    if (!CHECKPOINT_KINDS.includes(kind)) continue;
    const t = [scope[0] + m.indices[2][0], scope[0] + m.indices[2][1]];
    // the task's own <name>: before its <options> block or after it, never an option's
    const opts = s.find(t, 'options');
    const before = opts ? [t[0], opts[0]] : t;
    const nameRange = s.find(before, 'name') ? before : opts ? [opts[1], t[1]] : null;
    const raw = Object.fromEntries(RAW_FIELDS.map(([key, tag]) => [key, s.raw(key === 'name' ? nameRange : t, tag)]));
    out.push({
      task: n,
      kind,
      gate: a.gate === 'blocking-human' ? 'blocking-human' : 'blocking',
      autoSelect: a.auto_select || null,
      decision: s.field(t, 'decision'),
      context: s.field(t, 'context'),
      options: kind === 'decision' ? decisionOptions(s, t) : [],
      resumeSignal: s.field(t, 'resume-signal'),
      whatBuilt: s.field(t, 'what-built'),
      howToVerify: s.field(t, 'how-to-verify'),
      action: s.field(t, 'action'),
      instructions: s.field(t, 'instructions'),
      verification: s.field(t, 'verification'),
      name: squash(raw.name),
      raw,
    });
  }
  return out;
}

// A live sitting (journal 2026-10-14): a human-action the phase's orchestrator conducts together with the owner in an
// attended session (a live check that needs the owner's replies while it runs), never a step the owner does alone and
// reports done. The plan writes <instructions> for it, and either a resume signal whose answer words are go and stop
// (each quoted, or the whole signal: "go / stop"), or a name, action, instructions or resume signal that names the
// sitting ("the live sitting", «живой сеанс») or the orchestrator with a co-performer in the same sentence ("the
// orchestrator and the operator run it together", «оркестратор вместе с владельцем»). A bare "orchestrator" (an
// executor's note), "sitting" (sitting at the PC) or a go and a stop anywhere in the signal is no sitting. A false alarm
// only sends the owner to /turbo-autonomous attend; a sitting answered done would let the executor go on as if it
// happened.
const GO_WORDS = 'go|старт';
const STOP_WORDS = 'stop|abort|cancel|стоп|отмена';
const quotedWord = (body) => new RegExp(`["'\`«“‘]\\s*(?:${body})\\s*["'\`»”’]`, 'iu');
const QUOTED_GO = quotedWord(GO_WORDS);
const QUOTED_STOP = quotedWord(STOP_WORDS);
const PAIR = new RegExp(`^[^\\p{L}]*(?:(?:${GO_WORDS})[^\\p{L}]*(?:(?:or|или)[^\\p{L}]*)?(?:${STOP_WORDS})|(?:${STOP_WORDS})[^\\p{L}]*(?:(?:or|или)[^\\p{L}]*)?(?:${GO_WORDS}))[^\\p{L}]*$`, 'iu');
const SITTING = /(?<!\p{L})(?:live|joint|attended|the|a|this|that) sittings?(?!\p{L})|(?<!\p{L})(?:жив|совместн)\p{L}* сеанс|(?<!\p{L})сеанс\p{L}* (?:с владельцем|вместе)/iu;
const ORCHESTRATOR = /(?<!\p{L})(?:orchestrator|оркестратор\p{L}*)(?!\p{L})/iu;
const CO_PERFORMER = /(?<!\p{L})(?:together|jointly|(?:with|and) the (?:owner|operator|user)|вместе|совместно|с владельцем|с оператором|и владел\p{L}*|и оператор\p{L}*)(?!\p{L})/iu;
const conducted = (text) => SITTING.test(text) || text.split(/[.!?;\n]+/).some((s) => ORCHESTRATOR.test(s) && CO_PERFORMER.test(s));
export function sittingCheckpoint(cp) {
  if (cp?.kind !== 'human-action' || !String(cp.instructions ?? '').trim()) return false;
  const signal = String(cp.resumeSignal ?? '').trim();
  if ((QUOTED_GO.test(signal) && QUOTED_STOP.test(signal)) || PAIR.test(signal)) return true;
  return [cp.name, cp.action, cp.instructions, cp.resumeSignal].some((t) => conducted(String(t ?? '')));
}

// The word a resume signal asks for ('Type "approved" or describe issues' -> approved), else the fallback.
export function quotedSignal(resumeSignal, fallback) {
  const m = /["“]([^"”]{1,40})["”]/.exec(String(resumeSignal ?? ''));
  return m ? m[1].trim() : fallback;
}
