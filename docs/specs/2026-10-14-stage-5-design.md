# gsd-turbo — Stage 5: перевод идущего майлстоуна на turbo и быстрое планирование длинных цепочек

Дата: 2026-10-14. Основа: основная спека §4.8 (`/turbo-adopt`), спека Stage 4 (слоты, полосы, prep, разметка),
журнал боевых прогонов v0.3.3 (обзор фаз 24–31, запись 06:10Z «planning is the bottleneck») и чтение исходников
GSD 1.16.0 (`@opengsd/gsd-core@1.16.0` из npm, §3). Релиз: **v0.5.0**, после v0.4.0, одним релизом.

## 1. Цель и критерии

Два подпроекта.

**A. `/turbo-adopt`** переводит на turbo майлстоун, который уже идёт на обычном GSD: показывает, где проект сейчас и
что turbo пропустит, задаёт все свои вопросы сразу, показывает список изменений, после одного подтверждения делает
один коммит и заканчивает отчётом с командой запуска. Сам прогон не запускает.

**B. Черновики планов** сокращают планирование фазы с длинной цепочкой планов: планы поздних волн пишутся
черновиками параллельно с первой волной, затем каждый черновик сверяется с уже написанными предшественниками
коротким проходом. Цель на фазе из журнала (10 планов, 8 волн): критический путь планирования с ~3,5–4 ч до
~1–1,5 ч.

Готово, когда:
1. `/turbo-adopt` в проекте с идущим майлстоуном GSD: по каждой фазе — её состояние простыми словами; закрытые
   фазы с устаревшей проверкой названы явно; все вопросы — одним вызовом `AskUserQuestion` (≤ 4 вопроса); затем
   список изменений и **одно** подтверждение; затем ровно один коммит `chore(turbo): adopt`; отчёт с полосами и
   критическим путём до/после, прогнозом ускорения, тем, что остаётся владельцу, и командой `/turbo-autonomous`.
   Супервизор и полосы adopt не запускает никогда.
2. Повторный `/turbo-adopt` ничего не ломает: без изменений — без коммита и без вопросов, на которые уже есть ответ;
   обрыв между записью файлов и коммитом доводится до коммита. `git revert` коммита adopt возвращает файлы проекта.
3. «Перепроверить»: по каждой такой фазе один проход проверяющего агента GSD; `passed` — свежий отчёт входит в коммит
   adopt; иначе старый отчёт остаётся, новый сохраняется отдельно, фаза остаётся закрытой.
4. Вне adopt пропуск закрытых фаз больше не тихий: `start` и `status` пишут строку о них, пока владелец не решил в adopt.
5. В фазе, где outline даёт ≥ `plan_drafts.min_waves` волн, полоса пишет черновики поздних волн параллельно с первой,
   сверяет каждый с записанными предшественниками и делает планом только сверенный черновик; черновик, не прошедший
   сверку, заменяется обычным планом GSD. Цикл проверки планов GSD (plan-checker, до трёх ревизий) идёт как раньше.
6. `turbo-run phase-step N --done plan` отказывает, если план попал в каталог фазы из черновика без пройденной сверки.
7. Без пригодного outline (нет волн/зависимостей, мало волн), в планировании доработок (`--gaps`) и при
   `plan_drafts.enabled: false` — обычное chunked-планирование, байт в байт как в v0.4.
8. Вопросы владельца появляются после коммита каждого плана, как в v0.4 (и после коммита сверенного черновика).
9. Замер: строка «время планирования фазы» в `supervisor.log` для каждой фазы, с черновиками и без, — владелец
   сравнивает.

## 2. Решения

Владелец (мозговой штурм 2026-10-14, все ответы = рекомендованные):
1. **Закрытые фазы с устаревшей проверкой** adopt перечисляет в отчёте и задаёт **одну** карточку: по умолчанию
   «оставить закрытыми», вариант «перепроверить» (дешёвый проход проверяющего агента по каждой фазе).
2. **Изменения:** adopt сначала задаёт все вопросы сразу и показывает список изменений; **одно** подтверждение; затем
   **один** коммит `chore(turbo): adopt` (откат — `git revert`). Повторный запуск идемпотентен.
3. **Планирование:** черновики + сверка (идея из журнала). Риск принят: часть черновиков переделывается.
4. **adopt заканчивается отчётом** (полосы и критический путь до/после, прогноз ускорения, что осталось владельцу)
   и командой `/turbo-autonomous`; прогон он **не** запускает.

Решения Claude по доказательствам (§3):
- **D1. Разметка в adopt.** adopt сам вызывает `turbo-lane-analyst` в сессии владельца (только чтение, пишет один
  JSON), чтобы (а) прогноз «после» шёл по настоящим `Areas`/`Gates`, (б) вопрос об ослаблении зависимостей попал в
  общий список вопросов, а не пришёл карточкой позже. Чтобы ранняя разметка не закрепила «`**` для всех» у фаз без
  CONTEXT (prep ещё не прошёл), запись фазы в `lanes.json` получает поле `context`, и фаза с `confidence: low`,
  размеченная без CONTEXT.md, становится устаревшей, как только CONTEXT.md появился (§4.6): annotate после prep
  размечает её заново. Это улучшение работает и без adopt.
- **D2. Что adopt не делает.** Не создаёт слоты и не пишет доверие (это делает первый `start`), не ставит prep (его
  ставит `start`, §6.1 спеки Stage 4), не удаляет рабочие копии агентов и не трогает гейты фаз, не пишет
  `turbo-base.json` для старых артефактов: проверка свежести уже берёт базу из коммита артефакта, когда записи нет
  (T5). Всё это — строки отчёта «что остаётся», с командой, где она есть.
- **D3. Черновик пишет и сверяет полоса**, внутри своего шага `plan`, по ходу chunked-планирования GSD
  (`skills/turbo-phase/SKILL.md`): черновики — тот же одноплановый промпт GSD для этого плана плюс абзац turbo
  (путь черновика вместо файла плана, раздел допущений); сверка — `gsd-planner` в режиме ревизии по контракту
  `planner-revision.md`, как уже делает шаг `freshness`. Сверенный черновик кладёт в каталог фазы детерминированная
  команда turbo (`plan-drafts --promote`) с проверками, коммит — сообщением GSD. Для GSD план выглядит так, будто его
  написал его собственный одноплановый вызов: возобновление chunked-планирования пропускает его (G6), проверка
  планов идёт по всему набору (G8).
- **D4. Черновики по умолчанию включены** (`plan_drafts.enabled: true`). Почему: владелец выбрал этот способ и принял
  риск переделок (решение 3); каждый план всё равно проходит сверку и затем неизменённую проверку GSD; при любом
  сомнении — обычный путь GSD; ключ выключает всё одной строкой; замер (§5.8) показывает разницу. Условие релиза:
  живая проверка §12 п.5 прошла; иначе v0.5.0 выходит с `false` по умолчанию.
- **D5. Порог `min_waves: 3`.** При двух волнах выигрыш — одна разница «план − сверка» (~15 мин) против лишних
  токенов на черновик и сверку; цепочки из ≥ 3 волн — тот случай, где планирование стоит часами.
- **D6. Только шаг `plan`.** Планирование доработок (`gsd-plan-phase --gaps`, verify-work), `--reviews`, ревизии
  шага `freshness` черновиков не используют.

