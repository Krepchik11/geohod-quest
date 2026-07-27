'use client';

import React from 'react';
import { AGE_TARGET_OPTIONS, COMPLEXITY_OPTIONS } from '../../lib/constructor-model';

/**
 * The CONSTRUCTOR dashboard filter bar: Поиск + Статус + Сложность + Возраст +
 * Тег, all expanded and single-select — a workspace list where the fields are
 * always visible. The store has its own toolbar (components/StoreToolbar): the
 * two lists share their data rules (lib/quest-filters), never their chrome.
 *
 * The options for the closed sets come from lib/constructor-model (single
 * source of truth); the tag list is whatever exists in the caller's quests.
 * Purely presentational — the caller owns the state and the predicate.
 */

export interface QuestFiltersValue {
  search: string;
  status: string;
  complexity: string;
  age: string;
  tag: string;
}

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="#1a2b48" strokeWidth="1.8" /></svg>
);

export default function QuestFilters({
  value,
  onChange,
  tags,
  statusOptions,
}: {
  value: QuestFiltersValue;
  onChange: (next: QuestFiltersValue) => void;
  /** Tags that actually exist across the caller's quests (sorted). */
  tags: string[];
  /** Статус options; the first one is «all». */
  statusOptions: string[];
}) {
  const set = <K extends keyof QuestFiltersValue>(key: K, v: QuestFiltersValue[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <div className="qcd-filters">
      <div className="qcd-field">
        <label htmlFor="qf-search">Поиск</label>
        <div className="qcd-field__wrap">
          <svg className="qcd-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#9aa0ab" strokeWidth="1.8" /><path d="M20 20l-3.6-3.6" stroke="#9aa0ab" strokeWidth="1.8" strokeLinecap="round" /></svg>
          <input
            id="qf-search"
            className="qcd-input"
            value={value.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Название или автор…"
          />
        </div>
      </div>
      <div className="qcd-field">
        <label htmlFor="qf-status">Статус</label>
        <div className="qcd-field__wrap">
          <select
            id="qf-status"
            className="qcd-select"
            value={value.status}
            onChange={(e) => set('status', e.target.value)}
          >
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          <span className="qcd-chevron"><ChevronDown /></span>
        </div>
      </div>
      <div className="qcd-field">
        <label htmlFor="qf-complexity">Сложность</label>
        <div className="qcd-field__wrap">
          <select
            id="qf-complexity"
            className="qcd-select"
            value={value.complexity}
            onChange={(e) => set('complexity', e.target.value)}
          >
            <option value="">Любая</option>
            {COMPLEXITY_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <span className="qcd-chevron"><ChevronDown /></span>
        </div>
      </div>
      <div className="qcd-field">
        <label htmlFor="qf-age">Возраст</label>
        <div className="qcd-field__wrap">
          <select
            id="qf-age"
            className="qcd-select"
            value={value.age}
            onChange={(e) => set('age', e.target.value)}
          >
            <option value="">Любой</option>
            {AGE_TARGET_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <span className="qcd-chevron"><ChevronDown /></span>
        </div>
      </div>
      <div className="qcd-field">
        <label htmlFor="qf-tag">Тег</label>
        <div className="qcd-field__wrap">
          <select
            id="qf-tag"
            className="qcd-select"
            value={value.tag}
            onChange={(e) => set('tag', e.target.value)}
          >
            <option value="">Все теги</option>
            {tags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="qcd-chevron"><ChevronDown /></span>
        </div>
      </div>
    </div>
  );
}
