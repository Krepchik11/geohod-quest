import type { Metadata } from 'next';
import WorkspaceGate from './WorkspaceGate';

/**
 * Конструктор квестов v2 — рабочее место (design «Конструктор v2.html»):
 * список квестов, создание с общими параметрами, билдер 3 панели с живым
 * превью настоящими компонентами плеера, тест-игрок и публикация с гейтами.
 *
 * NB: маршрут осознанно называется quest-editor, не constructor — сегмент
 * app-роутера с именем свойства Object.prototype роняет dev-сервер Next 16
 * (см. next.config.ts redirect /constructor → /quest-editor).
 */
export const metadata: Metadata = {
  title: 'Конструктор квестов — GEOHOD QUEST',
};

export default function QuestEditorPage() {
  return <WorkspaceGate />;
}
