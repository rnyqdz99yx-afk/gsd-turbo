import { clean } from './view.mjs';

// The owner's notifications (desktop and Telegram), in the config's language, in the turbo-view pane's plain words
// (mod/hooks/view-model.mjs): `Phase 32 done`, `Phase 32 stopped — needs your answer`, `Phase 32 stopped by a failure`.
// A session id shows only inside the command that needs it (claude attach <id>); commands, paths and the owner's or the
// plan's text stay as written. Each text is a string with {name} holes, or a function of the variables in words (v).
const M = {
  en: {
    // a reason (no question card says it): the title frames it, the body is the reason itself
    laneNeedsOwner: [(v) => (v('reason') ? `Phase ${v('phase')} waits for you` : `Phase ${v('phase')} stopped — needs your answer`), (v) => [v('reason') && `${v('reason')}.`, 'Details: /turbo-autonomous status'].filter(Boolean).join(' ')],
    // what turbo did before telling the owner: it woke the silent session, and no answer came
    laneStalled: ['Phase {phase} is silent — waking it did not help', 'Its session has written nothing for {minutes} min; turbo woke it, attempts: {wakes}, and no answer came. To look inside: claude attach {id}. To restart the phase: /turbo-autonomous resume {phase}'],
    questionsReady: ['Phase {phase}: needs your answer ({n})', (v) => `${sentence(v('list'))} To answer: /turbo-autonomous answer`],
    laneDowngraded: ['Phase {phase} waits: its final checks need full mode', "GSD marked phase {phase} complete before turbo ran its quality checks and acceptance, and doctor now reports safe mode, which cannot run them. Fix what {turboRun} doctor reports, then run: /turbo-autonomous resume {phase}. Or run turbo-phase's steps restore, fanout, fix, final-gate and uat yourself, then: {turboRun} lane-status {phase} done"],
    ownerChecklist: ['Phase {phase}: a checklist for you', '{n} check(s) on the live system to do when convenient; the phase goes on meanwhile. The list: {file}'],
    laneBlocked: ['Phase {phase} is waiting for input', 'Its background session waits for your input. Open it: claude attach {id}'],
    laneHalted: ['Phase {phase} stopped — no progress', 'Restarts without progress: {restarts}; the supervisor stopped. Log: {log}. To try again: /turbo-autonomous resume {phase}'],
    laneFailed: ['Phase {phase} stopped by a failure', 'Its session failed; the supervisor stopped. To look inside: claude attach {id}. To try again: /turbo-autonomous resume {phase}'],
    launchHalted: ['Phase {phase} could not start', 'Its background session failed to start several times in a row; the supervisor stopped. Error: {error}. Fix the cause, then run: /turbo-autonomous resume {phase}'],
    phaseMissing: ['Phase {phase} is no longer in the roadmap', 'Its session has ended; the supervisor stopped. Check ROADMAP.md, then go on with the next phase: /turbo-autonomous resume {phase}'],
    workspaceUntrusted: ['Phase {phase} cannot start: the folder is not trusted', 'Claude Code does not trust {dir} yet. Run claude there once and accept the trust prompt, then run: /turbo-autonomous resume {phase}'],
    noReadyPhase: ['No phase can start', 'The unfinished phases {phases} all wait on each other in a loop. Fix their dependencies in ROADMAP.md; the supervisor keeps checking. Status: /turbo-autonomous status'],
    phaseDone: ['Phase {phase} done', 'Moving on to the next phase.'],
    milestoneDone: ['All phases done', 'The milestone is complete; the supervisor finished.'],
    // reconcile R10: the end of start --plan-only
    milestonePrepared: ['Milestone prepared', 'Every prep and lane markup job that was due is done; no phase ran. Start the run with /turbo-autonomous.'],
    rangeDone: ['Phases {range} done', 'Every phase of this run is done; the supervisor finished.'],
    rangeBlocked: ['Phases {range} are waiting', 'Phase {phase} depends on phase {dep}, which is outside this run and not finished; the supervisor stopped. Run phase {dep} first (/turbo-autonomous --only {dep}) or widen the run (--from, --to or --all).'],
    supervisorFailing: ['The supervisor cannot go on', 'Error: {error}. Check: /turbo-autonomous status'],
    // lib/watchdog.mjs: a supervisor that died without a word (reboot: '1' when the machine restarted since; start: the
    // command that starts the run as it was, /turbo-autonomous or /turbo-plan-milestone)
    supervisorDown: ['The supervisor stopped', (v) => `The supervisor of ${v('project')} has not run since ${v('since')}${v('reboot') ? ': the machine restarted' : ' and left no exit line: its process ended or hung'}. Until it runs again no phase starts, nothing is pushed and your answers wait. To start it again: ${v('start')} in ${v('project')}. Log: .planning/turbo/logs/supervisor.log`],
    pushDiverged: ['Phase {phase}: push skipped — the remote has new commits', '{remote}/{branch} has commits that are not in this checkout, so nothing was pushed. Merge them by hand while the phase is not committing; turbo pushes again at the next request.'],
    pushRefused: ['Phase {phase}: push refused', 'The commits to push contain {findings}. Nothing was pushed. Check those files. A false alarm in text: see its lines with turbo-run push-allow {phase}, then allow exactly those with turbo-run push-allow {phase} {refusal}, and turbo pushes at its next check. Otherwise, once they are clean, push once by hand (git push {remote} {branch}) and turbo pushes again from there.'],
    pushAllowed: ['Phase {phase}: false alarms allowed', '{count} lines of the last refused push were allowed; the supervisor scans that push again.'],
    pushFailed: ['Phase {phase}: push failed', 'Error: {error}. Nothing was pushed; turbo tries again at the next request. Log: .planning/turbo/logs/supervisor.log'],
    ciRed: ['CI red: phase {phase}', 'CI failed on commit {sha}: {runs}. The phase fixes it itself (at most {rounds} rounds).'],
    ciTimeout: ['Phase {phase}: CI did not finish', 'CI on commit {sha} did not finish within {minutes} min{error}. The phase goes on; check the runs: gh run list{repo} --commit {commit}'],
    ciUnavailable: ['Phase {phase}: CI not watched', '{reason}. turbo goes on pushing without CI results until this is fixed.'],
    mergeWaiting: ['Phase {phase} waits to be merged', 'The main checkout is not ready: {why}. turbo merges phase {phase} once it is clean and on its branch; the other phases go on.'],
    gateWait: ['Phase {phase} waits for {gate}', 'Phase {holder} holds the shared resource {gate}; phase {phase} waited {minutes} min for it. Its lane tries once more, then asks you. To free it by hand: turbo-run unlock {gate} {holder}'],
    laneStopped: [(v) => `Phase ${v('phase')} stopped: ${v('why')}`, (v) => [v('error') && `Error: ${v('error')}.`, 'The other lanes go on.', `To look inside: cd "${v('slot')}" && claude.`, `To try again: /turbo-autonomous resume ${v('phase')}`].filter(Boolean).join(' ')],
    slotUntrusted: ['Lane slot {k} is not trusted yet', '{line}. Phases wait for a trusted slot meanwhile.'],
    slotRefused: ['Lane slot {k} cannot be used', '{why}. Nothing in it was changed; turbo tries it again in {minutes} min and uses the other slots meanwhile.'],
    // v0.4.0: turbo answered a safe question itself after owner.auto_answer_minutes
    autoAnswered: ['Accepted automatically while you were away', (v) => `${v('question')} → ${v('option')}. Undo: ${v('undo')}`],
  },
  ru: {
    laneNeedsOwner: [(v) => (v('reason') ? `Фаза ${v('phase')} ждёт вас` : `Фаза ${v('phase')} остановилась — нужен ваш ответ`), (v) => [v('reason') && `${v('reason')}.`, 'Подробности: /turbo-autonomous status'].filter(Boolean).join(' ')],
    laneStalled: ['Фаза {phase} молчит — разбудить не вышло', 'Её сессия ничего не пишет уже {minutes} мин; turbo будил её, попыток: {wakes}, ответа нет. Посмотреть: claude attach {id}. Перезапустить фазу: /turbo-autonomous resume {phase}'],
    questionsReady: ['Фаза {phase}: нужен ваш ответ ({n})', (v) => `${sentence(v('list'))} Ответить: /turbo-autonomous answer`],
    laneDowngraded: ['Фаза {phase} ждёт: для финальных проверок нужен полный режим', 'GSD отметил фазу {phase} завершённой раньше, чем turbo провёл проверки качества и приёмку, а doctor теперь сообщает о безопасном режиме, в котором их не провести. Исправьте то, что показывает {turboRun} doctor, и запустите: /turbo-autonomous resume {phase}. Или выполните сами шаги turbo-phase restore, fanout, fix, final-gate и uat, затем: {turboRun} lane-status {phase} done'],
    ownerChecklist: ['Фаза {phase}: чек-лист для вас', 'Проверок на живой системе: {n} — сделайте, когда будет удобно; фаза тем временем идёт дальше. Список: {file}'],
    laneBlocked: ['Фаза {phase} ждёт ввода', 'Её фоновая сессия ждёт вашего ввода. Открыть: claude attach {id}'],
    laneHalted: ['Фаза {phase} остановилась — нет продвижения', 'Перезапусков без продвижения: {restarts}; супервизор остановился. Лог: {log}. Попробовать снова: /turbo-autonomous resume {phase}'],
    laneFailed: ['Фаза {phase} остановилась из-за сбоя', 'Её сессия завершилась сбоем; супервизор остановился. Посмотреть: claude attach {id}. Попробовать снова: /turbo-autonomous resume {phase}'],
    launchHalted: ['Фаза {phase} не запускается', 'Её фоновая сессия несколько раз подряд не запустилась; супервизор остановился. Ошибка: {error}. Устраните причину и запустите: /turbo-autonomous resume {phase}'],
    phaseMissing: ['Фазы {phase} больше нет в ROADMAP.md', 'Её сессия завершилась; супервизор остановился. Проверьте ROADMAP.md и продолжите со следующей фазы: /turbo-autonomous resume {phase}'],
    workspaceUntrusted: ['Фаза {phase} не запускается: папке нет доверия', 'Claude Code пока не доверяет папке {dir}. Запустите там claude один раз и подтвердите доверие, затем: /turbo-autonomous resume {phase}'],
    noReadyPhase: ['Ни одна фаза не может начаться', 'Незавершённые фазы {phases} ждут друг друга по кругу. Исправьте их зависимости в ROADMAP.md; супервизор продолжает проверять. Состояние: /turbo-autonomous status'],
    phaseDone: ['Фаза {phase} готова', 'Перехожу к следующей фазе.'],
    milestoneDone: ['Все фазы готовы', 'Этап завершён; супервизор закончил работу.'],
    milestonePrepared: ['Майлстоун подготовлен', 'Все нужные подготовки фаз и разметка полос сделаны; ни одна фаза не запускалась. Запустите работу: /turbo-autonomous.'],
    rangeDone: ['Фазы {range} готовы', 'Все фазы этого прогона готовы; супервизор закончил работу.'],
    rangeBlocked: ['Фазы {range} ждут', 'Фаза {phase} зависит от фазы {dep}, которая не входит в этот прогон и не завершена; супервизор остановился. Сначала выполните фазу {dep} (/turbo-autonomous --only {dep}) или расширьте прогон (--from, --to или --all).'],
    supervisorFailing: ['Супервизор не может продолжить', 'Ошибка: {error}. Проверьте: /turbo-autonomous status'],
    supervisorDown: ['Супервизор остановился', (v) => `Супервизор проекта ${v('project')} не работает с ${v('since')}${v('reboot') ? ': компьютер перезагрузился' : ' и не оставил строки о выходе: его процесс завершился или завис'}. Пока он не запущен, фазы не начинаются, ничего не отправляется, а ваши ответы ждут. Запустить снова: ${v('start')} в проекте ${v('project')}. Лог: .planning/turbo/logs/supervisor.log`],
    pushDiverged: ['Фаза {phase}: отправка пропущена — в удалённом репозитории новые коммиты', 'В {remote}/{branch} есть коммиты, которых нет в этой рабочей копии, поэтому ничего не отправлено. Слейте их вручную, пока фаза не делает коммитов; turbo отправит снова при следующем запросе.'],
    pushRefused: ['Фаза {phase}: отправка отклонена', 'В коммитах на отправку найдено: {findings}. Ничего не отправлено. Проверьте эти файлы. Если находка в тексте ложная: посмотрите её строки командой turbo-run push-allow {phase}, затем разрешите именно их командой turbo-run push-allow {phase} {refusal}, и turbo отправит при следующей проверке. Иначе, когда файлы чистые, отправьте один раз вручную (git push {remote} {branch}), дальше turbo отправляет сам.'],
    pushAllowed: ['Фаза {phase}: ложные находки разрешены', 'Разрешено строк последней отклонённой отправки: {count}; супервизор проверит эту отправку заново.'],
    pushFailed: ['Фаза {phase}: отправка не удалась', 'Ошибка: {error}. Ничего не отправлено; turbo попробует снова при следующем запросе. Лог: .planning/turbo/logs/supervisor.log'],
    ciRed: ['CI красный: фаза {phase}', 'CI упал на коммите {sha}: {runs}. Фаза исправит это сама (не больше {rounds} попыток).'],
    ciTimeout: ['Фаза {phase}: CI не завершился', 'CI на коммите {sha} не завершился за {minutes} мин{error}. Фаза идёт дальше; проверьте прогоны: gh run list{repo} --commit {commit}'],
    ciUnavailable: ['Фаза {phase}: CI не отслеживается', '{reason}. turbo продолжает отправлять без результатов CI, пока это не исправлено.'],
    mergeWaiting: ['Фаза {phase} ждёт слияния', 'Основная рабочая копия не готова: {why}. turbo вольёт фазу {phase}, когда копия будет чистой и на своей ветке; остальные фазы идут дальше.'],
    gateWait: ['Фаза {phase} ждёт {gate}', 'Общий ресурс {gate} занят фазой {holder}; фаза {phase} ждала его {minutes} мин. Её полоса попробует ещё раз, затем спросит вас. Освободить вручную: turbo-run unlock {gate} {holder}'],
    laneStopped: [(v) => `Фаза ${v('phase')} остановлена: ${v('why')}`, (v) => [v('error') && `Ошибка: ${v('error')}.`, 'Остальные полосы продолжают работу.', `Посмотреть: cd "${v('slot')}" && claude.`, `Попробовать снова: /turbo-autonomous resume ${v('phase')}`].filter(Boolean).join(' ')],
    slotUntrusted: ['Слоту полосы {k} пока нет доверия', '{line}. Пока его нет, фазы ждут доверенный слот.'],
    slotRefused: ['Слот полосы {k} нельзя использовать', '{why}. В нём ничего не изменено; turbo попробует снова через {minutes} мин, а пока использует другие слоты.'],
    autoAnswered: ['Принято автоматически, пока вас не было', (v) => `${v('question')} → ${v('option')}. Отменить: ${v('undo')}`],
  },
};

