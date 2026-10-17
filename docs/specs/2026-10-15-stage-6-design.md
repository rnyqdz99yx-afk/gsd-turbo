# gsd-turbo — Stage 6: граф исполнения (план стартует, как только готовы его предшественники)

Дата: 2026-10-15. Основа: дорожная карта, пункт 6 («Execution graph: each plan starts as soon as its dependencies are
done instead of waiting for whole waves»), спеки Stage 4 (слоты, полосы) и Stage 5 (черновики планов), журнал боевых
прогонов (фазы 32, 33, 43) и чтение исходников GSD 1.16.0 (`@opengsd/gsd-core@1.16.0` из npm, §3). Релиз: **v0.6.0**,
после v0.5.0, и только если замер §5 даёт «да».

## 1. Цель и критерии

Сейчас фаза исполняется волнами GSD: волна k+1 стартует, только когда **все** планы волны k закончены, слиты и прошли
тесты. Один длинный план держит всю следующую волну, включая планы, которым он не нужен. Цель Stage 6 — чтобы каждый план
стартовал, как только слиты планы, от которых он действительно зависит.

Работа идёт в два шага (решение владельца 1):

**A. Замер (сделано в этой ветке).** `turbo-run exec-whatif <N>` считает на уже прошедшей фазе, сколько дал бы граф
против волн. Владелец запускает его дома на фазах 32, 33 и 43 и по правилу §5 решает, строить ли B.

**B. `turbo-run exec N`** (строится только после «да»). turbo сам ведёт исполнителей фазы по очереди готовых планов;
GSD делает только хвост: сводку, проверки, верификатор, отметку в ROADMAP.

Готово (B), когда:
1. В шаге `execute` полосы с `exec.enabled: true` и пригодной фазой (§6.2) исполнители стартуют по готовности: план
   уходит исполнителю, как только слиты все его предшественники по графу (§6.2), и свободен слот (`max_executors`).
2. После возврата каждого исполнителя его ветка сливается одной записью `worktree.cleanup-wave` GSD под мьютексом,
   затем идут точечные тесты этого слияния, затем отметка в ROADMAP/STATE — её пишет только полоса.
3. План, вставший у владельца (checkpoint), держит только своих зависимых; независимые планы идут дальше. Полоса
   останавливается для владельца, только когда больше нечего запускать.
4. Когда все планы слиты и тесты зелёные, полоса запускает `gsd-execute-phase N --no-transition`, и GSD идёт сразу к
   своему хвосту (aggregate → verify_phase_goal → update_roadmap), не запуская ни одного исполнителя.
5. Обрыв сессии (контекст, падение, перезагрузка) не теряет работу: новая сессия сливает законченные ветки агентов и
   заново ставит в очередь незаконченные; ничего не исполняется дважды поверх уже слитого.
6. Всё, что не подходит (§6.2), идёт старым путём — `gsd-execute-phase` с волнами, байт в байт как в v0.5.
7. Строка замера в `supervisor.log` для шага `execute` с exec и без — владелец сравнивает с прогнозом `exec-whatif`.

## 2. Решения

Владелец (мозговой штурм 2026-10-15, все ответы = рекомендованные):
1. **Сначала замер.** Калькулятор «что если» сейчас; владелец гоняет его дома на прошлых фазах 32/33/43 и решает
   строить по цифрам. Спека и планы пишутся сейчас, чтобы стройка могла начаться сразу.
2. **Исполнителей ведёт turbo** (очередь готовых в новой команде `turbo-run exec N`), GSD делает только хвост
   (aggregate, проверки, верификатор) через свой маршрут возобновления в execute-phase.
3. **Рёбра графа** = `depends_on` + пересечение `files_modified`/`files_deleted` + чтения по `key_links` (собственное
   правило планировщика GSD).
4. **Пока план ждёт владельца**, независимые планы идут; ждут только его зависимые. Точечные тесты после каждого
   слияния, полный прогон в конце; push пачками.

Решения Claude по доказательствам (§3):
- **D1. Калькулятор — команда `turbo-run exec-whatif`, а не скрипт.** Он использует модули turbo (транскрипты, файлы
  фаз, разбор frontmatter), ставится вместе с turbo (владелец сможет мерить любые проекты и после релиза) и проверяется
  тестами CLI, как остальные команды. Модель графа и расписаний — отдельный чистый модуль `lib/exec-graph.mjs`: его же
  возьмёт `turbo-run exec` (§6.2), так что прогноз и исполнение считают граф одинаково.
- **D2. Цена слияния в прогнозе по умолчанию = хвост волны** (пессимистично для графа). На линейной цепочке граф тогда
  ровно равен волнам (тест), и «да» не может быть артефактом модели. Строка `with a merge at half a wave tail`
  показывает и более реальную цену (слияние + точечные тесты короче полного хвоста волны).
- **D3. Направление неявных рёбер** — по порядку (волна GSD, объявленная волна, id): ребро идёт только от раннего плана
  к позднему. Рёбра `depends_on` идут вперёд в этом порядке, значит граф всегда без циклов.
- **D4. Слияние — собственный механизм GSD**, `worktree.record-agent` + `worktree.cleanup-wave` с манифестом из одной
  записи. cleanup-wave трогает только записи своего манифеста (G9), а проверка базы (`merge-base HEAD branch` =
  `expected_base`) выполняется и после слияний соседей, потому что HEAD полосы — потомок базы (G10). turbo не пишет
  своего слияния веток агентов.
- **D5. `exec.enabled` по умолчанию `false` в v0.6.0** (включается в конфиге проекта). Включается по умолчанию только
  после живой проверки §13 на двух фазах (одна широкая, одна с вопросом владельца). Причина: в отличие от черновиков
  (Stage 5), exec сливает код; ошибка дороже.
- **D6. `max_executors` по умолчанию 4** (сейчас 20, ключ не используется). Таблица `exec-whatif` показывает, где граф
  насыщается; живая проверка §13 п.6 — сколько реально держит ПК владельца (Windows, лимиты, тесты в параллельных
  копиях). Ключ — на полосу; при `max_lanes` 3 это до 12 исполнителей сразу.
- **D7. Пока HEAD полосы красный, новых исполнителей нет.** Уже запущенные работают; новые не ответвляются от сломанного
  кода. Как «Fix now» в GSD (G8).
- **D8. Только primary-набор планов.** Доработки (`--gaps-only`, gap rounds, owner-gaps) идут волнами GSD, как сейчас:
  их мало, и у них свои маршруты.
- **D9. Только изоляция `harness-worktree`** с `worktree.baseRef: "head"` (G11, T3). Иначе (`use_worktrees: false`,
  план в субмодуле, другой рантайм, нет baseRef) — `exec off`, старый путь.