## 3. Что установлено (2026-10-14)

Исходники GSD: `npm pack @opengsd/gsd-core@1.16.0` (последняя опубликованная 1.16.x, `latest`), пути от корня пакета.

| # | Факт | Доказательство | Следствие |
|---|---|---|---|
| J1 | Супервизор пропустил закрытые фазы 24–31 (ROADMAP `[x]`, проверка `stale` после поздних изменений кода) одной строкой лога; владелец этого не увидел | журнал, Fourth combat run 03:59Z; `lib/supervisor.mjs` `logSkipped` (215–228) | adopt называет их и спрашивает (A), `start`/`status` показывают (§4.10) |
| J2 | Фаза 33: 10 планов в 8 волнах (почти линейная цепочка), ~20–25 мин на план (35–64 КБ) → ~3,5–4 ч планирования на критическом пути | журнал 06:10Z | B |
| J3 | Вопросы владельца из планов фазы 33 стали карточками только после шага `plan`; с v0.4 — после коммита каждого плана | журнал 06:10Z; `skills/turbo-phase/SKILL.md:169`; отчёт prerelease, Item 4 | B сохраняет «вопросы после коммита каждого плана» |
| J4 | Владелец хочет все вопросы сразу, а не по ходу | журнал, RESUME POINT 07:40Z п.5 | A §4.3 |
| G1 | chunked: outline-агент пишет `<padded>-PLAN-OUTLINE.md` — таблица `Plan ID \| Objective \| Wave \| Depends On \| Requirements`, последней строкой `## OUTLINE COMPLETE`; при возобновлении готовый outline переиспользуется | `gsd-core/workflows/plan-phase/steps/chunked-planning-mode.md:33-75`; `gsd-core/references/planner-chunked.md:9-24` | outline — вход для черновиков |
| G2 | Планы раздаются **волна за волной** по возрастанию Wave (пустая Wave = 1); внутри волны — по одному или пачкой (`planning.chunked_parallel` и `dispatch-capacity` > 1) | `chunked-planning-mode.md:12-30,85-92,202-204`; `planner-chunked.md:26-30` | поздние волны ждут ранние — узкое место J2 |
| G3 | Одноплановый вызов: `Agent(gsd-planner)` с `planning_context` шага 8 и блоком «Chunked mode: single-plan» (файл `{PHASE_DIR}/{plan_id}-PLAN.md`, строка outline, требования); возврат `## PLAN COMPLETE` | `chunked-planning-mode.md:142-163`; `planner-chunked.md:32-47` | черновик = этот промпт + абзац turbo |
| G4 | `planning_context` шага 8 не перечисляет соседние планы, но сам `gsd-planner` читает существующие PLAN.md каталога фазы | `gsd-core/workflows/plan-phase.md:745-758`; `agents/gsd-planner.md:637` | поздний план опирается на написанные ранние: поэтому черновику нужна сверка |
| G5 | Коммит каждого плана по отдельности, в порядке строк outline: `docs(${PADDED_PHASE}): plan ${plan_id} (chunked)` | `chunked-planning-mode.md:189-195` | turbo коммитит сверенный черновик тем же сообщением |
| G6 | Возобновление пропускает план, если `{plan_id}-PLAN.md` есть и начинается с `---` (кроме `--reviews`) | `chunked-planning-mode.md:119-131` | черновик **никогда** не пишется в каталог фазы до сверки: иначе GSD принял бы его за готовый план |
| G7 | Правило волн планировщика: волна = 1 + max(волн зависимостей); пересечение `files_modified` двигает план в следующую волну; у планов одной волны пересечений быть не должно | `agents/gsd-planner.md:745-761` | `--promote` проверяет это детерминированно |
| G8 | После всех волн: `## PLANNING COMPLETE` → шаг 10 `gsd-plan-checker` по `*-PLAN.md` → шаг 12 цикл ревизий (до 3) → 13 (покрытие требований и решений, `state.planned-phase`, разметка волн в ROADMAP, коммит) | `plan-phase.md:972,997-1060,1122-1180,1287-1434` | проверка GSD не обходится: черновики заканчиваются до шага 9 |
| G9 | Контракт ревизии: `required_property` + evidence + severity обязательны; конфликт с решениями — `## REVISION_CONFLICT`; «не перепланировать с нуля» | `plan-phase.md:1160-1180`; `gsd-core/references/planner-revision.md` | сверка — ревизия с измерением `draft-reconcile` |
| G10 | Для Claude GSD объявляет `maxConcurrency: 20`, `backgroundDispatch: false` | `gsd-core/bin/lib/capability-registry.cjs:580-595` | ≤ 8 черновиков разом укладываются |
| G16 | Собственный ход `gsd-planner` кончается шагами `update_roadmap` (правка ROADMAP.md) и `git_commit` (`docs($PHASE): create phase plan`, все PLAN-файлы фазы + ROADMAP) | `agents/gsd-planner.md:862-905` | эти шаги идут без условий и у собственных одноплановых планировщиков GSD в каждом chunked-прогоне (проверено ревью): правки ROADMAP.md и коммиты `create phase plan` ничего не говорят об агенте черновика. Абзац черновика всё равно велит их пропустить; turbo следит только за PLAN-файлами каталога фазы (§5.4); коммит `create phase plan` считается шагом 13d после проверки (`planCheckState`), только если меняет STATE.md и не добавляет PLAN-файл; коммит планировщика добавляет свой план или (в параллельном chunked-прогоне) несёт один ROADMAP.md |
| G17 | `planner-revision.md`: шаг 1 читает все планы фазы, шаг 6 коммитит их все (`fix($PHASE): revise plans based on checker feedback`) | `gsd-core/references/planner-revision.md` | промпт сверки: только шаги 2–5 (с 2.5), не 1, 6 и 7; читать только перечисленные файлы; без git; вернуть только маркеры сверки |
| G11 | `init manager`: `roadmap_complete` — только метаданные (чекбокс); `phase_complete` идёт от проверки (`isPhaseComplete`), `implementation_complete` = все планы с SUMMARY; фаза `executed` с непройденной проверкой → рекомендация `verify` | `gsd-core/bin/lib/init.cjs:196-233,2660-2690,2812-2828` | классификация фаз adopt (§4.2); turbo уже считает `[x]` + все SUMMARY «закрытой» (T1) |
| G12 | Проверка `stale`: отпечаток `covered_digest` по текущим байтам покрытых файлов не совпал | `gsd-core/bin/lib/verification.cjs:1380-1453` | закрытая фаза устаревает от любой поздней правки её файлов — норма, а не дефект |
| G13 | Шаг `verifier_dispatch`: один вызов `gsd-verifier` пишет VERIFICATION.md и сам пересчитывает отпечаток | `gsd-core/workflows/execute-phase/steps/verify-phase-goal.md:124-160` | «перепроверить» = только этот вызов (как маршрут `verifier-only` в «Stale report») |
| G14 | `/gsd-autonomous` берёт фазы с `phase_complete !== true`, то есть и закрытые с устаревшей проверкой | `gsd-core/workflows/autonomous.md:163` | почему обычный GSD перезапускал бы 24–31, а turbo их тихо пропускает |
| G15 | `plan-phase` жёстко отказывается перепланировать фазу со статусом `Complete` без `--force` | `gsd-core/workflows/plan-phase/steps/closed-phase-gate.md` | «перепроверить» ничего не перепланирует |
| T1 | turbo: `closed = roadmap_complete && implementation_complete`; закрытая фаза не запускается и удовлетворяет зависимости | `lib/gsd.mjs:90`; `lib/scheduler.mjs` `isFinished` | adopt берёт ту же классификацию |
| T2 | Разметка: `annotate brief` → агент → `annotate apply` (проверка, ROADMAP, `lanes.json`, ADR, **свой коммит**; при `autonomy: standard` — карточка владельцу) | `lib/annotate.mjs:257-310`; `lib/cli-jobs.mjs:83-142` | adopt вызывает apply с решением владельца и без своего коммита |
| T3 | annotate ставится только когда prep нечего делать | `lib/prep.mjs:84-101` | ранняя разметка adopt + D1 |
| T4 | Планировщик полос: `pickPhases` (зависимости, `Areas`, `Gates`, слоты, критический путь), `criticalPath` | `lib/scheduler.mjs:122,145` | прогноз adopt симулирует ровно его |
| T5 | Свежесть артефакта без записи в `turbo-base.json` берёт базу из его последнего коммита | `lib/staleness.mjs:199-216` | «base_sha по коммиту» (§4.8 п.5 основной спеки) уже есть — adopt ничего не пишет |
| T6 | Шаг `plan`: `planSetCheck` не даёт отметить шаг по неполному набору chunked-планов | `lib/cli-phase.mjs:182-195` | сюда же — проверка черновиков (§5.5) |
| T7 | `init` (конфиг turbo, `workflow.test_command`, `context_window`) написан внутри `bin/turbo-run.mjs`; `gates chunked` — `ensureChunkedParallel` | `bin/turbo-run.mjs` `case 'init'`; `lib/gates.mjs:251` | adopt вызывает тот же код, вынесенный в модуль |