// The words for what other modules pass in English or as turbo's ids, per language: the supervisor's own needs-owner
// reasons, owner-tick's question headers, push's gh error.
const W = {
  en: {
    plan: (plan, task) => `plan ${plan}, task ${task}`,
    markup: 'Lane markup',
    humanCheck: 'it needs your manual check',
    undelivered: (why) => `your answers did not reach the phase's session (${why})`,
    ghError: '; last gh error: ',
    stopWhy: { failed: 'its session failed', noProgress: 'no progress after restarts', launch: 'its session could not start', missing: 'it is no longer in the roadmap', untrusted: 'its slot is not trusted (open claude there once and accept the trust dialog)' },
  },
  ru: {
    plan: (plan, task) => `план ${plan}, задача ${task}`,
    markup: 'Разметка полос',
    humanCheck: 'нужна ваша ручная проверка',
    undelivered: (why) => `ваши ответы не дошли до сессии фазы (${why})`,
    ghError: '; последняя ошибка gh: ',
    stopWhy: { failed: 'её сессия завершилась сбоем', noProgress: 'нет продвижения после перезапусков', launch: 'её сессия не запускается', missing: 'её больше нет в ROADMAP.md', untrusted: 'слоту нет доверия (откройте там claude один раз и подтвердите доверие)' },
  },
};

