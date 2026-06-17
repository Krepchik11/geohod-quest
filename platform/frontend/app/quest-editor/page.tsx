import type { Metadata } from 'next';
import EditorGate from './EditorGate';

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
  // EditorGate enforces the editor/admin role before mounting the constructor
  // (admin-roles); the backend re-checks on publish via require_editor.
  return <EditorGate />;
}