Не проверено здесь (только на ПК владельца, §12): реальная предельная параллельность фоновых агентов Claude Code в
полосе; что `gsd-planner` в одноплановом режиме послушно пишет в путь черновика; длительность сверки (оценка
5–8 мин); время «перепроверки» закрытой фазы.

## 4. A. `/turbo-adopt`

### 4.1 Что видит владелец

```
/turbo-adopt
 1. проверка: doctor full, супервизор не идёт, полос нет, дерево чистое
 2. обзор: фазы и их состояние, закрытые с устаревшей проверкой, что откроется владельцу
 3. разметка (если нужна): turbo-lane-analyst в этой сессии, ~5 мин
 4. ВСЕ вопросы одним вызовом (0–2 вопроса)
 5. список изменений + прогноз → ОДНО подтверждение
 6. «перепроверить» (если выбрано): проверяющие агенты параллельно
 7. применение → ОДИН коммит chore(turbo): adopt
 8. отчёт + «/turbo-autonomous»
```

Отказ на шаге 1 ничего не меняет и говорит, что сделать. Отмена на шаге 5 ничего не меняет (кроме файлов `run/`).

### 4.2 Обзор (`turbo-run adopt scan`)

Детерминированно, без LLM. Источник — `gsd-tools init manager` (G11) и файлы фаз. Каждая фаза майлстоуна получает
состояние (первое совпадение):

| Состояние | Условие | Что с ней будет |
|---|---|---|
| `done` | `phase_complete` или `disk_status: complete` | ничего |
| `closed-stale` | `closed` (T1) и не `done`: ROADMAP `[x]`, все SUMMARY, проверка `stale`/`missing`/`gaps_found`/`human_needed` | turbo не запускает (T1); вопрос §4.3 |
| `verifying` | все SUMMARY, не `[x]`, проверка не `passed` | полоса начнёт с проверки и UAT (turbo-uat), §4.8 п.6 основной спеки |
| `executing` | есть SUMMARY не у всех планов | полоса продолжит со следующего плана без SUMMARY |
| `planned` | планы есть, SUMMARY нет (или outline chunked не дописан — `planSetCheck`) | полоса начнёт с `freshness` |
| `prepped` | CONTEXT.md есть, планов нет | prep не нужен |
| `fresh` | нет CONTEXT.md | первый `start` поставит prep (слоты) |

Плюс: активная фаза GSD (`is_active`), открытые вопросы turbo (`questions --open`), `human_needed` и незакрытые
строки UAT незакрытых фаз, оставленные гейты (`gatesLeftovers`), рабочие копии агентов (`agentWorktrees`), слоты
(созданы ли, доверены ли), `lanes.mode`, наличие и свежесть `lanes.json`, конфиг turbo, ключи GSD
(`workflow.test_command`, `planning.chunked_parallel`, `context_window`,
`git.branching_strategy`), прошлый `adopt.json`.

**Отказы** (exit 1, одна строка `refused: …` на причину, ничего не меняется): нет `.planning`/ROADMAP; doctor
`unsupported`; супервизор жив; есть запись живой полосы (`supervisor.json.lanes` с живой сессией) или
`attended`; незавершённое слияние git; грязное дерево, кроме путей незакоммиченного прошлого adopt (§4.9). Дерево
грязное — как в `/turbo-autonomous` п.4: показать список и спросить владельца, что с ним делать; adopt сам не
коммитит чужого. Нет незавершённых фаз → `nothing to adopt: every phase is done` (exit 0), отчёт без изменений.

### 4.3 Вопросы — все сразу

`turbo-run adopt plan --json` возвращает список вопросов в форме `questions --open --json` (`id`, `header`,
`question`, `context`, `options[{label, description, recommended}]`), язык — `lang` конфига (без конфига — язык
владельца, переданный скиллом `--lang`). Вопрос задаётся, только если на него нет ответа в `adopt.json` для того же
набора (повтор, §4.9).

1. **`stale-closed`** (есть фазы `closed-stale`). ru: «Фазы 24–31 отмечены сделанными, но их проверка устарела: позже
   менялся код, который они проверяли. turbo их не запускает. Что с ними сделать?» Варианты: «Оставить закрытыми»
   (рекомендуется: «Ничего не запускать; в отчёте они будут отмечены как закрытые без свежей проверки») и
   «Перепроверить» («По каждой фазе один проход проверяющего агента по нынешнему коду, без тестов и ревью заново;
   фаза остаётся закрытой, расхождения — в отчёт; ~5–10 мин на фазу, по 3 одновременно»). Свои слова не
   принимаются (`allowOther: false`).
2. **`relax`** (аналитик предложил ослабить зависимости, D1). Текст и варианты — как карточка разметки Stage 4
   (D9: «Убрать все» рекомендуется, «Оставить как есть»; выборочно — своими словами с номерами предложений). При
   `autonomy: max` вопроса нет: ослабления идут в список изменений с ADR.

Подтверждение — отдельный вызов после списка изменений (§4.4): «Применить эти изменения одним коммитом? Откатить
можно через git revert.» — «Применить» (рекомендуется) / «Отмена».

### 4.4 Изменения и один коммит

`turbo-run adopt plan --answers stale-closed=keep|reverify,relax=all|none|r1+r2` печатает список изменений простыми
словами и `plan: <sha256>` — отпечаток списка. `turbo-run adopt apply --answers … --plan-sha <sha256>` пересчитывает
план и **отказывает**, если отпечаток другой (владелец подтвердил другой список). Возможные изменения (каждое —
только если ещё не сделано):

