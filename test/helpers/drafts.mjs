// Synthetic GSD 1.16 chunked planning files for the plan drafts tests (gsd-core references/planner-chunked.md, the
// planner's frontmatter of agents/gsd-planner.md).

// An outline: rows [id, wave, depends (a cell, default none)], closed with GSD's marker unless open.
export function outline(rows, { open = false } = {}) {
  return [
    '# Phase 33 plan outline', '',
    '| Plan ID | Objective | Wave | Depends On | Requirements |',
    '|---------|-----------|------|------------|--------------|',
    ...rows.map(([id, wave, deps = 'none']) => `| ${id} | objective of ${id} | ${wave} | ${deps} | R-${id.slice(3)} |`),
    '', ...(open ? [] : ['## OUTLINE COMPLETE', '']),
  ].join('\n');
}

// 5 plans in 4 waves: 33-01 → 33-02, 33-03 → 33-04 → 33-05.
export const FOUR_WAVES = outline([['33-01', 1], ['33-02', 2, '33-01'], ['33-03', 2, '33-01'], ['33-04', 3, '33-02'], ['33-05', 4, '33-04']]);

// A plan file as GSD's planner writes it.
export function planText(id, wave, deps = [], files = [], body = '') {
  return [
    '---', 'phase: 33-demo', `plan: ${id.slice(3)}`, 'type: execute', `wave: ${wave}`, `depends_on: [${deps.join(', ')}]`,
    `files_modified: [${files.join(', ')}]`, 'autonomous: true', '---', '', `<objective>${id}</objective>`, '', body,
  ].join('\n');
}

// A draft: a plan with the section turbo's paragraph asks for, then an optional tail.
export function draftText(id, wave, deps = [], files = [], { tail = '' } = {}) {
  return `${planText(id, wave, deps, files, '<tasks>\n<task type="auto"><name>Task 1</name></task>\n</tasks>\n')}\n## Draft assumptions\n\n${deps.map((d) => `- ${d}: creates src/${d}.ts with export make${d.slice(3)}()`).join('\n') || '- none'}\n${tail}`;
}