- **D10. Продолжение после вопроса владельца.** Путь «тот же агент» (SendMessage) — как сейчас (T5). Путь «новый агент»
  сначала сливает частичную ветку плана (без тестов и отметки), чтобы новый агент ответвился от кода с уже сделанными
  задачами.

## 3. Что установлено (2026-10-15)

Исходники GSD: `npm pack @opengsd/gsd-core@1.16.0`, пути от корня пакета (`gsd-core/…`, `agents/…`, `hooks/…`).

| # | Факт | Доказательство | Следствие |
|---|---|---|---|
| G1 | Волна плана = 1 + длина самой длинной цепочки `depends_on` до него (Кан); объявленная `wave:` только даёт предупреждение при расхождении | `gsd-core/bin/lib/phase.cjs:680-735` (`computeDependencyLevels`), `:891`, `:972-984` | калькулятор считает волны GSD так же (`gsdWaves`) |
| G2 | Пересечение `files_modified` ребром не считается: планировщик сдвигает **объявленную** волну позднего плана; `files_deleted` тоже | `agents/gsd-planner.md:743-761` | сдвиг без `depends_on` исполнитель GSD не видит (G1) — см. G3 |
| G3 | Волна с пересечением `files_modified` целиком идёт по одному плану | `gsd-core/workflows/execute-phase.md:525-557` | калькулятор моделирует это (`sequential`) |
| G4 | Волны идут строго по очереди; внутри — параллельно; ждать **все** агенты волны | `execute-phase.md:423`, `:779` | барьер — то, что убирает граф |
| G5 | Последовательный хвост каждой волны: слияние веток (cleanup-wave), сборка и тесты после слияния, коммит трекинга `docs(phase-N): update tracking after wave N` | `execute-phase.md:819-857`, `:907-918` (`steps/post-merge-gate.md`), `:920-950` | хвост меряется на границах волн (§4.3) |
| G6 | Вопрос (checkpoint) в параллельной волне: остальные заканчивают, затем продолжение, затем **ждать всех** до следующей волны | `execute-phase.md:1052-1094` | граф: держит только зависимых (решение 4) |
| G7 | `phase-plan-index` даёт `ready_plans` (все предшественники с SUMMARY); не-готовый план не отправляется; «Phase waiting: … dispatch the ready wave, then re-run» → выход | `phase.cjs:940-1038`; `execute-phase/steps/ready-wave-gate.md:13-37`; `execute-phase.md:367` | живая проверка §13 п.1: запускает ли один вызов execute-phase все волны |
| G8 | Красные тесты после слияния: «Fix now» (рекомендовано) или «Continue» | `execute-phase.md:970-997` | D7 |
| G9 | cleanup-wave читает только записи своего манифеста (`--manifest`), не ищет рабочие копии вокруг; запись манифеста — `worktree.record-agent` после каждого возврата агента | `execute-phase.md:738`, `:827-857`; `gsd-core/bin/lib/worktree-safety.cjs:373-466`, `:1484-1527`, `:1551-1760` | слияние одной записью под мьютексом (D4) |
| G10 | Перед слиянием: `merge-base HEAD <ветка>` ∈ `allowed_bases` (по умолчанию `expected_base`); слияние — `git merge --no-ff` с `chore: merge executor worktree (…)` | `worktree-safety.cjs:1177-1183`, `:1324` | база = HEAD полосы в момент отправки; слияния соседей её не ломают (D4) |
| G11 | Без `worktree.baseRef: "head"` харнесс Claude Code ответвляет рабочую копию агента от `origin/HEAD`, и GSD откатывается к последовательному режиму; с ним — от HEAD оркестратора | `execute-phase/steps/worktree-base-check.md:4-24` | exec требует baseRef head (D9); живая проверка §13 п.3: ответвляется ли агент от **сдвинутого** HEAD |
| G12 | Отправки исполнителей — по одной на сообщение (`run_in_background: true`): одновременные `git worktree add` дерутся за `.git/config.lock` | `execute-phase.md:637-645` | exec отдаёт отправки по одной; слияние повторяет попытку на занятом `config.lock`/`index.lock` |
| G13 | Хук `gsd-agent-isolation-guard.js` блокирует отправку `gsd-executor` без изоляции, сверяясь с «сентинелом» решения по плану (`dispatch-isolation --phase N --plan <id>`) | `hooks/gsd-agent-isolation-guard.js:1-60`; `execute-phase/steps/per-plan-worktree-gate.md:118-142` | полоса пишет сентинел перед каждой отправкой (§6.4); живая проверка §13 п.4 |
| G14 | Исполнитель в рабочей копии не трогает STATE.md и ROADMAP.md; коммитит SUMMARY.md и REQUIREMENTS.md; трекинг — единственный писатель-оркестратор | `execute-phase.md:664`, `:678-688`, `:920-950` | трекинг пишет только полоса, после каждого слияния (§6.5) |
| G15 | Отклонение от волн документировано: оркестратор может сливать по-своему (`merge: bring 09-01 + 09-02 into 09-03 base`) и потом убрать рабочие копии «хвостовым» сниппетом | `execute-phase.md:823`, `:859-893` | граф — поддержанный GSD режим, а не обход |
| G16 | Все планы с SUMMARY и нет VERIFICATION.md (или она устарела) → «resuming at the phase gates»: сразу `aggregate_results` → `verify_phase_goal` (code review gate, regression gate, верификатор) → `update_roadmap`, без исполнителей | `execute-phase.md:368-386` | передача хвоста GSD (решение 2, §6.10) |
| G17 | В начале каждого запуска execute-phase GSD убирает «осиротевшие» рабочие копии агентов прошлых сессий | `execute-phase/steps/executor-isolation-dispatch.md:58-59` | перед передачей хвоста и перед attend рабочих копий exec быть не должно (§6.9, §6.11) |
| G18 | Завершение агента решают артефакты (SUMMARY + коммиты), а не сигнал; агент, не ответивший, не считается упавшим | `execute-phase/steps/completion-reconciliation.md`; `execute-phase.md:791-793` | восстановление после обрыва по веткам агентов (§6.9) |
| G19 | Для Claude GSD объявляет `maxConcurrency: 20` | `gsd-core/bin/lib/capability-registry.cjs:591` | верхняя граница `max_executors` |
| G20 | Чтения планировщика: `must_haves.key_links` (`from`, `to`, `via`, `pattern`); «один план производит то, что потребляет другой» — объявлять ребро | `gsd-core/templates/phase-prompt.md:576-602`; `gsd-core/references/planner-coupling.md:9-35` | рёбра `reads` (решение 3) |
| G21 | Описание отправки исполнителя: `Execute plan {plan_number} of phase {phase_number}`; продолжение — `Continue plan …` | `execute-phase.md:648-650`; `lib/transcripts.mjs` `planOf` | калькулятор находит исполнителей плана по транскриптам; exec сохраняет этот текст |
| T1 | `max_executors: 20` в конфиге turbo зарезервирован и нигде не используется | `lib/config.mjs:13`; `docs/reference.md` (Config) | D6 |
| T2 | Шаг `execute` полосы: один `gsd-execute-phase N --no-transition`, push и inbox после каждой волны, проверка контекста перед каждой волной/планом | `skills/turbo-phase/SKILL.md` (раздел `execute`, «The step loop» п.2) | меняется только п.1 шага (§9) |
| T3 | Слот получает `worktree.baseRef: "head"` в `.claude/settings.local.json`; в режиме `checkout` turbo этого не пишет | `lib/slots.mjs:180-193`; спека Stage 4 G8/S2 | exec в `checkout` — только если ключ уже стоит (D9) |
| T4 | `turbo-run test-changed`: точечный прогон относительно последнего полного зелёного; после `test.max_targeted` (3) точечных — полный; с момента, когда у всех планов есть SUMMARY, — полный (правило конца фазы) | `lib/test-changed.mjs:195-207`; `docs/reference.md` («A full test run ends every phase») | новый `--merge <sha>` (§6.5) |
| T5 | Вопрос владельца из checkpoint: `questions --stop` → карточка → «stop for the owner»; ответ будит полосу; доставка тому же агенту (SendMessage) или продолжению | `skills/turbo-phase/SKILL.md` («At a checkpoint», «Delivery») | новый режим «карточка без остановки» (§6.6) |
| T6 | Мьютекс записей в основную ветку — файловый замок `locks/merge` (control root); держится только на слияние и коммиты | `lib/merge-lock.mjs:5-13` | exec берёт свой замок `locks/exec-p<N>` (слияния в ветку полосы, не в основную) |
| T7 | Ответы владельца будят только полосу в `needs-owner`; пробуждение — это `claude stop` и `claude --bg --resume`: оно останавливает сессию, а с ней её фоновых субагентов | `lib/supervisor.mjs:250-289` (`wakeSession`), `:358-399` (`wakeForAnswers`), `:504-506` | ответ на вопрос, который держит только зависимых, идёт в inbox; будить полосу можно, только когда у неё нет работающих субагентов (§6.6) |
| J1 | Фаза 32: волны 1–3 ≈ 67 мин на 14 планов, волна 4 — 24 мин на 3 плана; активная работа плана ≈ 4–23 мин (в среднем ≈ 8) | журнал, «Timing so far» | широкая неровная фаза: ожидаемый выигрыш графа 25–40 % исполнения |
| J2 | Фаза 33: 10 планов в 8 волнах (почти линейная цепочка) | журнал 06:10Z | ожидаемый выигрыш ≤ 10 % |
| J3 | Фаза 32: план 32-01 (волна 1) встал у владельца; GSD пошёл с волнами 2–3; волна 4 зависела от 32-01 и ждала | журнал 08:15Z | то, что решение 4 делает правилом |