| Изменение | Код (существующий, вынесенный или новый) | Файлы |
|---|---|---|
| конфиг turbo (`lang` владельца, остальное — по умолчанию) и его `.gitignore` | `initConfig` | `.planning/turbo/config.json`, `.planning/turbo/.gitignore` |
| `workflow.test_command` → `turbo-run test-changed` (прежний — в `test.full`), `context_window` | тело `init` из `bin/turbo-run.mjs`, вынесенное в `lib/project-init.mjs` | `.planning/config.json`, `.planning/turbo/config.json` |
| `planning.chunked_parallel` = `true`, когда ключа нет (явное `false` проекта не трогается; `--chunked` полоса передаёт сама) | правило `ensureChunkedParallel`, без его коммита | `.planning/config.json` |
| `git.branching_strategy` → `none` (только `lanes.mode: slots` и значение `phase`/`milestone`; спека Stage 4 G9) | `createGsdConfig().set` | `.planning/config.json` |
| разметка ROADMAP, `lanes.json`, ADR ослаблений | `applyAnalysis(…, { relax, commit: null })` (§4.6) | `.planning/ROADMAP.md`, `.planning/turbo/lanes.json`, `.planning/decisions/…` или `.planning/turbo/DECISIONS.md` |
| свежие отчёты перепроверки (`passed`) и отчёты с расхождениями | `adopt reverify` (§4.5) | `<phase dir>/*-VERIFICATION.md`, `.planning/turbo/adopt/reverify-p<N>.md` |
| запись adopt | новое | `.planning/turbo/adopt.json` |

Применение: сначала `adopt.json` с `state: "applying"` и списком путей, затем изменения, затем `state: "applied"`,
затем `commitPaths(root, <ровно эти пути>, "chore(turbo): adopt")` — одним коммитом. Пустой список → коммита нет,
строка `no changes: already adopted`. Ничего вне этих путей adopt не пишет (кроме `run/`, который игнорируется).

`adopt.json` (коммитится):
```json
{ "v": 1, "state": "applied", "at": "<ISO>", "turbo": "0.5.0", "gsd": "1.16.0",
  "answers": { "stale-closed": { "value": "keep", "set": ["24", "25"] },
               "relax": { "value": "all", "roadmap_sha256": "<hex>", "ids": ["r1"] } },
  "staleClosed": ["24", "25"], "reverified": { "24": "passed", "25": "gaps_found" },
  "roadmap_sha256": "<hex>", "paths": ["…"], "forecast": { … }, "plan": "<sha256>" }
```

### 4.5 «Перепроверить»

Только если владелец выбрал. Скилл для каждой фазы `closed-stale`, не больше трёх одновременно (проверяющие могут
гонять тесты): `gsd-tools query init.execute-phase N`, затем **только** вызов Agent шага `verifier_dispatch` из
`<gsd-core>/workflows/execute-phase/steps/verify-phase-goal.md`, ровно как там написано (G13; так же, как маршрут
`verifier-only` в «Stale report» у `/turbo-phase`). Без хуков, ревью и регрессии. Потом
`turbo-run adopt reverify N`:
- `gsd-tools verification status <phase dir>` = `passed` → новый отчёт остаётся (войдёт в коммит), фаза станет `done`;
- иначе → новый отчёт переносится в `.planning/turbo/adopt/reverify-p<N>.md`, рабочий VERIFICATION.md возвращается к
  закоммиченному (`git checkout -- <файл>`), фаза остаётся закрытой; в отчёт: «расхождения, скорее всего, внесли
  следующие фазы; фаза остаётся закрытой; отчёт: …».

Агент упал или не написал отчёт → то же, что «не passed», с причиной. Перепроверка ничего не перепланирует и не
исполняет (G15). Итог каждой фазы `adopt reverify` пишет и в `run/adopt-reverify.json`: `apply` считает такие фазы
по-прежнему `closed-stale` при пересчёте плана, поэтому отпечаток, подтверждённый владельцем, не меняется от того, что
фаза после перепроверки стала `done`; пути перепроверки (отчёт фазы или `reverify-p<N>.md`) в отпечаток не входят.

### 4.6 Разметка в adopt (D1)

Когда `lanes.mode: slots` и `lanes.json` нет или он не свеж: скилл запускает `turbo-run annotate brief`, затем
`Agent(subagent_type="turbo-lane-analyst")` с путями брифа и анализа (как сессия разметки Stage 4), затем
`adopt plan` проверяет анализ (`validateAnalysis`). Отказ → агент ещё раз с перечнем проблем; снова отказ → adopt
идёт без разметки (прогноз «после» — только по `Depends on`, с пометкой; разметку сделает `start`).

`applyAnalysis` получает два новых параметра: `relax` (решение владельца: `'all' | 'none' | ['r1', …]`; при
`autonomy: max` — `'all'`, как сейчас) — тогда карточка не задаётся, а принятое применяется с ADR, как
`applyAnswer`; и `commit: null` — ничего не коммитить (adopt коммитит всё сам). Поведение annotate-сессии в слоте не
меняется.

**Переразметка после prep.** Запись фазы в `lanes.json` получает `context: true|false` — был ли CONTEXT.md, когда её
размечали. `stalePhases` дополнительно считает устаревшей фазу с `confidence: low` и `context: false`, у которой
CONTEXT.md теперь есть. Тогда после prep `pendingJobs` ставит annotate только для таких фаз. Записи без поля
(разметка v0.4) так не устаревают. Цикла нет: после переразметки `context: true`.

### 4.7 Прогноз

`lib/adopt-forecast.mjs`, чистая функция, без LLM.
- **Длительность фазы** `H`: медиана по ≤ 5 последним завершённым фазам майлстоуна — от первого коммита в каталоге
  фазы до коммита её завершения (`docs(phase-N): complete…` или последнего коммита каталога); нет истории — `H = 1`
  («фаза» как единица), отчёт так и пишет.
- **До** (обычный GSD): незавершённые фазы по одной, `n × H`; критический путь — `n` фаз подряд.
- **После** (turbo): симуляция по событиям с `pickPhases` (T4): слотов `max_lanes` (`checkout` — 1), `Areas`/`Gates`
  из разметки (без неё — каждая фаза `**`), зависимости с учётом ослаблений, все фазы длиной `H`. Результат — шаги
  вида `32 → 33 ∥ 35 → 34 ∥ 36 → 37` и время `T_lanes`.
- **С ускорением внутри фазы:** `T_lanes × k`, `k = 0,45` — оценка основной спеки §10 (фаза ≈2–2,5× быстрее);
  константа в коде с этой ссылкой, отчёт пишет её как оценку.
- Прогноз ускорения: `n×H / T_lanes` («только полосы») и `n×H / (T_lanes×k)` («с ускорением внутри фазы»).

### 4.8 Отчёт

