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
    rangeBlocked: ['Phases {range} are waiting', 'Phase {phase} depends on phase {dep}, which lies outside the range and is not finished; the supervisor stopped. Run phase {dep} first (/turbo-autonomous --only {dep}) or widen the range (--from, --to or --all).'],
    supervisorFailing: ['gsd-turbo cannot make progress', '{error}. Check: /turbo-autonomous status'],
    pushDiverged: ['Phase {phase}: push skipped, the remote moved', '{remote}/{branch} has commits that are not in this checkout, so nothing was pushed. Merge them by hand while the lane is not committing; turbo pushes again at the next request.'],
    pushRefused: ['Phase {phase}: push refused', 'The commits to push contain {findings}. Nothing was pushed. Check those files; if they are clean, push once by hand (git push {remote} {branch}) and turbo pushes again from there.'],
    pushFailed: ['Phase {phase}: push failed', '{error}. Nothing was pushed; turbo tries again at the next request. Log: .planning/turbo/logs/supervisor.log'],
    ciRed: ['Phase {phase}: CI red', 'CI failed on {sha}: {runs}. The lane fixes it itself (at most {rounds} rounds).'],
    ciTimeout: ['Phase {phase}: CI did not finish', 'CI on {sha} did not finish within {minutes} min{error}. The lane goes on; check the runs: gh run list{repo} --commit {commit}'],
    ciUnavailable: ['Phase {phase}: CI not watched', '{reason}. turbo goes on pushing without CI results until this is fixed.'],
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
    rangeBlocked: ['Фазы {range} ждут', 'Фаза {phase} зависит от фазы {dep} вне диапазона, она не завершена; супервизор остановлен. Сначала выполни фазу {dep} (/turbo-autonomous --only {dep}) или расширь диапазон (--from, --to или --all).'],
    supervisorFailing: ['gsd-turbo не может продолжить', '{error}. Проверь: /turbo-autonomous status'],
    pushDiverged: ['Фаза {phase}: пуш пропущен, remote ушёл вперёд', 'В {remote}/{branch} есть коммиты, которых нет в этом checkout, поэтому ничего не отправлено. Слей их вручную, пока лейн не коммитит; turbo отправит снова при следующем запросе.'],
    pushRefused: ['Фаза {phase}: пуш отклонён', 'В отправляемых коммитах найдено: {findings}. Ничего не отправлено. Проверь эти файлы; если они чистые, отправь один раз вручную (git push {remote} {branch}), дальше turbo отправляет сам.'],
    pushFailed: ['Фаза {phase}: пуш не удался', '{error}. Ничего не отправлено; turbo попробует снова при следующем запросе. Лог: .planning/turbo/logs/supervisor.log'],
    ciRed: ['Фаза {phase}: CI красный', 'CI упал на {sha}: {runs}. Лейн чинит сам (не больше {rounds} раундов).'],
    ciTimeout: ['Фаза {phase}: CI не завершился', 'CI на {sha} не завершился за {minutes} мин{error}. Лейн идёт дальше; проверь прогоны: gh run list{repo} --commit {commit}'],
    ciUnavailable: ['Фаза {phase}: CI не отслеживается', '{reason}. turbo продолжает пушить без результатов CI, пока это не исправлено.'],
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
