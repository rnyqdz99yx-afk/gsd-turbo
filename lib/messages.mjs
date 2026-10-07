const M = {
  en: {
    laneNeedsOwner: ['Phase {phase} needs you', '{reason}. Run: /turbo-autonomous status'],
    laneDowngraded: ['Phase {phase} waits for full mode', "GSD marked phase {phase} complete before turbo-phase ran its gate fan-out and UAT, and doctor now reports safe mode, which cannot run them. Fix what {turboRun} doctor reports, then run: /turbo-autonomous resume {phase}. Or run turbo-phase's steps restore, fanout, fix, final-gate and uat yourself, then: {turboRun} lane-status {phase} done"],
    ownerChecklist: ['Phase {phase}: a checklist for you', '{n} live check(s) to do when convenient; the phase goes on. See {file}'],
    laneBlocked: ['Phase {phase} is waiting for input', 'A background session is waiting. Open it: claude attach {id}'],
    laneHalted: ['Phase {phase} stopped', 'No progress after {restarts} restarts. Log: {log}. To retry: /turbo-autonomous resume {phase}'],
    laneFailed: ['Phase {phase} failed', 'The session failed. Open it: claude attach {id}. To retry: /turbo-autonomous resume {phase}'],
    launchHalted: ['Phase {phase} could not start', 'The background session did not start in repeated attempts, so the supervisor stopped: {error}. Fix the cause, then run: /turbo-autonomous resume {phase}'],
    phaseMissing: ['Phase {phase} is no longer in the roadmap', 'Its session {id} has ended, so the supervisor stopped. Check the roadmap, then continue with the next phase: /turbo-autonomous resume {phase}'],
    workspaceUntrusted: ['Phase {phase} cannot start: folder not trusted', 'Claude Code does not trust {dir} yet. Run claude there once and accept the trust prompt, then run: /turbo-autonomous resume {phase}'],
    noReadyPhase: ['No phase can start', 'The unfinished phases {phases} all wait on each other (a dependency cycle). Fix their dependencies in the roadmap; the supervisor keeps checking. Status: /turbo-autonomous status'],
    phaseDone: ['Phase {phase} done', 'Moving on to the next phase.'],
    milestoneDone: ['Milestone complete', 'All phases are done.'],
    rangeDone: ['Phases {range} done', 'The range is complete; the supervisor stopped.'],
    supervisorFailing: ['gsd-turbo cannot make progress', '{error}. Check: /turbo-autonomous status'],
  },
  ru: {
    laneNeedsOwner: ['Фаза {phase}: нужен ты', '{reason}. Подробности: /turbo-autonomous status'],
    laneDowngraded: ['Фаза {phase} ждёт полного режима', 'GSD отметил фазу {phase} завершённой раньше, чем turbo-phase прогнал fan-out гейтов и UAT, а doctor теперь сообщает safe mode, в котором их не прогнать. Исправь то, что показывает {turboRun} doctor, и запусти: /turbo-autonomous resume {phase}. Или выполни сам шаги turbo-phase restore, fanout, fix, final-gate и uat, затем: {turboRun} lane-status {phase} done'],
    ownerChecklist: ['Фаза {phase}: чек-лист для тебя', 'Живых проверок: {n}, сделай когда удобно; фаза идёт дальше. Подробности: {file}'],
    laneBlocked: ['Фаза {phase} ждёт ответа', 'Фоновая сессия ждёт ввода. Открыть: claude attach {id}'],
    laneHalted: ['Фаза {phase} остановлена', 'Нет прогресса после {restarts} перезапусков. Лог: {log}. Повторить: /turbo-autonomous resume {phase}'],
    laneFailed: ['Фаза {phase}: сбой', 'Сессия упала. Открыть: claude attach {id}. Повторить: /turbo-autonomous resume {phase}'],
    launchHalted: ['Фаза {phase} не запускается', 'Фоновая сессия не стартовала после нескольких попыток, супервизор остановлен: {error}. Устрани причину и запусти: /turbo-autonomous resume {phase}'],
    phaseMissing: ['Фазы {phase} больше нет в роадмапе', 'Её сессия {id} завершилась, супервизор остановлен. Проверь роадмап и продолжи со следующей фазы: /turbo-autonomous resume {phase}'],
    workspaceUntrusted: ['Фаза {phase} не запускается: папке нет доверия', 'Claude Code пока не доверяет папке {dir}. Запусти там claude один раз и подтверди доверие, затем: /turbo-autonomous resume {phase}'],
    noReadyPhase: ['Ни одна фаза не может стартовать', 'Незавершённые фазы {phases} ждут друг друга (цикл зависимостей). Исправь их зависимости в роадмапе; супервизор продолжает проверять. Статус: /turbo-autonomous status'],
    phaseDone: ['Фаза {phase} готова', 'Перехожу к следующей фазе.'],
    milestoneDone: ['Майлстоун готов', 'Все фазы выполнены.'],
    rangeDone: ['Фазы {range} готовы', 'Диапазон выполнен; супервизор остановлен.'],
    supervisorFailing: ['gsd-turbo не может продолжить', '{error}. Проверь: /turbo-autonomous status'],
  },
};

export function msg(lang, key, vars = {}) {
  const table = Object.hasOwn(M, lang) ? M[lang] : M.en;
  const pair = Object.hasOwn(table, key) ? table[key] : Object.hasOwn(M.en, key) ? M.en[key] : null;
  if (!pair) return { title: String(key), body: '' };
  const [t, b] = pair;
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  return { title: fill(t), body: fill(b) };
}
