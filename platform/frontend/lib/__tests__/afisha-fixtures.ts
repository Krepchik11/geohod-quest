/**
 * Shared «Афиша» test data: post 1110 of the channel as the public API and the
 * admin API serve it (backend handlers/afisha.rs).
 */
import type { AdminAfishaWire } from '../admin-afisha';
import type { AfishaEventWire } from '../afisha';

/** A walk as GET /api/afisha serves it (post 1110 of the channel). */
export const WALK: AfishaEventWire = {
  post_id: 1110,
  slug: '2026-10-11-progulyaemsya-k-rimskoy-bashne-vrdnichka-kula-1110',
  kind: 'hiking',
  title: 'Прогуляемся к римской башне Врдничка кула',
  date: '2026-10-11',
  time: '12:45',
  starts_at: '2026-10-11T12:45:00+02:00',
  ends_at: '2026-10-11T17:45:00+02:00',
  city: 'Нови Сад',
  city_slug: 'novi-sad',
  place: 'Лиманский парк, на площади с флагами',
  distance: '7 км',
  duration: '5 часов',
  route: null,
  difficulty: 'средняя (дети от 10 лет)',
  guide: 'Марьяна Постриган',
  price: 'донат по желанию',
  expenses: null,
  bring: null,
  description: 'Маршрут начинается у смотровой площадки Zmajevac.\nОбратно — на автобусе №86.',
  image: 'https://api.example/api/media/abc',
  register_url: 'https://t.me/geohodton_bot?startapp=AuBz',
  post_url: 'https://t.me/serbia_progulki/1110',
  past: false,
};

export const adminEvent = (over: Partial<AdminAfishaWire> = {}): AdminAfishaWire => ({
  post_id: 1110,
  slug: '2026-10-11-vrdnichka-kula-1110',
  status: 'published',
  kind: 'hiking',
  fields: {
    title: 'Врдничка кула',
    date: '2026-10-11',
    time: '12:45',
    city: 'Нови Сад',
    place: 'Лиманский парк',
    distance: '7 км',
    duration: null,
    route: null,
    difficulty: null,
    guide: null,
    price: 'донат по желанию',
    expenses: null,
    bring: null,
    description: null,
  },
  edited: [],
  image: null,
  register_url: 'https://t.me/geohodton_bot?startapp=x',
  post_url: 'https://t.me/serbia_progulki/1110',
  posted_at: '2026-10-07T12:37:49Z',
  problem: null,
  clicks: 0,
  past: false,
  starts_at: '2026-10-11T12:45:00+02:00',
  ...over,
});
