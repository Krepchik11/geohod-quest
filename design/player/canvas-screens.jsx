// GEOHOD QUEST — статичные экраны для канваса (фиксированные состояния).
// Использует window.QUEST_DEMO, UI_COPY и компоненты из components.jsx.

const QD = () => window.QUEST_DEMO;
const copyOf = (tw) => window.UI_COPY[tw.tone];
// Статичные артборды всегда без entrance-анимаций: видимость контента
// не должна зависеть от проигрывания анимации (твик «Анимации» остаётся для прототипа).
const staticTw = (tw) => ({ ...tw, anims: false });

function stepAt(idx) { return QD().steps[idx]; }

/* Базовый снимок шага: рамка + топбар + шаг (+ оверлей) */
function Shot({ tw, idx, coins = 8, st, overlay, label, noTop }) {
  const quest = QD();
  const step = stepAt(idx);
  const copy = copyOf(tw);
  return (
    <PlayerFrame tw={staticTw(tw)} screenLabel={label || step.name}>
      {noTop ? null : <TopBar pos={idx + 1} total={quest.steps.length} coins={coins}></TopBar>}
      <StepView step={step} quest={quest} copy={copy} st={st}></StepView>
      {overlay ? overlay(copy, quest) : null}
    </PlayerFrame>
  );
}

/* --- Секция 1: семь шаблонов --- */
function BoardStart({ tw })      { return <Shot tw={tw} idx={0} coins={0} noTop={true} label="Шаблон: Первый экран"></Shot>; }
function BoardVideo({ tw })      { return <Shot tw={tw} idx={1} coins={0} label="Шаблон: Приветственное видео"></Shot>; }
function BoardTaskNo({ tw })     { return <Shot tw={tw} idx={3} coins={3} label="Шаблон: Задание без ответа"></Shot>; }
function BoardTaskAnswer({ tw }) { return <Shot tw={tw} idx={4} coins={3} label="Шаблон: Задание с ответом"></Shot>; }
function BoardContinue({ tw })   { return <Shot tw={tw} idx={2} coins={0} label="Шаблон: Продолжить"></Shot>; }
function BoardRouteVideo({ tw }) { return <Shot tw={tw} idx={5} coins={8} label="Шаблон: Видео маршрута"></Shot>; }
function BoardCongrats({ tw }) {
  const quest = QD(); const copy = copyOf(tw);
  return (
    <PlayerFrame tw={staticTw(tw)} screenLabel="Шаблон: Поздравление">
      <TopBar pos={8} total={quest.steps.length} coins={13}></TopBar>
      <FinalB step={stepAt(7)} quest={quest} copy={copy}></FinalB>
    </PlayerFrame>
  );
}

/* --- Секция 2: состояния и оверлеи --- */
function BoardWrong({ tw }) {
  return <Shot tw={tw} idx={4} coins={3} st={{ wrong: true, answer: "1750" }} label="Состояние: неверный ответ (1-я попытка)"></Shot>;
}
function BoardHintOffer({ tw }) {
  return (
    <Shot tw={tw} idx={4} coins={8} st={{ answer: "1690" }} label="Попап: обмен монет на подсказку (со 2-й ошибки)"
      overlay={(copy) => <HintPopup step={stepAt(4)} balance={8} copy={copy}></HintPopup>}></Shot>
  );
}
function BoardHintRevealed({ tw }) {
  return <Shot tw={tw} idx={4} coins={3} st={{ hintRevealed: true }} label="Состояние: подсказка раскрыта"></Shot>;
}
function BoardToast({ tw }) {
  const step = stepAt(3);
  return (
    <Shot tw={tw} idx={3} coins={6} label="Тост: начисление монет (анимировано + озвучено)"
      overlay={(copy) => <CoinToast amount={step.gift.coins} narrative={step.gift.narrative} copy={copy}></CoinToast>}></Shot>
  );
}
function BoardMenu({ tw }) {
  const quest = QD(); const copy = copyOf(tw);
  return (
    <PlayerFrame tw={staticTw(tw)} screenLabel="Меню квеста (с любой страницы)">
      <MenuOverlay quest={quest} copy={copy} st={{ pos: 5, total: quest.steps.length, coins: 8, sound: true, online: true }}></MenuOverlay>
    </PlayerFrame>
  );
}
function BoardFeedback({ tw }) {
  return (
    <Shot tw={tw} idx={4} coins={8} label="Оставить отзыв: репорт ошибки с контекстом шага"
      overlay={(copy, quest) => <FeedbackSheet quest={quest} copy={copy} st={{ pos: 5, stepName: stepAt(4).name }}></FeedbackSheet>}></Shot>
  );
}
function BoardOffline({ tw }) {
  return (
    <Shot tw={tw} idx={3} coins={3} label="Офлайн: баннер + локальное сохранение фактов"
      overlay={(copy) => <SyncBar copy={copy}></SyncBar>}></Shot>
  );
}

/* --- Секция 3: финал, три варианта --- */
function BoardFinalA({ tw }) {
  const quest = QD(); const copy = copyOf(tw);
  return (
    <PlayerFrame tw={staticTw(tw)} screenLabel="Финал A: сдержанный">
      <TopBar pos={8} total={quest.steps.length} coins={13}></TopBar>
      <FinalA step={stepAt(7)} quest={quest} copy={copy}></FinalA>
      <CoinToast amount={5} narrative="Бонус за прохождение" copy={copy}></CoinToast>
    </PlayerFrame>
  );
}
function BoardFinalB({ tw }) {
  const quest = QD(); const copy = copyOf(tw);
  return (
    <PlayerFrame tw={staticTw(tw)} screenLabel="Финал B: итоги + оценка">
      <TopBar pos={8} total={quest.steps.length} coins={13}></TopBar>
      <FinalB step={stepAt(7)} quest={quest} copy={copy} st={{ rating: 4 }}></FinalB>
    </PlayerFrame>
  );
}
function BoardFinalC({ tw }) {
  const quest = QD(); const copy = copyOf(tw);
  return (
    <PlayerFrame tw={staticTw(tw)} screenLabel="Финал C: конфетти + комментарий">
      <TopBar pos={8} total={quest.steps.length} coins={13}></TopBar>
      <FinalC step={stepAt(7)} quest={quest} copy={copy} st={{ rating: 5 }}></FinalC>
    </PlayerFrame>
  );
}

Object.assign(window, {
  BoardStart, BoardVideo, BoardTaskNo, BoardTaskAnswer, BoardContinue, BoardRouteVideo, BoardCongrats,
  BoardWrong, BoardHintOffer, BoardHintRevealed, BoardToast, BoardMenu, BoardFeedback, BoardOffline,
  BoardFinalA, BoardFinalB, BoardFinalC,
});
