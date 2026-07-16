import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import SpaceHeader from './SpaceHeader';

/**
 * The shared back-office top bar: logo lockup + space eyebrow + optional tab
 * strip + user menu. Worn by every admin page (with tabs) and by the
 * constructor dashboard (without).
 */
const meta = {
  title: 'Chrome/SpaceHeader',
  component: SpaceHeader,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SpaceHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {
  args: {
    eyebrow: 'АДМИНКА',
    tabsLabel: 'Разделы админки',
    active: 'users',
    tabs: [
      { key: 'users', label: 'Пользователи', href: '/admin' },
      { key: 'coupons', label: 'Купоны', href: '/admin/coupons' },
      { key: 'features', label: 'Функции', href: '/admin/features' },
      { key: 'stats', label: 'Статистика', href: '/admin/stats' },
    ],
  },
};

export const Constructor: Story = {
  args: { eyebrow: 'КОНСТРУКТОР' },
};
