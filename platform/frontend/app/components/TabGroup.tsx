'use client';

import React, { useState } from 'react';

/**
 * TabGroup - controlled tabs matching design .tabs + .tab + .tab-panel (admin ctor).
 * Narrow 'use client', explicit active, no inner comp defs.
 * Usage: <TabGroup tabs={[{id:'ctor', label:'Конструктор...'}, ...]} active={active} onChange=... >
 *   <div data-tab="ctor">...</div>
 * </TabGroup>
 * Or use children with ids.
 */
export default function TabGroup({
  tabs,
  active: controlledActive,
  onChange,
  children,
}: {
  tabs: Array<{ id: string; label: string }>;
  active?: string;
  onChange?: (id: string) => void;
  children: React.ReactNode;
}) {
  const [internal, setInternal] = useState(tabs[0]?.id || '');
  const active = controlledActive ?? internal;

  const setActive = (id: string) => {
    if (onChange) onChange(id);
    else setInternal(id);
  };

  return (
    <>
      <div className="tabs" data-tabs>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab ${active === t.id ? 'is-active' : ''}`}
            data-tab={t.id}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {React.Children.map(children, (child) => {
        if (React.isValidElement<{ 'data-tab'?: string; className?: string; style?: React.CSSProperties }>(child) && child.props['data-tab']) {
          const tabId = child.props['data-tab'];
          const isActive = active === tabId;
          return React.cloneElement(child, {
            className: `${child.props.className || ''} tab-panel ${isActive ? 'is-active' : ''}`.trim(),
            style: { display: isActive ? 'block' : 'none', ...child.props.style },
          });
        }
        return child;
      })}
    </>
  );
}
