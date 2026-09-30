import type { Metadata } from 'next';
import Link from 'next/link';
import SiteShell from '../components/SiteShell';
import { SUPPORT_TG, SUPPORT_TG_URL } from '../../lib/contacts';
import { GIFT_COINS, HINT_COST_DEFAULT } from '../../lib/constructor-model';
import { COMMENT_BONUS, COMPLETION_BONUS, RATING_BONUS } from '../../lib/play-loop';
import { SKIP_COST_DEFAULT } from '../../lib/shared-model';

export const metadata: Metadata = {
  title: 'Как играть — GEOHOD QUEST',
  description:
    'Как начать городской квест GEOHOD, как проходят задания, за что начисляются монеты и что взять с собой на маршрут.',
};

/** Was §2.4 on the landing. Photos 3–4 are frames from the «Тайна крепости» quest. */
const FEATURES = [
  { img: '/assets/img/feature-smartphone.jpg', alt: 'Смартфон в руке на прогулке', title: 'Все задания — в смартфоне', text: 'Начать и продолжить можно в любое время, число попыток не ограничено.' },
  { img: '/assets/img/feature-group.jpg', alt: 'Компания друзей стоит в кругу на брусчатке', title: 'Любое число участников', text: 'Проходите в одиночку или дружной компанией — вместе веселее.' },
  { img: '/assets/img/feature-clock-tower.jpg', alt: 'Часовая башня Петроварадинской крепости', title: 'Игра со смыслом', text: 'Квест знакомит с городскими легендами и историческими персонажами.' },
  { img: '/assets/img/feature-fortress-gate.jpg', alt: 'Старые кирпичные ворота в крепости', title: 'Маршруты к необычным местам', text: 'Ведём туда, мимо чего проходят даже местные.' },
];

/** Amounts come from the game's own constants, so the table cannot drift from
 *  what the player actually credits. Hint and skip prices are the author's
 *  defaults — the real price is printed on the button in the quest. */
const COINS: { what: string; note?: string; delta: string; minus?: boolean }[] = [
  { what: 'Каждое выполненное задание', delta: `+${GIFT_COINS}` },
  { what: 'Прохождение квеста', note: 'один раз на квест', delta: `+${COMPLETION_BONUS}` },
  { what: 'Оценка квеста в финале', note: 'один раз на квест', delta: `+${RATING_BONUS}` },
  { what: 'Отзыв о квесте', note: 'один раз на квест', delta: `+${COMMENT_BONUS}` },
  { what: 'Подсказка', note: 'обычно', delta: `−${HINT_COST_DEFAULT}`, minus: true },
  { what: 'Пропуск задания', note: 'обычно', delta: `−${SKIP_COST_DEFAULT}`, minus: true },
];

/** Adapted from the old geohod.ru FAQ, corrected to how the platform works now. */
const FAQ: { q: string; a: string }[] = [
  {
    q: 'Что такое квест GEOHOD?',
    a: 'Экскурсионный маршрут в виде игры: загадки объединены общим сюжетом, а по пути вы откроете живописные уголки города и узнаете много удивительных фактов. Играйте в своём темпе, делайте перерывы или переносите игру на другой день, если подвела погода.',
  },
  {
    q: 'Кому подходят квесты?',
    a: 'Семьям с детьми — для совместного досуга; друзьям — для активной прогулки; туристам — чтобы узнать город; всем, кто любит головоломки и приключения.',
  },
  {
    q: 'Насколько это сложно?',
    a: 'Специальных знаний не нужно — хватит внимательности и логики. На задания есть подсказки, а в крайнем случае задание можно пропустить. Играть с подсказками или без — решать вам.',
  },
  {
    q: 'Можно ли играть компанией?',
    a: 'Да, число участников не ограничено. Удобнее всего идти с одним телефоном и обсуждать задания вместе.',
  },
  {
    q: 'Нужна ли регистрация?',
    a: 'Нет. Без аккаунта покупки и прогресс хранятся на устройстве и потеряются при смене телефона или браузера. Аккаунт сохраняет покупки, монеты и прогресс.',
  },
  {
    q: 'Можно ли играть без интернета?',
    a: 'Да, если заранее скачать квест: «Мои квесты» → «Скачать для офлайна». Для покупки интернет нужен.',
  },
];