`turbo-run adopt apply` (и `turbo-run adopt report`, перепечатка из `adopt.json` + текущее состояние) печатает на
языке конфига, простыми словами:
1. **Где проект:** активная фаза и её стадия; по строке на состояние из §4.2 со списком фаз.
2. **Закрытые фазы без свежей проверки:** список, решение владельца, итог перепроверки по фазам.
3. **Полосы и критический путь:** до / после (шаги), прогноз ×.
4. **Что изменено:** пункты списка §4.4 и коммит (`<sha> chore(turbo): adopt`), как откатить.
5. **Что остаётся владельцу:** фазы с `owner-live`/`owner-signature` в `Gates`; открытые вопросы turbo (число и
   `/turbo-autonomous answer`); `human_needed`/UAT незакрытых фаз (полоса пройдёт их turbo-uat, остальное спросит
   одной карточкой); рабочие копии агентов (`turbo-run worktrees prune <path> --dry-run`); оставленные гейты
   (`turbo-run gates restore N`); что первый запуск создаст N копий проекта рядом и подготовит M фаз заранее.
6. **Запуск:** `/turbo-autonomous` (и `--from N`, если активная фаза не первая незавершённая).

### 4.9 Повтор и обрыв

- `adopt.json` с `state: "applied"`: обзор пишет `adopted <at>`; вопросы с ответом для того же набора (тот же список
  `closed-stale`; те же предложения ослаблений по ROADMAP digest) не задаются; изменения считаются заново; пусто →
  без коммита, только отчёт.
- `adopt.json` с `state: "applying"` (обрыв до коммита): грязные пути ⊆ `paths` записи → проверка их принимает,
  `apply` пишет заново (все записи идемпотентны) и коммитит. Грязные пути вне записи → отказ §4.2.
- `git revert` коммита adopt удаляет `adopt.json`: следующий `/turbo-adopt` начинает с нуля.

### 4.10 Пропуск закрытых фаз вне adopt

`turbo-run start` (в выводе, который показывает `/turbo-autonomous`) и `turbo-run status` печатают строку, пока набор
`closed-stale` не совпадает с `adopt.json.staleClosed` (владелец уже решил): en `closed phases not re-verified: 24–31
(checked off, verification stale; turbo skips them) · /turbo-adopt`, ru `закрытые фазы без свежей проверки: 24–31
(отмечены сделанными, проверка устарела; turbo их пропускает) · /turbo-adopt`. Лог супервизора — как сейчас.

### 4.11 Скилл `skills/turbo-adopt/SKILL.md`

```markdown
---
name: turbo-adopt
description: Move a GSD milestone that is already running on plain GSD onto gsd-turbo — shows where the project stands and which closed phases turbo skips, asks every question at once, shows the list of changes, applies them after one confirmation in one commit (chore(turbo): adopt; undo with git revert), and ends with a report and the /turbo-autonomous command. Does not start the run.
argument-hint: ""
allowed-tools: [Bash, Read, Agent, AskUserQuestion]
---

Reply in the user's language. `turbo-run` means `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"`;
always run that full form, from the project root. Never start the supervisor, a lane or a GSD phase command here.

1. **Check.** `turbo-run adopt scan --lang <en|ru by the user's language>`. Exit 1: show its `refused:` lines and what
   each asks the user to do; for a dirty tree, show the list and ask the user what to do with it (commit nothing
   yourself), then stop. `nothing to adopt: …`: show it and stop. Otherwise show its overview as it is.
2. **Markup.** When the overview says `markup: needed`: `turbo-run annotate brief`, then
   `Agent(subagent_type="turbo-lane-analyst", description="turbo adopt markup", prompt="Brief: <brief path>. Write
   your analysis to <analysis path>.")` with the paths it printed. Then `turbo-run adopt plan --json`; its `analysis`
   is `refused` with `problems` → dispatch the analyst once more with the problems listed; refused again → go on
   (adopt goes on without markup).
3. **Questions.** `turbo-run adopt plan --json`. Ask every question of its `questions` in ONE AskUserQuestion call,
   built as in section **Answer the open questions** of the turbo-autonomous skill (header, question with the first
   300 characters of context, options with (Recommended)). No questions: go to point 4.
4. **Changes.** `turbo-run adopt plan --answers <id>=<value>,…` with the answers (`stale-closed=keep|reverify`,
   `relax=all|none|r1+r2`). Show its list of changes and its forecast as they are. Ask ONE AskUserQuestion: apply
   these changes in one commit (Apply, recommended) or Cancel. Cancel: say nothing was changed and stop.
5. **Re-verify** (only with `stale-closed=reverify`): for each phase on the `reverify:` line, at most 3 at a time,
   each batch in ONE message: run `node "<gsd-core>/bin/gsd-tools.cjs" query init.execute-phase <N>` and make only the
   Agent call of step `verifier_dispatch` of `<gsd-core>/workflows/execute-phase/steps/verify-phase-goal.md`, exactly
   as written there (`<gsd-core>`: the `gsd-core` line of `turbo-run doctor`). Skip its hooks, code review and
   regression gate. After each returns: `turbo-run adopt reverify <N>`.
6. **Apply.** `turbo-run adopt apply --answers <the same> --plan-sha <the plan sha of point 4>`. `refused: the plan
   changed …` → run point 4 again. Show its report as it is; it ends with the command that starts the run. Do not
   run that command.
```

## 5. B. Черновики планов

### 5.1 Идея и выигрыш

Сейчас (G2, G4): волна k планируется только после коммита волны k−1, потому что планировщик опирается на уже
написанные планы. Цепочка из 8 волн по ~22 мин = ~3 ч только на ожидание.

С черновиками: сразу после outline все планы волн ≥ 2 пишутся черновиками **параллельно** с волной 1 — по строкам
outline предшественников (цель, волна, зависимости, требования) и нынешнему коду. Дальше по волнам: каждый черновик
**сверяется** с написанными предшественниками (ревизия, ~5–8 мин) и становится планом. Критический путь:
`outline (~5) + max(план волны 1, черновики) (~25) + 7 × сверка (~6) ≈ 70–80 мин` вместо ~3,5–4 ч; проверка планов GSD
(шаги 10–13) одинакова в обоих случаях.

### 5.2 Где это происходит

В шаге `plan` полосы (`skills/turbo-phase/SKILL.md`, п.2): полоса сама ведёт `gsd-plan-phase N --chunked` как
оркестратор (так она уже перехватывает шаг 15 и вставляет вопросы после коммитов). Новый раздел скилла **Plan
drafts** меняет только §8.5.2 GSD: где GSD сделал бы одноплановый вызов для плана, у которого есть черновик, полоса
делает сверку и `--promote`; результат для GSD — тот же файл на диске (`marker_received`), дальше его п.6–7
(проверка диска, коммит). Всё до §8.5.2 и всё после (шаги 9–15) — GSD без изменений.

### 5.3 Пригодность outline (`turbo-run plan-drafts N --plan`)

Читает outline фазы (`planOutline` + новый разбор строк: `id`, `objective`, `wave`, `dependsOn`, `requirements`).
`drafts off: <why>` (полоса идёт как в v0.4), если:
- `plan_drafts.enabled` = false;
- нет outline или он не закончен (`## OUTLINE COMPLETE`);
- в таблице нет колонки Wave или Depends On; у строки нет id; зависимость называет id вне outline; зависимость в той
  же или более поздней волне; волна не число (пустая = 1, как в G2);
- волн с ещё не написанными планами меньше `min_waves` (D5) — только пока черновиков ещё нет;
- проверка планов GSD выключена (`plan_checker`, иначе `workflow.plan_check` = false в `.planning/config.json`, как
  читает `init plan-phase`): `drafts off: plan checker disabled`;
