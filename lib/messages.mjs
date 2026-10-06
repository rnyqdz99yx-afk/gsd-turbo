const M = {
  en: {
    laneNeedsOwner: ['Phase {phase} needs you', '{reason}. Everything else in the phase is done. Run: /turbo-autonomous status'],
    laneBlocked: ['Phase {phase} is waiting for input', 'A background session is waiting. Open it: claude attach {id}'],
    laneHalted: ['Phase {phase} stopped', 'No progress after {restarts} restarts. Log: {log}'],
    laneFailed: ['Phase {phase} failed', 'The session failed. Open it: claude attach {id}'],
    launchHalted: ['Phase {phase} could not start', 'The background session did not start in repeated attempts, so the supervisor stopped: {error}. Fix the cause, then run: /turbo-autonomous resume {phase}'],
    phaseDone: ['Phase {phase} done', 'Moving on to the next phase.'],
    milestoneDone: ['Milestone complete', 'All phases are done.'],
    supervisorFailing: ['gsd-turbo cannot make progress', '{error}. Check: /turbo-autonomous status'],
  },
  ru: {
    laneNeedsOwner: ['Фаза {phase}: нужен ты', '{reason}. Остальное в фазе сделано. Подробности: /turbo-autonomous status'],
    laneBlocked: ['Фаза {phase} ждёт ответа', 'Фоновая сессия ждёт ввода. Открыть: claude attach {id}'],
    laneHalted: ['Фаза {phase} остановлена', 'Нет прогресса после {restarts} перезапусков. Лог: {log}'],
    laneFailed: ['Фаза {phase}: сбой', 'Сессия упала. Открыть: claude attach {id}'],
    launchHalted: ['Фаза {phase} не запускается', 'Фоновая сессия не стартовала после нескольких попыток, супервизор остановлен: {error}. Устрани причину и запусти: /turbo-autonomous resume {phase}'],
    phaseDone: ['Фаза {phase} готова', 'Перехожу к следующей фазе.'],
    milestoneDone: ['Майлстоун готов', 'Все фазы выполнены.'],
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