export default function RulesPage() {
  return (
    <SiteShell>
      <section className="container" style={{ paddingTop: 48 }} data-screen-label="Как играть">
        <h1 className="section-title display">как играть</h1>
        <p style={{ maxWidth: 700, margin: '48px auto 0', textAlign: 'center' }}>
          Квест GEOHOD&nbsp;— это прогулка-экскурсия в&nbsp;формате игры: вы&nbsp;идёте по&nbsp;маршруту,
          следите за&nbsp;сюжетом и&nbsp;решаете задания прямо на&nbsp;улицах города. Всё&nbsp;—
          в&nbsp;смартфоне, гид не&nbsp;нужен.
        </p>
        <div className="features" style={{ marginTop: 48 }}>
          {FEATURES.map((f) => (
            <article className="feature card" key={f.title}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.img} alt={f.alt} width={80} height={80} loading="lazy" />
              <div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="rules">
          <section className="rules__section" id="start">
            <h2 className="display">Как начать</h2>
            <ol className="rules__steps">
              <li>
                Выберите квест в&nbsp;<Link href="/#shop">магазине</Link>{' '}и&nbsp;нажмите «Купить»&nbsp;— или
                «Получить», если он&nbsp;бесплатный. Оплата картой через ЮKassa, промокод вводится в&nbsp;окне
                покупки.
              </li>
              <li>
                Доберитесь до&nbsp;места старта: кнопка «Место старта» на&nbsp;странице квеста откроет
                его на&nbsp;карте.
              </li>
              <li>
                Нажмите «Играть» в&nbsp;карточке квеста или откройте его в&nbsp;«Моих квестах»&nbsp;— и&nbsp;в&nbsp;путь.
              </li>
            </ol>
            <p className="rules__note">
              Регистрация не&nbsp;обязательна: без аккаунта покупки и&nbsp;прогресс хранятся на&nbsp;этом
              устройстве. <Link href="/auth">Войдите</Link>, чтобы не&nbsp;потерять их при смене телефона
              или браузера.
            </p>
          </section>

          <section className="rules__section" id="play">
            <h2 className="display">Как проходит игра</h2>
            <ul className="rules__list">
              <li>Квест&nbsp;— это история из&nbsp;шагов: одни рассказывают сюжет, другие дают задания.</li>
              <li><b>Найти место.</b>{' '}Дойдите до&nbsp;нужной точки и&nbsp;подтвердите, что вы&nbsp;на&nbsp;месте.</li>
              <li>
                <b>Ответить на&nbsp;вопрос.</b>{' '}Ответ&nbsp;— число, слово или фраза. Ищите его вокруг себя
                или решайте логикой.
              </li>
              <li>
                Попыток сколько угодно. После неверного ответа можно попробовать ещё раз, взять подсказку
                или пропустить задание.
              </li>
              <li>Адрес под заданием открывает маршрут в&nbsp;приложении карт.</li>
              <li>
                Время не&nbsp;ограничено: закройте квест в&nbsp;любой момент и&nbsp;продолжите с&nbsp;того же
                места&nbsp;— хоть на&nbsp;следующий день.
              </li>
              <li>Интернет ненадёжный? Скачайте квест заранее в&nbsp;«Моих квестах».</li>
            </ul>
          </section>

          <section className="rules__section" id="coins">
            <h2 className="display">Монеты</h2>
            <p>
              Монеты&nbsp;— игровая валюта GEOHOD QUEST. Они общие для всех квестов; баланс виден в&nbsp;меню
              квеста и&nbsp;в&nbsp;профиле.
            </p>
            <table className="rules__coins">
              <tbody>
                {COINS.map((c) => (
                  <tr key={c.what}>
                    <td>
                      {c.what}
                      {c.note && <span className="rules__coins-note">{c.note}</span>}
                    </td>
                    <td className={c.minus ? 'is-minus' : 'is-plus'}>{c.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="rules__note">
              Цену подсказки и&nbsp;пропуска назначает автор квеста&nbsp;— она написана на&nbsp;кнопке.
              За&nbsp;пропущенное задание монеты не&nbsp;начисляются. Если монет не&nbsp;хватает, баланс уходит
              в&nbsp;минус&nbsp;— подсказка доступна всегда.
            </p>
          </section>

          <section className="rules__section" id="help">
            <h2 className="display">Если что-то пошло не&nbsp;так</h2>
            <ul className="rules__list">
              <li>
                Ответ не&nbsp;принимается, хотя вы уверены, нашли опечатку или объекта нет на&nbsp;месте&nbsp;—
                откройте меню квеста и&nbsp;выберите «Сообщить об&nbsp;ошибке». Номер шага приложится сам.
              </li>
              <li>Хотите пройти заново&nbsp;— меню квеста → «Сбросить прогресс».</li>
              <li>
                Вопросы по&nbsp;оплате и&nbsp;доступу&nbsp;— пишите в&nbsp;Telegram{' '}
                <a href={SUPPORT_TG_URL} target="_blank" rel="noopener">{SUPPORT_TG}</a>.
              </li>
              <li>
                Возврат оплаты&nbsp;— по&nbsp;условиям <Link href="/terms">Пользовательского соглашения</Link>.
              </li>
            </ul>
          </section>

          <section className="rules__section" id="safety">
            <h2 className="display">Перед выходом и&nbsp;на&nbsp;маршруте</h2>
            <ul className="rules__list">
              <li>
                Возьмите заряженный телефон&nbsp;— лучше с&nbsp;пауэрбанком&nbsp;— и&nbsp;мобильный интернет.
                Или скачайте квест заранее.
              </li>
              <li>
                Наденьте удобную обувь и&nbsp;оденьтесь по&nbsp;погоде. Длительность маршрута указана
                в&nbsp;карточке квеста.
              </li>
              <li>
                Все задания&nbsp;— в&nbsp;общественных местах: не&nbsp;заходите на&nbsp;закрытые территории,
                не&nbsp;залезайте на&nbsp;ограждения и&nbsp;памятники.
              </li>
              <li>Соблюдайте ПДД и&nbsp;смотрите по&nbsp;сторонам, а&nbsp;не&nbsp;только в&nbsp;экран.</li>
              <li>Дети проходят квест вместе со&nbsp;взрослыми.</li>
              <li>Не&nbsp;публикуйте ответы&nbsp;— оставьте интригу другим.</li>
            </ul>
          </section>

          <section className="rules__section" id="faq">
            <h2 className="display">Частые вопросы</h2>
            <div className="rules__faq">
              {FAQ.map((f) => (
                <details className="card" key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 48 }}>
          <Link className="btn" href="/#shop" style={{ width: 272 }}>Выбрать квест</Link>
        </div>
      </section>
    </SiteShell>
  );
}