- шаг — не первичное планирование (вызов из `--gaps`/`--reviews`/freshness; скилл туда раздел не подключает).

`plan_drafts.enabled: false` тоже пишет `lastPlan` (строка замера: `drafts off: plan_drafts.enabled is false`).
Иначе `drafts on: <W> waves, <P> plans · draft now: <ids> · left to GSD: <ids>` — черновики для ещё не написанных
планов волн после той, которую GSD планирует сейчас (при первом вызове — волн ≥ 2), не больше `max_parallel`, ранние
волны первыми, **один раз** вместе с первой волной; остальные GSD планирует сам на своих волнах (повторной раздачи по
мере возврата нет — сокращение объёма после ревью спеки). Перед ответом `--plan` убирает черновики, оставленные агентом
в каталоге фазы (`removed: …`), и называет перенесённые, но не закоммиченные планы (`commit first: <ids>`, §5.7).

### 5.4 Черновик

- Файл: `<localRunDir(slot)>/drafts-p<N>/<id>-PLAN.md` — в `run/` слота (игнорируется git), **никогда** в каталоге
  фазы (G6). Запись: `<localRunDir>/drafts-p<N>/drafts.json` рядом. Слот подготовлен заново → и файлы, и запись
  исчезают вместе → обычный путь.
- `turbo-run plan-drafts N --drafting <id>` записывает `drafting` и печатает абзац, который полоса добавляет без
  изменений в конец однопланового промпта GSD для этого плана (G3):

  > **Draft (gsd-turbo).** The plans before this one are not written yet. Plan from their outline rows below and
  > from the code as it is now. Write exactly one file, `<draft path>`, instead of `{PHASE_DIR}/<id>-PLAN.md`, and
  > write nothing in the phase directory. Skip your update_roadmap and git_commit steps; do not edit ROADMAP.md or
  > STATE.md; do not commit. Keep the frontmatter `wave: <w>` and `depends_on: [<ids>]` of the outline
  > row. End the plan with a section `## Draft assumptions`: per earlier plan, each thing this plan takes from it (a
  > file it creates or changes, a function, type or command it adds, a decision), one line each, starting with that
  > plan's id. Outline rows of the earlier plans: `<rows>`.

- `--drafting` запоминает PLAN-файлы каталога фазы (плоские `*-PLAN.md` и `plans/`); первый `--drafting` — ещё и как
  «были до черновиков» для гарантии §5.5. Протухшая запись `drafting` (> 90 мин) теряет недописанный черновик.
- Агент вернул `## PLAN COMPLETE` → `--drafted <id>`: файл есть, начинается с `---`, `wave`/`depends_on` совпадают со
  строкой outline (`depends_on` нормализуется: кавычки, блок-список, `01` = `33-01`, длинная форма), есть раздел
  допущений, и агент не записал в каталог фазы ни свой `<id>-PLAN.md`, ни новый PLAN-файл вне outline
  (`33-02-auth-PLAN.md`, `plans/…`) → `drafted` + блоб. Такие файлы turbo удаляет сам (`git rm` и коммит, если агент
  их закоммитил) — `--drafted`, `--reconciled` и `--replan` — и отказывает. ROADMAP.md, STATE.md и коммиты не
  проверяются (G16). Блоб черновика записывается и при отказе. Иначе отказ → `--replan <id>`: обычный путь.

### 5.5 Сверка, перенос, гарантии

На волне w для каждой записи runnable-набора GSD:
1. `turbo-run plan-drafts N --reconcile <id>`:
   - `use: gsd` — черновика нет, он `replanned`, агент черновика не вернулся (`drafting`) или файл не совпадает с
     блобом записи → обычный вызов GSD; каждый такой ответ переводит запись в `replanned`;
   - отказ, если хотя бы один предшественник (каждый из `depends_on`, каждый ранний план, названный в `## Draft
     assumptions`, и каждый план ранней волны, чьи `files_modified` пересекаются с `files_modified`/путями черновика) ещё
     не **закоммичен** в каталоге фазы;
   - иначе запись `reconciling` с `against: {id: <блоб закоммиченного плана>}` и печать блока для промпта: пути
     черновика, предшественников, outline, CONTEXT.md; допущения черновика.
2. Все сверки волны — одним сообщением: `Agent(subagent_type="gsd-planner")` с `<revision_context>` по G9: измерение
   `draft-reconcile`, `severity: blocker`, `required_property`: «every file, symbol, interface, command and decision
   this plan takes from the plans before it matches what those plans now say; its wave and depends_on equal its
   outline row; it does not redo work a plan before it already does; nothing it relies on is missing from them»,
   `description` — допущения черновика. Инструкция (G17): прочесть `planner-revision.md` и применить из него только
   шаги 2–5 (с 2.5), не 1, 6 и 7; читать только перечисленные файлы; никогда не запускать git и коммит gsd; вернуть
   только маркеры ниже (`## REVISION COMPLETE` без незакрытых замечаний полоса считает как `PASSED`);
   править **только** файл черновика, на месте, минимально; вернуть `## RECONCILE PASSED` (строка на правку или
   `no change`) или `## RECONCILE FAILED` с причиной (предшественник пошёл другим путём, сдвинулся объём, не хватает
   зависимости). `## REVISION_CONFLICT` = провал. Вызовы сверки — в переднем плане, вне `gsd_stall_watch` GSD (его
   маркер — файл плана, которого сверка не пишет).
3. `--reconciled <id> --verdict passed|failed`: отказ, если блоб любого предшественника изменился с п.1 (сверять
   заново) или агент сверки записал PLAN-файл в каталог фазы (удаляется, как у `--drafted`); пишет вердикт и блоб
   черновика после правок.
4. `passed` → `--promote <id>`. Проверки: вердикт `passed` и блобы предшественников те же; черновик — блоб из п.3;
   начинается с `---`; `wave`/`depends_on` = строка outline; нет пересечения `files_modified` с уже готовыми планами
   той же волны (G7); файла `<id>-PLAN.md` в каталоге фазы нет. Тогда раздел `## Draft assumptions` вырезается,
   файл атомарно пишется в каталог фазы, запись `promoted` + блоб. Полоса коммитит его сообщением GSD (G5), в порядке
   строк outline, и делает **List and classify** (вопросы владельца) — как после любого плана.
5. Провал на любом шаге → `--replan <id> --reason …` и обычный одноплановый вызов GSD для этой записи (с его
   п.5–8: ожидание, диск, коммит, повтор/стоп).

**Гарантия «не исполнить несверенное»** (`planSetCheck`, значит `--check plan`, `--done plan` и `--plan-checked`):
для каждого плана каталога фазы с записью черновика этого outline, кроме `replanned`, блоб **последнего** добавившего
файл коммита (`git log -1 --diff-filter=A`; пока не закоммичен — рабочий блоб) должен равняться блобу `promoted`; и
никакой PLAN-файл фазы под любым именем не может равняться записанному блобу `drafted`/`reconciled` (в любом
состоянии записи). PLAN-файл вне строк outline гарантия не трогает: цикл ревизий GSD может разбить план на новые
(`scope_sanity` в planner-revision.md); такие файлы агентов turbo удаляет, пока окно агента известно (`--drafted`,
`--reconciled`, `--reconcile` за потерянного агента, `--replan` записи `drafting`/`reconciling`). `--plan` с
ответом `drafts off` в возобновлённой сессии отдаёт GSD все неперенесённые черновики этого outline (`replanned`).
Иначе: `plan <id> came from a draft without a passed reconcile: delete it and plan it again (turbo-run plan-drafts N
--replan <id>)`. `--replan` сам удаляет такой файл (с коммитом, если он закоммичен); после удаления и коммита GSD
пишет план заново, и последний добавивший коммит — уже его. Ревизии plan-checker после переноса — обычная работа GSD
и не проверяются.