Не проверено здесь (только на ПК владельца, §13): исполняет ли один вызов execute-phase все волны (G7); приходят ли
завершения фоновых исполнителей в полосу по одному; ответвляется ли агент от сдвинутого HEAD (G11); как ведут себя
хуки изоляции (G13) и `config.lock` на Windows (G12); сколько исполнителей реально держит ПК.

## 4. A. Калькулятор `turbo-run exec-whatif` (сделано)

### 4.1 Запуск дома

Калькулятор только читает: файлы планов, git и транскрипты Claude Code. Ничего не пишет ни в проект, ни в `run/`.
Ветка `web-stage6` ещё не установлена — запуск из её checkout'а против проекта:

```text
git fetch <dev-remote> web-stage6
git worktree add ../gsd-turbo-stage6 FETCH_HEAD
node ../gsd-turbo-stage6/bin/turbo-run.mjs exec-whatif 32 --project <путь к проекту>
node ../gsd-turbo-stage6/bin/turbo-run.mjs exec-whatif 33 --project <путь к проекту>
node ../gsd-turbo-stage6/bin/turbo-run.mjs exec-whatif 43 --project <путь ко второму проекту>
```

Те же три с `--merge-minutes <половина хвоста>` (строка `gain:` уже показывает этот вариант) и с `--json` для журнала.
Транскрипты Claude Code живут ~30 дней (`cleanupPeriodDays`): фазы 32/33 (2026-10-07 … 10-14) ещё в окне; позже
калькулятор возьмёт время из git.

### 4.2 Что он читает

- **Планы фазы** (`<phase dir>/*-PLAN.md`): `wave`, `depends_on` (любое написание: `01`, `32-01`, `32-01-auth`,
  кавычки, блок-список), `files_modified`, `files_deleted`, `must_haves.key_links` (`from`/`to`; у строки-ссылки —
  слова-пути), `autonomous`, `gap_closure`. Планы доработок (`gap_closure: true`) исключаются: они шли позже, после
  верификации.
- **Минуты плана**, лучший источник первым:
  1. транскрипты: каждый субагент-исполнитель плана (`<claude home>/projects/<ключ>/<сессия>/subagents/agent-<id>.jsonl`
     и `.meta.json`: тип `*executor*`, описание G21; cwd первой записи — в проекте или в его слотах) от первой записи
     до последней; минуты плана — объединение отрезков его агентов, так что ожидание владельца между возвратом на
     checkpoint и продолжением не считается;
  2. git: от «отправки» (последний коммит оркестрации фазы перед первым коммитом плана: трекинг `docs(phase-N)`,
     слияние ветки исполнителя этой фазы, SUMMARY плана ранней волны) до коммита SUMMARY (`docs(<id>): complete …`);
     отправка позже `--max-lead` (20) минут до первого коммита или не найденная → медиана остальных (`start estimated`);
     в плане с checkpoint'ами промежуток больше `--max-gap` (30) минут между его коммитами считается ожиданием;
  3. `--minutes 32-07=12,…` — числа владельца, сильнее обоих.
- **Хвост волны** — на каждой границе волн: первая отправка следующей волны минус последний возврат волны (0–60 мин,
  длиннее — это ожидание владельца или пауза), медиана; транскрипты первыми, затем git, иначе 5 мин
  (`--tail-minutes`).

### 4.3 Модель

