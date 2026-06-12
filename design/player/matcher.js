// GEOHOD QUEST — общая функция проверки ответа.
// ОДНА и та же реализация используется в плеере (submit) и в конструкторе
// («Тест ответа») — контракт из PLAN/SPEC: client match == ctor match.
window.isAnswerCorrect = function isAnswerCorrect(submitted, acceptable) {
  const norm = (s) => String(s).trim().toLowerCase();
  if (!submitted || !String(submitted).trim()) return false;
  return (acceptable || []).some((a) => norm(a) === norm(submitted));
};