**Почему безопасно:** (1) черновик живёт вне каталога фазы — GSD его не видит, исполнитель тоже; (2) в каталог фазы
план попадает либо одноплановым вызовом GSD, либо `--promote` после пройденной сверки против закоммиченных
предшественников; (3) весь набор потом проходит plan-checker и ревизии GSD без изменений (G8); (4) любой сбой
сворачивается в обычный путь GSD для этого плана; (5) outline без нужных данных — режим v0.4 целиком.

### 5.6 Порядок по волнам и вопросы

Каждая волна, которую GSD раздаёт после `drafts on` (и первая исполняемая волна возобновлённой сессии: в ней может
быть черновик), идёт через `--reconcile` для каждой записи runnable-набора; возвраты черновиков этой волны
(`--drafted`/`--replan`) обрабатываются до проверки возобновления GSD (§8.5.2 п.2), так что удалённый turbo файл
остаётся в runnable-наборе. При последовательной раздаче (`CHUNKED_PARALLEL` false) сверки идут одним сообщением с
первым вызовом GSD волны. Волна 1 — как говорит GSD. Черновики идут фоном (`run_in_background=true`) и не задерживают её коммиты. Волна w ≥ 2
ждёт свои черновики (и только их). После коммита каждого плана (обычного или перенесённого) — `turbo-run questions
N` и классификация (v0.4, J3); с черновиками планы, а значит и вопросы, появляются быстрее.

### 5.7 Обрыв и продолжение

Шаг `plan` повторяется с начала (как в v0.4): GSD возобновляет chunked по outline и пропускает готовые планы (G6),
полоса снова зовёт `--plan`: записи `drafted`/`reconciled` с файлом и тем же блобом используются, `drafting` без
готового файла — обычный путь (`use: gsd`; запись `drafting`, агент которой молчит дольше 90 мин, `--plan` раздаёт
заново), `reconciling` — сверяется заново. Изменился outline (другой sha) — все черновики недействительны. `--plan`
удаляет черновики, оставленные агентом в каталоге фазы, и печатает `commit first: <ids>` для перенесённых, но не
закоммиченных планов, файл которых всё ещё равен блобу `promoted`: полоса коммитит их сообщением GSD до цикла волн.
Перед любой остановкой полоса ждёт все свои фоновые агенты (правило скилла).

### 5.8 Замер

- Только для шага `plan` (сокращение объёма): `run/plan-clock-p<N>.json` хранит `started` (первый раз, когда
  `phase-step N` назвал `plan` следующим) и `done`. Отдельный файл рядом с `phase-p<N>.json`, чтобы ни одному писателю
  того файла не нужно было его переносить. `phase-step N --json` отдаёт `timings.plan`.
- `phase-step N --done plan` пишет в `logs/supervisor.log` управляющего корня одну строку:
  `phase 33 plan: 1h12m wall clock · drafts on: 10 plans in 8 waves, 9 drafted, 8 reconciled, 1 replanned` или
  `phase 33 plan: 3h48m wall clock · drafts off: <why>`; та же строка — в заметку шага. Время — от `started.plan` до
  `--done plan` (вместе с паузами контекста). `plan-drafts --status` и число сессий в строке — сняты (сокращение
  объёма).

### 5.9 Стоимость

Каждый план волны ≥ 2 пишется один раз черновиком (как и раньше — один раз), плюс сверка (~25–40 % плана) плюс
переделка обычным путём для провалившихся. Ожидание: +30–50 % токенов на шаг `plan`.

## 6. Конфиг — новые ключи

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `plan_drafts.enabled` | `true` (D4) | черновики планов в шаге `plan` |
| `plan_drafts.min_waves` | `3` (D5) | меньше волн с ненаписанными планами — без черновиков |
| `plan_drafts.max_parallel` | `8` | черновиков, раздаваемых один раз вместе с первой волной (G10) |

Проверка значений — как `lanesSettings`: неверное значение → ошибка конфига с именем ключа (никогда «тихо выключено»
или «тихо больше»). adopt новых ключей не добавляет.

## 7. Команды

| Команда | Что делает |
|---|---|
| `turbo-run adopt scan [--json] [--lang en\|ru]` | обзор §4.2; отказы exit 1 |
| `turbo-run adopt plan [--answers …] [--json] [--lang …]` | вопросы, изменения, прогноз, `plan: <sha>` |
| `turbo-run adopt reverify <N>` | итог перепроверки §4.5 |
| `turbo-run adopt apply --answers … --plan-sha <sha> [--lang …]` | изменения + один коммит + отчёт |
| `turbo-run adopt report [--json]` | отчёт из `adopt.json` + текущее состояние |
| `turbo-run plan-drafts <N> --plan [--json]` | пригодность и что черновить сейчас |
| `turbo-run plan-drafts <N> --drafting <id>` / `--drafted <id>` | запись черновика, абзац промпта / проверка |
| `turbo-run plan-drafts <N> --reconcile <id>` | `use: gsd` или блок сверки, фиксирует предшественников |
| `turbo-run plan-drafts <N> --reconciled <id> --verdict passed\|failed [--reason …]` | вердикт |
| `turbo-run plan-drafts <N> --promote <id>` | перенос в каталог фазы после проверок |
| `turbo-run plan-drafts <N> --replan <id> [--reason …]` | черновик недействителен, обычный путь (убирает его файл из каталога фазы) |

`plan-drafts` — команда полосы (`PHASE_COMMANDS`); `adopt` — команда владельца, в слоте отказывает (как `start`).
Новый скилл `/turbo-adopt` ставится `install.mjs` без изменений (он ставит все `skills/turbo-*`).

## 8. Тексты скиллов

- `skills/turbo-adopt/SKILL.md` — §4.11.
- `skills/turbo-phase/SKILL.md`: в **Conventions** — исключение «prompts turbo builds by hand» дополняется
  разделом **Plan drafts** (сверка) и абзацем черновика; в шаге `plan` п.2 — одно предложение: «When GSD's outline
  is complete, before its first Wave is dispatched, run **Plan drafts**»; новый раздел **Plan drafts** с пунктами
  §5.3–§5.7 (как в §5.5: команды, один message на волну, вердикты, `--promote` = `marker_received`, провал →
  одноплановый вызов GSD, ожидание фоновых агентов перед остановкой). Точный текст — в плане B, задача 6.
- `skills/turbo-autonomous/SKILL.md`, start п.7 (отчёт): строка `closed phases not re-verified …` из `start`
  передаётся владельцу как есть. `/turbo-plan-milestone`: без изменений.
- `docs/reference.md`: разделы `## Adopting a running milestone` и `## Plan drafts`; ключи в `## Config`.
- README: Roadmap п.5 → «done in 0.5.0»; `/turbo-adopt` в Use.

## 9. Вид и панель