- **Волны GSD** (G1, G3–G5): волны по самой длинной цепочке `depends_on`; волна с общим записываемым файлом — по одному
  плану; после каждой волны — хвост. `max_executors` ограничивает и волну (GSD сам ограничен 20, G19).
- **Очередь готовых** (решение 2): план стартует, когда все его предшественники слиты и свободен один из `k`
  исполнителей; первым — план с самым длинным оставшимся путём; законченный план ждёт единственного «сливальщика»
  (по одному, `--merge-minutes`, по умолчанию = хвост волны, D2); зависимые готовы после конца его слияния. Время —
  конец последнего слияния. Таблица для `k` = 1…`max_executors` (не больше числа планов).
- **Рёбра** (решение 3, D3): `depends_on`; общий записываемый файл (`files_modified` ∪ `files_deleted`, пути сравниваются
  без `./` и с `/`; glob и каталог — по своему началу); поздний план читает по `key_links` файл, который пишет ранний (и
  сам его не пишет). `--edges depends,files` или `--edges depends` выключают виды.
- **Цена ребра** — насколько очередь стала бы короче без него (при лучшем `k`): «самые дорогие рёбра».

### 4.4 Вывод

```
phase 32: 17 plans · left out (gap closure): 32-40
timings: transcripts 15 · git, start estimated 2
measured: executors ran from … to … (1h52m wall clock, transcripts), busy 2h40m in total
assumptions: wave tail 6m (median of 3 wave boundaries (transcripts): 5m 6m 9m) · merge after each plan 6m (as a wave tail; --merge-minutes) · edges depends+files+reads: depends_on 21, files 6, key_links 3

GSD waves: 1h41m (4 waves by depends_on)
  wave 1: 32-01 … · 23m + tail 6m
ready queue (graph), by executors at once:
   1:  2h52m  +1h11m (+70 %)
   …
gain: 43m of 1h41m (43 %) at 6 executors · with a merge at half a wave tail: 52m · with depends_on edges only: 50m
critical path 54m: 32-01 23m → 32-07 12m → … (+ 6m merge each)
costliest edges (time the ready queue would save without it, at 6 executors):
  32-03 → 32-09  files: src/api/routes.ts  11m
plans: id · wave · minutes · source · start in waves → in graph
```

(Цифры в примере условные.) `--json` — весь результат одним объектом.

### 4.5 Пределы модели

- Минуты плана — те, что были при волнах: при графе исполнители стартуют раньше на другом коде, но работают столько же.
- Хвост волны в turbo-полосе включает точечные тесты `test-changed`; полный прогон конца фазы одинаков в обоих случаях и
  не входит ни в одну сумму.
- Вопросы владельца: в минуты не входят (только активная работа агентов); граф выигрывает на них дополнительно
  (решение 4), этого калькулятор не показывает — значит, его оценка снизу.
- Git без транскриптов не отделяет ожидание у не-checkpoint плана (пауза контекста) — такие планы видны по
  `start estimated`; поправить — `--minutes`.

## 5. Правило «да / нет» по цифрам калькулятора

Сначала проверка модели: для каждой фазы смоделированные волны GSD (`GSD waves`) против измеренного (`measured:` минус
ожидания владельца из журнала) — расхождение больше 30 % → цифрам не верим: поправить `--minutes`/`--tail-minutes` по
журналу и запустить снова.

- **ДА** (строить B, v0.6.0): хотя бы на одной из широких фаз (32 или 43) `gain` ≥ 20 % **и** ≥ 15 мин исполнения при
  `k` ≤ 6 и цене слияния = хвост волны (по умолчанию); **и** на фазе 33 граф не медленнее волн больше чем на 5 %.
- **СЛАБОЕ ДА** (выигрыш 10–20 %, или ≥ 20 % только при половинной цене слияния): строить E1+E2 (§14) с
  `exec.enabled: false` и проверить одну живую фазу (§13 п.11), затем решать с владельцем.
- **НЕТ** (< 10 % на всех трёх, даже при половинной цене слияния): Stage 6 откладывается. Строка «самые дорогие рёбра»
  подсказывает, куда вместо этого: дорогие неявные рёбра (`files`/`key_links`) — подсказки планировщику; длинные
  одиночные планы на критическом пути — дробить планы, а не строить граф.

Ожидание по журналу (J1, J2): 25–40 % на 32, ≤ 10 % на 33. Результаты и решение — в журнал.

## 6. B. Дизайн `turbo-run exec N`

### 6.1 Кто что делает

```
шаг execute полосы
 0. turbo-run gates off N                                     (как сейчас)
 1. turbo-run exec N --plan        → exec off: <why>  → gsd-execute-phase N (волны, как в v0.5)
                                   → exec on: …       → цикл exec (п.2)
 2. цикл: exec --next → отправки (по одной) → возвраты → exec --returned (слияние, тесты, трекинг)
          checkpoint → exec --checkpoint (карточка, держит зависимых) → … → all merged
 3. turbo-run exec N --done        → gsd-execute-phase N --no-transition (GSD: только хвост, G16)
 4. verification status, gap rounds (волнами GSD, D8), state-sync           (как сейчас)
```

- **turbo** (`turbo-run exec`, детерминированно): граф, очередь готовых, запись `exec-p<N>.json`, сентинел изоляции,
  манифест из одной записи, слияние через `gsd-tools` (G9, G10), точечные тесты, трекинг, пачки push, замер.
- **полоса** (LLM): строит промпт исполнителя ровно как execute-phase шаг 3 (вставки `<worktree_branch_check>` с
  `EXPECTED_BASE`, `<execution_context>`, `<parallel_execution>`), добавляет **Pre-answers**, правило релизов и
  **Temporary files** (как сейчас), делает вызовы Agent, читает возвраты, ведёт вопросы владельца (**At a
  checkpoint**, **Delivery**).
- **GSD**: сам исполнитель и его протокол коммитов; проверки слияния (`cleanup-wave`); хвост фазы.

### 6.2 Граф и пригодность

`turbo-run exec N --plan` строит граф по `lib/exec-graph.mjs` (тот же, что у калькулятора): узлы — планы фазы без
`gap_closure`; рёбра — `depends_on`, общий записываемый файл, чтение по `key_links` (D3). Планы, у которых SUMMARY уже
есть в HEAD, — `done-before` (слиты ранее: волнами, attend, прошлой сессией).

`exec off: <why>` (полоса идёт старым путём), если:
- `exec.enabled` = false;
- шаг `plan` не готов (`phase-step N --check plan` ≠ `plan set complete`; сюда же гарантия черновиков Stage 5);
- `gsd-tools query dispatch-isolation --raw --phase N` ≠ `harness-worktree`, или действующий `worktree.baseRef` (по
  слоям `.claude/settings.local.json`, `.claude/settings.json` проекта, пользовательский) ≠ `"head"` (D9, G11, T3);