// A text ends in a full stop unless it ends in one already (a question listed last ends in ?).
const sentence = (s) => (/[.?!…]$/.test(s) ? s : `${s}.`);

// A lane's needs-owner reason in words. /turbo-phase stops for a question with `owner question <plan>-t<n>`, turbo-run
// ask with `owner question ask-<k>` (v0.3.3; its plain question goes out as questionsReady): the title
// says a question waits, so that goes (the pane's laneReason) and what follows it stays. The supervisor's own reasons
// (lib/supervisor.mjs) in words, without the question and session ids; any other reason is the lane's, as written.
function reasonWords(w, reason) {
  const s = reason.replace(/^owner questions?\s+(?:[\w.-]+-t\d+|ask-\d+)\b\s*:?\s*/i, '').trim().replace(/\.+$/, '');
  if (s === 'human verification') return w.humanCheck;
  const lost = /^the answers to .+ did not reach session \S+ \((.*)\)$/.exec(s);
  return lost ? w.undelivered(lost[1]) : s;
}

// owner-tick's list `<plan> T<task>: <question>; …` with the plan and task in words
const listWords = (w, list) => list.replace(/(^|; )([\w.-]+) T(\d+): /g, (_, at, plan, task) => `${at}${w.plan(plan, task)}: `);

const PREPARE = {
  laneNeedsOwner: { reason: reasonWords },
  questionsReady: { list: listWords },
  laneStopped: { why: (w, why) => w.stopWhy?.[why] ?? why },
  ciTimeout: { error: (w, error) => (error.startsWith(W.en.ghError) ? `${w.ghError}${error.slice(W.en.ghError.length)}` : error) },
};

export function msg(lang, key, vars = {}) {
  const table = Object.hasOwn(M, lang) ? M[lang] : M.en;
  const pair = Object.hasOwn(table, key) ? table[key] : Object.hasOwn(M.en, key) ? M.en[key] : null;
  if (!pair) return { title: String(key), body: '' };
  const w = Object.hasOwn(table, key) && Object.hasOwn(W, lang) ? W[lang] : W.en;
  const prepare = Object.hasOwn(PREPARE, key) ? PREPARE[key] : {};
  // every variable cleaned (terminal escapes, controls, bidi overrides): a reason or an error is the repository's text
  const v = (k) => {
    const s = clean(String(vars?.[k] ?? ''));
    return Object.hasOwn(prepare, k) ? prepare[k](w, s) : s;
  };
  const fill = (t) => (typeof t === 'function' ? t(v) : t.replace(/\{(\w+)\}/g, (_, k) => v(k)));
  const [t, b] = pair;
  // reconcile R12: the annotate pseudo-phase (its job's questions and needs) is the lane markup, never «phase annotate»
  const title = String(vars?.phase ?? '') === 'annotate' ? fill(t).replace(/^(?:Phase|Фаза) annotate\b/, w.markup) : fill(t);
  return { title, body: fill(b) };
}
