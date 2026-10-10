import fs from 'node:fs';
import path from 'node:path';

// Synthetic GSD 1.16 plans (gsd-core templates/phase-prompt.md, references/checkpoints.md), one per checkpoint kind.
const head = (plan, wave) => `---
phase: 32-auth
plan: ${plan}
type: execute
wave: ${wave}
depends_on: []
files_modified: []
autonomous: false
requirements: [AUTH-01]
---

<objective>
Plan ${plan} of the auth phase.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/references/checkpoints.md
</execution_context>

<context>
@.planning/PROJECT.md
</context>

`;

export const DECISION_PLAN = `${head('09', 2)}<tasks>

<task type="auto">
  <name>Task 1: Add the session table</name>
  <files>src/db/schema.ts</files>
  <action>Create the sessions table.</action>
  <verify>npm test</verify>
  <done>The table exists</done>
</task>

<task type="checkpoint:decision" gate="blocking" auto_select="clerk">
  <decision>Select the authentication provider</decision>
  <context>
    The app needs sign-in. Two options with different trade-offs.
  </context>
  <options>
    <option id="supabase">
      <name>Supabase Auth</name>
      <pros>Built into the database we use</pros>
      <cons>Less customizable UI</cons>
    </option>
    <option id="clerk">
      <name>Clerk</name>
      <pros>Pre-built UI &amp; good docs</pros>
      <cons>Paid after 10k users</cons>
    </option>
  </options>
  <resume-signal>Select: supabase or clerk</resume-signal>
</task>

<task type="auto">
  <name>Task 3: Wire the provider</name>
  <action>Use the chosen provider for sign-in.</action>
  <verify>npm test</verify>
</task>

</tasks>
`;

export const VERIFY_PLAN = `${head('10', 3)}<tasks>

<task type="auto">
  <name>Task 1: Build the dashboard layout</name>
  <files>src/app/dashboard/page.tsx</files>
  <action>Sidebar, header and content area.</action>
  <verify>npm run build</verify>
</task>

<task type="auto">
  <name>Task 2: Start the dev server</name>
  <action>Run npm run dev in the background and wait until it is ready.</action>
  <verify>fetch http://localhost:3000 returns 200</verify>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>Dashboard layout - dev server running at http://localhost:3000</what-built>
  <how-to-verify>
    Visit http://localhost:3000/dashboard and check:
    1. Sidebar left
    2. No horizontal scroll
  </how-to-verify>
  <resume-signal>Type "approved" or describe layout issues</resume-signal>
</task>

</tasks>
`;

export const ACTION_PLAN = `${head('11', 3)}<tasks>

<task type="auto">
  <name>Task 1: Create the mail service account</name>
  <action>Send the welcome mail</action>
  <verify>npm test</verify>
</task>

<task type="checkpoint:human-action" gate="blocking-human">
  <action>Complete the email verification for the mail service account</action>
  <instructions>
    I created the account and asked for the verification mail.
    Click the link in it.
  </instructions>
  <verification>The mail API key works: the test send succeeds</verification>
  <resume-signal>Type "done" when verified</resume-signal>
</task>

<task type="auto">
  <name>Task 3: Send the first mail</name>
  <action>Send a test mail through the API.</action>
</task>

</tasks>
`;

// .planning/phases/<dirName>/ with the given files (name -> text); returns the phase directory.
export function writePhase(root, dirName, files) {
  const dir = path.join(root, '.planning', 'phases', dirName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