- план фазы касается пути субмодуля (правило `per-plan-worktree-gate.md`), или помечен `cross_ai`;
- цикл в `depends_on` (G1) или ссылка `depends_on` на неизвестный план (GSD её отбрасывает, мы — отказываемся: граф был
  бы неточным);
- фаза в attend (§6.11);
- не осталось планов без SUMMARY.

Иначе `exec on: <P> plans (<D> done before), <E> edges (depends_on <a>, files <b>, key_links <c>), critical path <ids>,
max <k> at once`. Первый `--plan` записывает `exec-p<N>.json` и один раз выполняет `gsd-tools query state.begin-phase`
(как `validate_phase` GSD); повторный — сверяет запись с диском (§6.9).

### 6.3 Очередь готовых

`turbo-run exec N --next [--json]`:
- готов — план в `waiting`, все предшественники `merged`/`done-before`, HEAD не красный (D7), нет открытого `blocked`
  слияния (§6.7);
- выдаёт не больше `max_executors − (dispatched + running)` планов, по самому длинному оставшемуся пути (как в модели),
  затем по порядку;
- по каждому: `dispatch <id> · base <sha> · plan <rel path> · files <…> · deletions <…>`, и запись переходит в
  `dispatched` с `base` = HEAD сейчас;
- также строки `owner <id>: <qid>`, `waiting <id> on <ids>`, `red: …`, и одна из: `idle: <n> running` (ждать возвратов),
  `stop: only the owner can unblock: <qids>` (ничего не идёт и не готово, есть вопросы), `stop: nothing can run: <ids>
  failed or blocked` (§6.7), `all merged` (п.3 §6.1).

План из `dispatched`, у которого за 30 мин не появилось `--running`, снова `waiting` (полоса не отправила).

### 6.4 Отправка

Для каждой строки `dispatch` полоса, по одной на сообщение (G12):
1. `turbo-run questions N --preanswers <id>` (как сейчас);
2. `gsd-tools query dispatch-isolation --raw --phase N --plan <id>` — сентинел плана для хука изоляции (G13);
3. `Agent(subagent_type=<EXECUTOR_TYPE по per-plan-executor-routing.md>, description="Execute plan <NN> of phase N",
   isolation="worktree", run_in_background=true, prompt=<промпт шага 3 execute-phase с EXPECTED_BASE = base из --next>)`;
4. `turbo-run exec N --running <id> --agent <agent id>`.

### 6.5 Возврат: слияние, тесты, трекинг

Исполнитель вернулся (уведомление о задаче) с нормальным концом: `turbo-run exec N --returned <id> [--worktree <path>
--branch <branch>]` (метаданные — из `<worktree_metadata>` возврата, иначе из метаданных харнесса, как execute-phase:738).
Под замком `locks/exec-p<N>` (T6; держится на п.1–5):
1. **Сверка артефактов** (G18): на ветке агента есть SUMMARY плана и коммиты плана, нет `## Self-Check: FAILED`. Нет —
   `failed <id>: <why>` (§6.7).
2. **Манифест из одной записи** `run/exec-p<N>/<id>.manifest.json` и `gsd-tools query worktree.record-agent --manifest …
   --agent-id … --path … --branch … --base <base> --files "<files_modified>" --deletions "<files_deleted>"` (G9).
3. **Слияние**: `gsd-tools query worktree.cleanup-wave --manifest …` (merge `--no-ff`, удаление рабочей копии и ветки;
   G10). Занятый `config.lock`/`index.lock` — до 3 повторов с паузой 2/4/8 с. Отказ (`base_mismatch`,
   `merge_failed`, `deletion_check_failed`, …) — `blocked <id>: <reason>` (§6.7).
4. **Точечные тесты**: `turbo-run test-changed --merge <sha слияния>` — новый режим (план E2): цели — файлы этого
   слияния (`<sha>^1..<sha>`), не считается в `test.max_targeted`, полный — только по собственным правилам
   (конфиг, неизвестный раннер). Красно → `red <id>: <первая строка>` (§6.7).
5. **Трекинг** (только при зелёных, G14): `gsd-tools query roadmap.update-plan-progress N <id> complete`, затем
   `gsd-tools commit "docs(phase-N): update tracking after plan <id>" --files .planning/ROADMAP.md .planning/STATE.md`,
   если они изменились. Полоса — единственный писатель этих файлов в шаге.
6. Печать: `merged <id> · tests green · ready now: <ids>` и, когда пора, `push: batch` (§6.11).

### 6.6 Вопрос владельца держит только зависимых

Исполнитель вернул `## CHECKPOINT REACHED`: `turbo-run exec N --checkpoint <id> --agent <a> --task <t>`. Он вызывает
`turbo-run questions N --stop <id>-t<t> --agent <a> --keep-running` (новый флаг, план E2): карточка открывается и
доставляется (панель, Telegram) как сейчас, но статус полосы не становится `needs-owner`; запись плана — `owner`.
Зависимые этого плана ждут; остальные идут. Ответ владельца супервизор кладёт в inbox полосы (`owner-answer`, план E2),
а не будит её: пробуждение остановило бы работающих исполнителей (T7). Полоса читает inbox после каждого возврата
исполнителя. Будит супервизор её, только если у полосы нет работающих субагентов (её ход кончился, а уведомлений больше
не будет). Затем полоса делает **Delivery**:
- тот же агент (SendMessage) — `--running <id> --agent <a>` и ждать его, как раньше;
- новый агент (продолжение) — сначала `turbo-run exec N --continue <id>`: частичная ветка плана сливается одной записью
  (без тестов и трекинга, D10), печатается новый `base`; затем продолжение по шаблону GSD с этим `EXPECTED_BASE`,
  `--running`.

Когда `--next` печатает `stop: only the owner can unblock …` — **Stopping early** с `needs-owner` (карточки уже открыты,
новых нет). Ответ будит полосу, как сейчас.

### 6.7 Красные тесты, сбой исполнителя, заблокированное слияние

- **`red`** (D7): новых отправок нет; работающие продолжают, их возвраты сливаются и тестируются. Полоса чинит вперёд
  (systematic debugging, один коммит `fix(phase-N): resolve post-merge failure after plan <id>`), затем `turbo-run exec
  N --retest`: зелёно → дальше; два раунда (`phase-step N --attempt exec-red`) не помогли → **stop for the owner**.