- Строка панели о черновиках (`планирование · волна 3 из 8 · сверено 2 из 9 черновиков`) снята (сокращение объёма
  после ревью спеки): панель шага `plan` — как сейчас; итог — строка замера §5.8.
- `status`/`start`: строка закрытых фаз без свежей проверки (§4.10). Панель — без изменений.

## 10. Сбои

| Сбой | Что происходит |
|---|---|
| adopt: живой супервизор/полоса/attended, грязное дерево, незавершённое слияние | отказ, ничего не меняется |
| adopt: аналитик дважды дал неверный анализ | без разметки; прогноз только по зависимостям; `start` разметит |
| adopt: отпечаток плана изменился между `plan` и `apply` | отказ `apply`, скилл показывает новый список |
| adopt: обрыв до коммита | повтор доводит (§4.9) |
| adopt: проверяющий упал / не `passed` | фаза остаётся закрытой, причина в отчёте |
| черновик: агент не вернулся, файл не тот, `--drafted` отказал | `replan` → обычный путь на своей волне |
| сверка: `FAILED`/`REVISION_CONFLICT`/нет маркера/предшественник изменился | `replan` → обычный путь |
| `--promote` отказал (волна, зависимости, пересечение файлов, файл уже есть) | `replan` → обычный путь |
| в каталоге фазы план из черновика без сверки | `--done plan` отказывает; полоса удаляет и планирует заново |
| слот подготовлен заново посреди планирования | черновиков нет → обычный путь для оставшихся |
| outline изменился | черновики недействительны |
| контекст полосы на пределе посреди шага | ждёт фоновые агенты, пауза; продолжение §5.7 |

## 11. Тесты

- **A, юнит:** классификация фаз по снимкам `init manager` (включая фазу 24 из журнала: `executed`, `stale`,
  `roadmap_complete`); вопросы (нет `closed-stale` → нет вопроса; ответ в `adopt.json` для того же набора → нет
  вопроса; новый набор → снова); прогноз (цепочка, две независимые ветки, `Areas`-конфликт, `Gates`, `max_lanes`,
  `checkout`, без истории — единицы); отпечаток плана; `applyAnalysis` с `relax`/`commit: null`; `stalePhases` с
  `context`.
- **A, с git во временном каталоге:** `apply` — ровно один коммит, ровно перечисленные пути, `git revert` возвращает
  дерево; повтор без изменений — без коммита; обрыв после записи `applying` — повтор коммитит; отказ на грязном
  дереве и живом супервизоре; `reverify` passed/не passed (фальшивый `gsd-tools`).
- **A, CLI и скилл:** вывод `scan`/`plan`/`apply` на en и ru (проверка простых слов, как у `turbo-run ask`); тест
  скилла фиксирует порядок шагов и запрет запуска (`/turbo-autonomous` не вызывается); установка ставит и снимает
  `skills/turbo-adopt`.
- **B, юнит:** разбор строк outline (лишние колонки, жирный/код в ячейках, пустая Wave, ссылки, `Depends On: none`,
  `—`, `01-01, 01-02`); пригодность (все причины `drafts off`); выбор предшественников; абзац черновика (путь, волна, зависимости, строки
  outline; без управляющих символов); вырезание `## Draft assumptions`.
- **B, с git:** полный цикл в каталоге фазы: outline на 4 волны → `--drafting`/`--drafted` → коммит плана волны 1 →
  `--reconcile` (отказ до коммита предшественника) → `--reconciled` (отказ после изменения предшественника) →
  `--promote` → коммит → `--check plan`; план, положенный в каталог фазы мимо `--promote`, → `--done plan` отказывает;
  `--replan` → обычный план проходит; перезапуск: записи переиспользуются; изменённый outline — черновики
  недействительны.
- **B, замер:** `started`/`doneAt`, строка в `supervisor.log` с черновиками и без.
- **B, скилл:** тест текста шага `plan` и раздела **Plan drafts** (команды, один message на волну, обычный путь при
  провале, ожидание фоновых агентов) — как `test/skill-turbo-phase.test.mjs`.
- **E2E с фальшивым `claude`** не нужен: B — внутри сессии полосы (LLM), A — сессия владельца; детерминированные
  части покрыты выше.

## 12. Живая проверка на ПК владельца (после установки v0.5)

1. `/turbo-adopt` в проекте владельца с закрытыми фазами `stale` (как 24–31): обзор называет их; один вопрос; список
   изменений; один коммит; отчёт; `git revert` чисто откатывает; повтор — без коммита.
2. «Перепроверить» на 2–3 закрытых фазах: время на фазу, что сделал агент, итог в отчёте.
3. Прогноз adopt против реальности: после двух фаз на turbo сравнить с `supervisor.log`.
4. `start` и `status` показывают строку закрытых фаз до adopt и не показывают после.
5. **Черновики:** фаза с ≥ 3 волнами в слоте: `planner` пишет в путь черновика и не трогает каталог фазы; сколько
   черновиков реально шли параллельно; время сверки; число `replanned`; строка замера против фазы с
   `plan_drafts.enabled: false` (или против фазы 33: ~3,5–4 ч). Провал (агенты пишут в каталог фазы, сверка дольше
   плана, > половины черновиков `replanned`) → релиз с `enabled: false` (D4). Отдельно: что делают агенты черновиков
   и сверки с ROADMAP.md и коммитами вопреки промпту (G16; turbo их не проверяет), и что `--check plan` после
   планирования считает проверкой только коммит 13d, а не коммит планировщика.
6. Вопросы владельца появляются после каждого перенесённого плана (панель, Telegram).

## 13. Подпроекты и порядок

| Подпроект | Что | Зависит от |
|---|---|---|
| **A adopt** | `lib/adopt.mjs`, `lib/adopt-forecast.mjs`, `lib/project-init.mjs` (вынос `init`), `turbo-run adopt`, `skills/turbo-adopt/SKILL.md`, `applyAnalysis` (`relax`, `commit: null`), `stalePhases` + `context`, строка закрытых фаз в `start`/`status`, docs | — |
| **B plan drafts** | `lib/plan-drafts.mjs`, разбор строк outline в `lib/phase-files.mjs`, `turbo-run plan-drafts`, `planSetCheck` + проверка черновиков, `started`/`doneAt` и строка замера, ключи `plan_drafts.*` в `lib/config.mjs`, раздел **Plan drafts** в `skills/turbo-phase/SKILL.md`, строка панели, docs | — |
| **C release** | слияние A и B в `stage-5`, общий прогон, версия 0.5.0, README/reference, живая проверка §12 | A, B |

A и B независимы и идут параллельно, каждый в своей ветке со своим ревьюером. Общие файлы (ожидаемые конфликты,
решаются объединением): `bin/turbo-run.mjs` (строка `USAGE`; A добавляет `case 'adopt'` и строку в `printStatus`/
`start`, B — ничего, кроме `USAGE`), `docs/reference.md` (разные разделы), `lib/config.mjs` (только B).

## 14. Вне рамок

- Предложения разрезать фазу (§4.8 п.4 основной спеки) — следующий релиз.
- Вопросы владельцу из черновиков (раньше сверки) — кандидат после замера: вопрос может поменяться при сверке.
- Сверка не по волнам, а по готовности прямых предшественников — кандидат после замера.
- Черновики в prep (планы заранее, основная спека F10) — нет.
- `turbo-exec`, граф исполнения планов — Stage 6.
