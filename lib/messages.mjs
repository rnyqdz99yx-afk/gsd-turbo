const M = {
  en: {
    laneNeedsOwner: ['Phase {phase} needs you', '{reason}. Everything else in the phase is done. Run: /turbo-autonomous status'],
    laneBlocked: ['Phase {phase} is waiting for input', 'A background session is waiting. Open it: claude attach {id}'],
    laneHalted: ['Phase {phase} stopped', 'No progress after {restarts} restarts. Log: {log}'],
    laneFailed: ['Phase {phase} failed', 'The session failed. Open it: claude attach {id}'],
    phaseDone: ['Phase {phase} done', 'Moving on to the next phase.'],
    milestoneDone: ['Milestone complete', 'All phases are done.'],
  },
  ru: {
    laneNeedsOwner: ['Фаза {phase}: нужен ты', '{reason}. Остальное в фазе сделано. Подробности: /turbo-autonomous status'],
    laneBlocked: ['Фаза {phase} ждёт ответа', 'Фоновая сессия ждёт ввода. Открыть: claude attach {id}'],
    laneHalted: ['Фаза {phase} остановлена', 'Нет прогресса после {restarts} перезапусков. Лог: {log}'],
    laneFailed: ['Фаза {phase}: сбой', 'Сессия упала. Открыть: claude attach {id}'],
    phaseDone: ['Фаза {phase} готова', 'Перехожу к следующей фазе.'],
    milestoneDone: ['Майлстоун готов', 'Все фазы выполнены.'],
  },
};

export function msg(lang, key, vars = {}) {
  const table = M[lang] || M.en;
  const pair = table[key] || M.en[key];
  if (!pair) return { title: String(key), body: '' };
  const [t, b] = pair;
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  return { title: fill(t), body: fill(b) };
}
