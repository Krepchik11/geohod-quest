import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import React from 'react';
import { AdminPageHead, AdminConfirmSheet, AdminToast } from './ui';

/**
 * Shared admin-page primitives — the scaffolding every admin tab wears
 * (see styles/admin-page.css). Wrapped in .ap-root/.ap-main so the stories
 * render on the real page canvas.
 */
const page = (child: React.ReactNode) => (
  <div className="ap-root" style={{ minHeight: '100vh' }}>
    <main className="ap-main">{child}</main>
  </div>
);

const meta: Meta = { title: 'Admin/Primitives' };
export default meta;

export const PageHead: StoryObj = {
  render: () =>
    page(
      <AdminPageHead
        eyebrow="УПРАВЛЕНИЕ"
        title="Купоны"
        lede="Необязательное пояснение раздела — как на вкладке «Функции»."
      >
        <button type="button" className="btn btn--md">
          Действие
        </button>
      </AdminPageHead>,
    ),
};

export const ConfirmSheet: StoryObj = {
  render: () =>
    page(
      <AdminConfirmSheet
        label="Сменить роль"
        title="Сменить роль?"
        text="Анна получит роль «Редактор». Доступ изменится сразу."
        applyLabel="Назначить"
        busyLabel="Сохраняем…"
        busy={false}
        onCancel={() => {}}
        onApply={() => {}}
      />,
    ),
};

export const ConfirmSheetDanger: StoryObj = {
  render: () =>
    page(
      <AdminConfirmSheet
        label="Удалить купон"
        title="Удалить купон LETO-20?"
        text="Удаление необратимо. Уже применённые скидки и покупки сохраняются."
        applyLabel="Удалить"
        busyLabel="Удаляем…"
        busy={false}
        danger
        onCancel={() => {}}
        onApply={() => {}}
      />,
    ),
};

export const Toast: StoryObj = {
  render: () => page(<AdminToast text="Роль обновлена" />),
};

export const ToastError: StoryObj = {
  render: () => page(<AdminToast text="Не удалось обновить роль" error />),
};