- **Сбой исполнителя** (нет артефактов, `agent.classify-failure` GSD: quota, unknown): `turbo-run exec N --failed <id>
  --reason …`; квота — подождать и `--retry <id>` (план снова `waiting`) один раз; иначе зависимые ждут, остальные
  идут, в конце — **stop for the owner** с этим планом.
- **`blocked`** (cleanup-wave отказал: конфликт вне объявленных файлов, база, удаление): зависимые ждут; остальные идут;
  в конце — **stop for the owner** по политике восстановления GSD (`worktree-recovery-policy.md`), ветка сохраняется.

### 6.8 Файл состояния `run/exec-p<N>.json`

В `localRunDir` полосы (слот или checkout; игнорируется git), атомарная запись:

```json
{ "v": 1, "phase": "32", "startedAt": "<ISO>", "head0": "<sha>", "graphSha": "<sha256 планов>",
  "maxExecutors": 4, "edges": [{ "from": "32-01", "to": "32-03", "kind": "depends", "why": "" }],
  "red": null, "released": null, "handoff": null, "mergesSincePush": 0,
  "plans": { "32-01": { "state": "merged", "base": "<sha>", "agents": [{ "id": "a…", "at": "<ISO>",
    "worktree": "<path>", "branch": "worktree-agent-…" }], "merge": "<sha>", "tests": "green",
    "question": null, "reason": null, "at": { "dispatched": "<ISO>", "running": "<ISO>", "merged": "<ISO>" } } } }
```

Состояния плана: `waiting` → `dispatched` → `running` → `merged`; боковые: `owner`, `failed`, `blocked`, `done-before`.
`red` — на уровне записи (HEAD), с планом, после слияния которого покраснело. Изменились планы (другой `graphSha`) —
запись пересобирается по диску (§6.9).

### 6.9 Обрыв и продолжение

`--plan` при существующей записи сверяет её с диском и git до любых отправок:
- `merged`: коммит слияния достижим из HEAD и SUMMARY на месте — иначе по диску;
- `dispatched`/`running` (агенты прошлой сессии недостижимы): ищется рабочая копия/ветка агента (записанная или
  `worktree-agent-*` с коммитами плана): SUMMARY закоммичен → путь `--returned` (слить); частичные коммиты без SUMMARY →
  ветка сохраняется как `turbo-salvage/<id>-<UTC>`, рабочая копия удаляется, план снова `waiting` (новый исполнитель
  начнёт с нуля, в заметке шага — имя ветки); ничего → `waiting`;
- `owner`: вопрос ещё открыт → остаётся; отвечен → **Delivery** путём продолжения (§6.6);
- `red` → сначала `--retest`.

Перед паузой по контексту (п.2 «The step loop»): новых отправок нет; дождаться возвратов работающих и слить их; затем
пауза. Перед любой **Stopping early** — так же (правило «ждать фоновых агентов» уже есть). Так рабочих копий exec к
концу сессии не остаётся, и уборка GSD (G17) в следующем запуске ничего чужого не трогает.

### 6.10 Передача хвоста GSD

`turbo-run exec N --done`: отказ, пока хоть один план не `merged`/`done-before`, HEAD красный или осталась рабочая копия
exec. Иначе запись `handoff`, строка замера (§6.12) и `hand-off: gsd-execute-phase N --no-transition`. Полоса
запускает `Skill(skill="gsd-execute-phase", args="N --no-transition")`: у всех планов SUMMARY, VERIFICATION.md нет →
маршрут «resuming at the phase gates» (G16): aggregate → verify_phase_goal → update_roadmap. С этого момента всё как в
v0.5 (п.2 шага `execute`: verification status, gap rounds волнами, state-sync). Если GSD всё же отправил исполнителя
(живая проверка §13 п.10) — это видно в транскрипте; полоса не вмешивается.

### 6.11 Взаимодействия

- **attend.** `turbo-run attend N` сначала вызывает в слоте `turbo-run exec N --release`: возвраты, что уже пришли,
  сливаются; работающие агенты теряются вместе с остановленной полосой, их ветки — по правилу §6.9; запись
  `released`. Сидение владельца идёт `gsd-execute-phase` волнами (как сейчас). `attend N --done` → новая сессия полосы
  `--plan` собирает граф по диску (SUMMARY, сделанные в сидении, — `done-before`).
- **Слоты.** exec живёт внутри полосы: слияния в ветку слота, интеграция в основную — после `close`, как сейчас.
  `max_executors` — на полосу (D6).
- **Черновики планов (Stage 5).** На исполнение не влияют; `--plan` требует законченный шаг `plan`, т.е. и гарантию
  черновиков.
- **Push пачками.** `push.mode: after-wave` → `push-request N --at wave` после каждых `exec.push_every` (3) слитых
  планов (`--returned` печатает `push: batch`) и в `--done`; `after-phase` — как сейчас. **A plan that pushes**: после
  слияния такого плана и зелёных тестов — `push-request N --wait`, как сейчас после волны.
- **Контекст.** `turbo-run context N` перед каждой пачкой отправок (вместо «перед каждой волной»).
- **Inbox.** `turbo-run inbox N` после каждого возврата (вместо «после каждой волны»): CI red, reintegrate, owner-answer.
- **Доработки** (D8): `--gaps-only`, owner-gaps, gap rounds — волнами GSD.

### 6.12 Замер

`run/exec-clock-p<N>.json`: начало (первый `--plan` с `exec on`) и конец (`--done`). `--done` пишет в
`logs/supervisor.log` управляющего корня одну строку: `phase 32 execute: 58m wall clock · exec on: 17 plans (2 done
before), max 4 at once, 15 merges, 1 red, owner waits 22m`; при `exec off` — `phase 32 execute: … · exec off: <why>`
(её пишет `phase-step N --done execute`). Владелец сравнивает с прогнозом `exec-whatif` той же фазы (калькулятор
работает и на фазе, прошедшей через exec: описания отправок те же, G21).

## 7. Конфиг

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `exec.enabled` | `false` (D5) | граф исполнения в шаге `execute`; `false` — волны GSD |
| `max_executors` | `4` (было `20`, не использовался; D6) | исполнителей одной полосы одновременно (1–20, G19) |
| `exec.push_every` | `3` | слитых планов между запросами push при `push.mode: after-wave` (1–50) |

Проверка значений — как `planDraftsSettings`: неверное значение → ошибка конфига с именем ключа.

## 8. Команды

