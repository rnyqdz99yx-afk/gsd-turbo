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

// Checkpoints written the way a planner writes them for a Russian owner (synthetic): an owner block in Russian, the
// executor's own lines in English, and the executor's <action> naming the owner block's tag in inline code.

// human-verify: the action names `<what-built>` in backticks (a tag search that cuts there shows the action's tail).
export const OWNER_VERIFY_PLAN = `${head('12', 1)}<tasks>

<task type="checkpoint:human-verify" gate="blocking-human">
  <name>Task 1: Владелец — проверить пакет библиотеки картинок до установки</name>
  <action>
    Evidence only: install nothing, change no tracked file.
    (a) \`npm view imagekit-lite@3.2.1 --json\` into the evidence dir.
    (b) Present the \`<what-built>\` summary to the owner in Russian, plain words, verdict first, with the placeholders
    filled from the evidence. Install nothing before the answer.
  </action>
  <what-built>
    **Что получилось:** проверил пакет библиотеки картинок, ничего не устанавливая. Это официальный пакет: репозиторий
    example.org/imagekit/imagekit-lite, сопровождающих двое. Контрольная сумма архива совпадает с реестром: <да/нет>.
    **Что не сделано:** ничего не установлено, файлы проекта не менялись.
    **Что решаем:** ставить ли эту версию библиотеки.
  </what-built>
  <how-to-verify>
    1. Открой страницу пакета в реестре — там ссылка на официальный репозиторий.
    2. В сводке выше сверка контрольной суммы — «да».
  </how-to-verify>
  <verify>
    <automated>node -e "process.exit(0)"</automated>
  </verify>
  <resume-signal>Ответь \`ok\` — ставим; или \`stop\` — ничего не ставим.</resume-signal>
</task>

</tasks>
`;

// human-action: the action is the executor's preparation; the owner's words are in <instructions>, one executor line
// among them; the verification is English only.
export const OWNER_ACTION_PLAN = `${head('13', 2)}<tasks>

<task type="auto">
  <name>Task 1: Build the trial package</name>
  <action>Build it.</action>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 2: Владелец — создать тестового пользователя Windows и один раз войти в него</name>
  <action>
    Executor preparation, before presenting. No account or setting changes; files only.
    (a) \`Get-LocalUser\` must show no test user. If it exists, stop and report.
    (b) Write the helper script the owner runs.
    Then present \`<instructions>\` to the owner in Russian.
  </action>
  <instructions>
    **Что получилось:** пробная сборка готова и прошла все проверки сборки. Твои данные не трогались.
    **Что нужно от тебя (5 минут):**
    1. Открой PowerShell от имени администратора.
    2. Вставь и выполни: \`powershell -File C:\\Users\\dev\\smoke\\create-user.ps1\`.
    Executor: after the answer, check that the profile exists
      and that the user is no administrator.
    3. Войди в нового пользователя один раз и вернись.
  </instructions>
  <verification>After the owner's answer, Claude checks that the user exists and is enabled.</verification>
  <resume-signal>Ответь \`готово\` — пользователь создан.</resume-signal>
</task>

</tasks>
`;

// decision with options: the owner text is the decision and the context; the action is the executor's.
export const OWNER_DECISION_PLAN = `${head('14', 2)}<tasks>

<task type="auto">
  <name>Task 1: Measure the thumbnails</name>
  <action>Measure them.</action>
</task>

<task type="checkpoint:decision" gate="blocking-human">
  <name>Task 2: Владелец выбирает, где хранить превью картинок</name>
  <decision>Где хранить превью картинок?</decision>
  <context>
    Превью сейчас лежат рядом с оригиналами и занимают много места. Выбор нужен до следующего шага.
  </context>
  <options>
    <option id="a">
      <name>a — на локальном диске</name>
      <pros>Быстро и бесплатно</pros>
      <cons>Занимает место</cons>
    </option>
    <option id="b">
      <name>b — в облаке</name>
      <pros>Место на диске свободно</pros>
      <cons>Платно</cons>
    </option>
  </options>
  <action>Before presenting, run verify 1. Record the answer verbatim; never interpret it.</action>
  <resume-signal>Ответь \`a\` или \`b\`.</resume-signal>
</task>

</tasks>
`;

// decision whose owner text is in <context> after the executor's preparation and a line that introduces the owner text.
export const OWNER_CONTEXT_PLAN = `${head('15', 2)}<tasks>

<task type="auto">
  <name>Task 1: Run the compression probe</name>
  <action>Run it.</action>
</task>

<task type="checkpoint:decision" gate="blocking-human">
  <name>Task 2: Владелец решает про сжатие картинок</name>
  <decision>Включать ли сжатие картинок при загрузке?</decision>
  <context>
    Executor preparation, before presenting; no file changes:
    - Run verify 1 (\`PRE-RULING-OK\`).
    - Read the verdict from the probe report.
    - FAILED → in «Коротко», replace the first sentence with «Проба не прошла — поэтому рекомендую b.». Present b first,
      marked «рекомендую».
    The text for the owner (Russian, plain words, no ids):

    **Коротко:** сжатие картинок можно включить — проба на этом компьютере прошла. Нужно твоё решение, потому что это
    меняет правило «оригиналы не трогать».

    **Что получилось:**
    - Проба сжала сто картинок без видимой потери качества.

    **Что решить:**
    - a (рекомендую) — включить сжатие.
    - b — оставить как есть.
  </context>
  <options>
    <option id="a"><name>a — включить сжатие</name><pros>Меньше места</pros><cons>Новое правило</cons></option>
    <option id="b"><name>b — оставить как есть</name><pros>Ничего не меняется</pros><cons>Место кончается</cons></option>
  </options>
  <action>Present \`<context>\` exactly as prepared. Never choose for the owner.</action>
  <resume-signal>Ответь \`a\` или \`b\`.</resume-signal>
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
