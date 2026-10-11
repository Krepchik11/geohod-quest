import React from 'react';
import {
  PARTNER_PROGRAM_URL,
  SUPPORT_TG,
  SUPPORT_TG_URL,
  WALK_MEMO_URL,
  WALK_RULES_URL,
} from '../../lib/contacts';

/**
 * The words around the walks on the «Афиша» pages. Every claim comes from the
 * club's own pages — the walk rules, the checklist («Памятка») and the partner
 * programme on Telegraph (lib/contacts) — and from the announcements
 * themselves; nothing here promises more than they do.
 */

/** The line under the «Прогулки» heading. */
export const WALKS_SLOGAN = 'Сербия пешком — в хорошей компании';

/** What a walk is, in one paragraph: where they go, how it works, the price. */
export const WALKS_LEDE =
  'Фрушка гора, Белград и окрестности: монастыри, смотровые площадки, озёра и римские башни. ' +
  'Маршрут знает ведущий — вам остаётся прийти к месту встречи. Участие бесплатное.';

/** The line under the «Групповые квесты» heading and what such a game is. */
export const QUESTS_SLOGAN = 'Вместе играть веселее';
export const QUESTS_LEDE =
  'Проходим квест GEOHOD компанией с организатором — хороший способ найти друзей.';

/** The walk rules, as the site tells them (WALK_RULES_URL has the originals). */
const RULES: readonly { title: string; text: string }[] = [
  {
    title: 'Сообщество, а не турфирма',
    text: 'Мы гуляем вместе ради удовольствия. Все участники равны, ведущего определяет группа.',
  },
  {
    title: 'Участие бесплатное',
    text: 'Проезд, еду и другие личные расходы каждый оплачивает сам. Поблагодарить ведущего можно донатом — он целиком достаётся ему.',
  },
  {
    title: 'Для взрослых и детей с родителями',
    text: 'Прогулки открыты для всех взрослых. Несовершеннолетние — только вместе с родителями и под их ответственность.',
  },
  {
    title: 'Своим ходом',
    text: 'Трансфер, питание и ночлег не предоставляются. До старта добираемся общественным транспортом — как именно, написано в анонсе.',
  },
  {
    title: 'Что взять',
    text: 'Воду (0,5–1 л), репеллент от клещей, средство от загара, перекус, лекарства и пластырь, телефон. Обувь — разношенные кроссовки или треккинговые ботинки, в рюкзак — флиску и дождевик.',
  },
];

function ClubLinks() {
  return (
    <p className="afi-links">
      <a href={WALK_RULES_URL} target="_blank" rel="noopener">
        Правила участия
      </a>
      <a href={WALK_MEMO_URL} target="_blank" rel="noopener">
        Памятка: что взять и надеть
      </a>
    </p>
  );
}

/** «Как устроены прогулки» — the rules as cards, under the walks list. */
export function WalkRules() {
  return (
    <section className="afi-rules" aria-labelledby="afi-rules-title">
      <h3 id="afi-rules-title" className="afi-rules__title">
        Как устроены прогулки
      </h3>
      <ul className="afi-rules__grid">
        {RULES.map((rule) => (
          <li key={rule.title} className="afi-rule">
            <h4 className="afi-rule__title">{rule.title}</h4>
            <p>{rule.text}</p>
          </li>
        ))}
      </ul>
      <ClubLinks />
    </section>
  );
}

/** «Перед прогулкой» — the rules that matter on the day, on an announcement page. */
export function BeforeWalk() {
  return (
    <section className="afi-before" aria-labelledby="afi-before-title">
      <h2 id="afi-before-title" className="afi-before__title">
        Перед прогулкой
      </h2>
      <ul>
        <li>Участие бесплатное; проезд, еду и другие расходы каждый оплачивает сам.</li>
        <li>Несовершеннолетние — только с родителями и под их ответственность.</li>
        <li>Возьмите воду, репеллент от клещей, перекус и дождевик, обувь — удобную и разношенную.</li>
      </ul>
      <ClubLinks />
    </section>
  );
}

/** The partner programme: an organizer with a route of their own leads a walk with the club. */
export function PartnerInvite() {
  return (
    <section className="afi-partner card" aria-labelledby="afi-partner-title">
      <p className="overline">Для организаторов</p>
      <h2 id="afi-partner-title" className="afi-partner__title">
        Покажите свою Сербию
      </h2>
      <p className="afi-partner__lede">
        Есть авторский маршрут? Проведите по нему прогулку с нами. До старта должен ходить общественный транспорт,
        а по пути — интересные места: смотровые площадки, памятники, монастыри, пещеры, водопады, тайники GeoHod.
      </p>
      <ol className="afi-partner__steps">
        <li>Предложите маршрут — изучим его вместе и утвердим.</li>
        <li>Назначьте дату, время и место встречи и создайте событие в мини-приложении LeeLoo — поможем, если нужно.</li>
        <li>
          Мы опубликуем анонс в канале «Прогулки по Сербии», в афише сайта и у партнёров. Запись участников и отзывы
          идут через LeeLoo сами.
        </li>
        <li>Проведите прогулку. Все донаты участников — ваши, а отзывы складываются в ваш личный рейтинг.</li>
      </ol>
      <div className="afi-partner__actions">
        <a className="btn btn--md" href={SUPPORT_TG_URL} target="_blank" rel="noopener">
          Написать {SUPPORT_TG}
        </a>
        <a href={PARTNER_PROGRAM_URL} target="_blank" rel="noopener">
          Условия партнёрской программы
        </a>
      </div>
      <p className="afi-partner__note">Партнёр принимает правила прогулок.</p>
    </section>
  );
}