| Команда | Кто | Что делает |
|---|---|---|
| `turbo-run exec-whatif <N> [--json] [--max-executors k] [--tail-minutes m] [--merge-minutes m] [--minutes id=m,…] [--edges …] [--no-transcripts] [--max-lead m] [--max-gap m]` | владелец | калькулятор §4; только чтение |
| `turbo-run exec <N> --plan [--json]` | полоса | граф, пригодность, запись, сверка после обрыва |
| `turbo-run exec <N> --next [--json]` | полоса | что отправить сейчас, кто ждёт, `stop`/`all merged` |
| `turbo-run exec <N> --running <id> --agent <a>` | полоса | агент отправлен |
| `turbo-run exec <N> --returned <id> [--worktree p --branch b]` | полоса | сверка, слияние, тесты, трекинг |
| `turbo-run exec <N> --checkpoint <id> --agent <a> --task <t>` | полоса | карточка без остановки, план `owner` |
| `turbo-run exec <N> --continue <id>` | полоса | слить частичную ветку перед продолжением, новый base |
| `turbo-run exec <N> --failed <id> --reason …` / `--retry <id>` | полоса | сбой исполнителя / повтор |
| `turbo-run exec <N> --retest` | полоса | тесты после починки красного HEAD |
| `turbo-run exec <N> --status [--json]` | полоса, владелец | по плану: состояние, агент, ждёт кого |
| `turbo-run exec <N> --release` | attend, stop | слить пришедшее, спасти частичное, `released` |
| `turbo-run exec <N> --done` | полоса | проверки, замер, передача хвоста |
| `turbo-run test-changed --merge <sha>` | exec | точечный прогон одного слияния (E2) |
| `turbo-run questions <N> --stop … --keep-running` | exec | карточка без `needs-owner` (E2) |

`exec` — команда полосы (`PHASE_COMMANDS`); значения флагов `--running`, `--returned`, `--checkpoint`, `--continue`,
`--failed`, `--retry`, `--agent`, `--task`, `--worktree`, `--branch` входят в `VALUE_FLAGS` `lib/cli-phase.mjs`
(`--reason` уже есть; `--plan`, `--next`, `--status`, `--release`, `--done`, `--retest` — без значений).

## 9. Текст скилла `skills/turbo-phase/SKILL.md`

- Шаг **execute**, п.1: «`turbo-run exec N --plan`. `exec off: …` → `Skill(skill="gsd-execute-phase", args="N
  --no-transition")`, как раньше. `exec on: …` → раздел **Exec loop**, затем п.2.» Остальные пункты шага — без изменений.
- Новый раздел **Exec loop** (после **Plan drafts**): §6.3–§6.11 как команды по порядку — `--next`; на каждую строку
  `dispatch` четыре шага §6.4 (по одной отправке на сообщение); ждать уведомлений; на каждый возврат `--returned` /
  `--checkpoint` (затем **At a checkpoint** с `--keep-running`) / `--failed`; после каждого возврата — `turbo-run inbox
  N` (owner-answer → **Delivery**, путь продолжения через `--continue`), `push: batch` → `push-request N --at wave`,
  `turbo-run context N` перед следующей пачкой; `red` → починка и `--retest`; `stop: …` → **Stopping early**; `all
  merged` → `--done` и `gsd-execute-phase N --no-transition`. Правило: никогда не отправлять план, которого нет в строке
  `dispatch`; никогда не сливать ветку агента руками.
- **Conventions**, список исключений «Never rebuild by hand a prompt…»: + «the executor prompts of **Exec loop**, built
  exactly as execute-phase step 3 builds them».
- «The step loop» п.2 и «Inbox»: «before each wave or plan you dispatch» читается и для пачки отправок **Exec loop**.
- Точный текст — план E3, задача 1.

## 10. Вид и панель

- `turbo-run view --json`: у полосы в шаге `execute` с записью exec — `exec: { done, total, running, owner, waiting,
  red }` (из `exec-p<N>.json` в `laneCwd`).
- Строка шага: ru `выполняются планы · готово 7 из 17 · в работе 3 · ждёт вас 1 · ждут других 6`; en `running plans · 7
  of 17 done · 3 at work · 1 waits for you · 6 wait for others`; при `red` — ru `· тесты красные, чиню` / en `· tests
  red, fixing`. Без записи — как сейчас. Субагенты-исполнители — как сейчас (план и задача из описания).
- `status`: без изменений; строка замера — в `supervisor.log`.

## 11. Сбои

| Сбой | Что происходит |
|---|---|
| фаза не подходит (§6.2) | `exec off`, волны GSD |
| агент ответвился не от base | его `<worktree_branch_check>` останавливает его (exit 42); возврат без артефактов → `failed`; при повторе — **stop for the owner** «харнесс не ответвляет от HEAD» (живая проверка §13 п.3) |
| хук изоляции отказал в отправке | сентинел не тот: `--next` снова; второй отказ → `exec off` для оставшихся планов (волны GSD) с причиной в заметке |
| `config.lock`/`index.lock` занят | 3 повтора; потом `blocked` |
| конфликт слияния (файл вне объявленных) | `blocked`, зависимые ждут, остальные идут; в конце — владелец |
| тесты после слияния красные | `red`, новых отправок нет, починка вперёд, 2 раунда, затем владелец |
| исполнитель упал / квота | `failed`, один повтор, затем владелец |
| вопрос владельца | `owner`, держит только зависимых; `stop` — когда больше ничего не идёт |
| сессия оборвалась | §6.9: слить законченное, спасти частичное, продолжить |
| attend посреди exec | `--release`, затем сидение волнами |
| план изменили посреди exec (ревизия) | другой `graphSha` → граф по диску заново; уже слитое — `done-before` |
| GSD в хвосте всё же исполняет план | видно в транскрипте; не вмешиваться; живая проверка §13 п.10 |

## 12. Тесты

- **Граф и модель** (сделано): `test/exec-graph.test.mjs` — разбор frontmatter (все написания `depends_on`, блок-списки,
  `key_links` объектами и строками), сравнение путей (glob, каталог), волны как в `phase.cjs`, рёбра и их направление,
  расписание волн (барьер, хвост, последовательная волна, лимит), очередь (слияния по одному, приоритет пути), цепочка
  = волнам при цене слияния = хвосту, критический путь, цена рёбер.
- **Калькулятор** (сделано): `test/exec-whatif.test.mjs` (git во временном каталоге с датами коммитов, синтетические
  транскрипты: объединение отрезков, чужой проект, планировщик, другая фаза; хвосты; `--minutes`; только чтение) и
  `test/cli-exec-whatif.test.mjs` (`--project` из чужого каталога, `--json`, отказы, usage).
- **E1, юнит:** запись и переходы состояний; `--next` (готовность, лимит, приоритет, `red`, `stop`, `all merged`,
  протухший `dispatched`); пригодность (каждая причина `exec off`).
- **E1, с git:** настоящие `git worktree add` во временном репозитории вместо харнесса; поддельный `gsd-tools`
  (`test/helpers/fake-gsd.mjs`) с `worktree.record-agent`/`cleanup-wave` (настоящий `merge --no-ff` и проверка
  merge-base); полный цикл: два независимых плана и зависимый → отправки, возвраты не по порядку, слияния по одному,
  зависимый отправлен от сдвинутого HEAD, проверка базы проходит; конфликт → `blocked`; красный тест → `red` →
  `--retest`; обрыв: запись `running` + ветка с SUMMARY → слита, ветка без SUMMARY → `turbo-salvage/…`, план снова
  `waiting`; `--release`; `--done` отказывает до конца; строка замера.
- **E2:** `test-changed --merge` (цели — файлы слияния, не считается в `max_targeted`, полный по своим правилам);
  `questions --stop --keep-running` (карточка есть, `needs-owner` нет); `owner-answer` в inbox; пробуждение только
  полосы без работающих субагентов (с работающими — ни одного `claude stop`).
- **E3:** текст скилла (порядок команд **Exec loop**, по одной отправке на сообщение, запреты, `--keep-running`,
  `--continue`, хвост GSD); вид (строки ru/en, без записи — как сейчас).
- E2E с настоящим `claude` не нужен и невозможен здесь; всё LLM-ное — в живой проверке §13.

## 13. Живая проверка на ПК владельца

До стройки (замер, A):
0. `exec-whatif` на 32, 33, 43 (§4.1), решение по §5; цифры и решение — в журнал.

После установки v0.6.0 (B, `exec.enabled: true` в одном проекте):
1. **G7, «Phase waiting» (#4628):** на обычном GSD (exec off) фаза с ≥ 3 волнами — один вызов `gsd-execute-phase`
   прошёл все волны или вышел после первой с «Phase waiting … then re-run»? (Важно и для базы сравнения, и для
   старого пути.)
2. Завершения фоновых исполнителей приходят в полосу **по одному** (уведомления), и полоса успевает слить и
   протестировать один, пока другие работают.
3. `isolation="worktree"` с `baseRef: head` ответвляет нового агента от **сдвинутого** HEAD (после слияний соседей):
   его `<worktree_branch_check>` с новым `EXPECTED_BASE` проходит.
4. Хуки изоляции GSD (G13) пропускают отправки turbo с сентинелом по плану; `cleanup-wave` с одной записью работает,
   пока живут рабочие копии других агентов, и не трогает их.
5. Windows: конкуренция `config.lock`/`index.lock` (слияние и `worktree remove` одновременно с `worktree add` новой
   отправки): сколько повторов, были ли `blocked`.
6. Сколько исполнителей реально держит ПК (лимиты, CPU/RAM, тесты исполнителей в параллельных копиях, порты): значение
   `max_executors` (D6).
7. Вопрос владельца посреди exec: карточка без остановки полосы; независимые планы идут; ответ доходит до **занятой**
   полосы через inbox при следующем возврате исполнителя, без пробуждения (T7), а до полосы без работающих субагентов —
   пробуждением; путь «тот же агент» продолжает в той же рабочей копии; путь продолжения сливает частичную ветку и
   ответвляется от неё.
8. Слияния REQUIREMENTS.md, который коммитит каждый исполнитель (G14), идут без конфликтов (счёт).
9. Обрыв: остановить супервизор посреди exec → `resume`: законченные ветки слиты, частичные спасены, ничего не
   исполнено дважды.
10. Передача хвоста: `gsd-execute-phase N --no-transition` после `--done` идёт маршрутом «resuming at the phase gates»
    (G16), не отправляет исполнителей, `safe_resume_gate` не останавливается.
11. Замер: строка `phase N execute: …` против прогноза `exec-whatif` той же фазы; против прошлой фазы похожей ширины
    волнами.
12. attend посреди exec: `--release`, сидение волнами, `attend --done`, продолжение по диску.

Провал п.2, 3 или 4 (то, без чего очередь не работает) → v0.6.0 выходит с `exec.enabled: false` и записью в README; п.5,
6, 8 → настройка (`max_executors`, повторы); остальное — исправления до включения по умолчанию (D5).

## 14. Подпроекты и порядок

| Подпроект | Что | План | Зависит от |
|---|---|---|---|
| **A whatif** (сделано) | `lib/exec-graph.mjs`, `lib/exec-whatif.mjs`, `turbo-run exec-whatif`, тесты, docs | — (эта ветка, `628c8cc`) | — |
| **E1 engine** | `lib/exec-state.mjs`, `lib/exec-merge.mjs`, `lib/cli-exec.mjs`, `turbo-run exec`, конфиг, замер, `--release` в `attend` | `docs/plans/2026-10-15-stage-6-e1-engine.md` | A; решение §5 |
| **E2 hooks** | `test-changed --merge`, `questions --stop --keep-running`, `owner-answer` в inbox (пробуждение — только полосы без работающих субагентов) | `docs/plans/2026-10-15-stage-6-e2-hooks.md` | — |
| **E3 skill + view** | раздел **Exec loop** и шаг `execute` в скилле, строка панели | `docs/plans/2026-10-15-stage-6-e3-skill-view.md` | контракты E1/E2 (из этой спеки) |
| **E4 release** | слияние E1–E3, общий прогон, 0.6.0, живая проверка §13, решение о значении по умолчанию | `docs/plans/2026-10-15-stage-6-e4-release.md` | E1, E2, E3 |

E1, E2 и E3 идут параллельно, каждый в своей ветке со своим ревьюером: E1 и E2 общаются только через CLI-контракты
§8 (E1 вызывает `turbo-run test-changed --merge` и `questions … --keep-running` как подпроцессы, в тестах — подделки),
E3 — через текст команд и схему записи §6.8. Общие файлы (конфликты — объединением): `bin/turbo-run.mjs` (`USAGE`;
`attend` — только E1), `lib/cli-phase.mjs` (`PHASE_COMMANDS`/`VALUE_FLAGS`: E1 — `exec`, E2 — `--keep-running`,
`--merge`), `docs/reference.md` (разные разделы), `lib/config.mjs` (только E1).

## 15. Вне рамок

- Общий для всех полос лимит исполнителей (семафор у супервизора) — после живой проверки §13 п.6.
- Граф для доработок (gap rounds) — D8.
- Изоляция `orchestrator-worktree`/`none`, другие рантаймы — D9.
- Перестройка графа по ходу (план, переписанный исполнителем, меняет рёбра) — только пересборка по `graphSha`.
- Раннее планирование следующей фазы, пока идёт исполнение текущей, — отдельная идея.
