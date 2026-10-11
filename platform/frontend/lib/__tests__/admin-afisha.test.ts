import { describe, expect, it } from 'vitest';
import {
  countByFilter,
  draftOf,
  editedLabel,
  reportText,
  saveBodyOf,
  whenLabel,
} from '../admin-afisha';
import { adminEvent } from './afisha-fixtures';

describe('admin «Афиша» view-model', () => {
  it('round-trips the form: blanks go back as none, the title trimmed', () => {
    const draft = draftOf(adminEvent());
    expect(draft.kind).toBe('hiking');
    expect(draft.fields.duration).toBe('');
    draft.fields.title = '  Врдничка кула ';
    draft.fields.place = '   ';
    draft.kind = '';
    const body = saveBodyOf(1110, draft);
    expect(body.post_id).toBe(1110);
    expect(body.kind).toBeNull();
    expect(body.fields.title).toBe('Врдничка кула');
    expect(body.fields.place).toBeNull();
    expect(body.fields.date).toBe('2026-10-11');
  });

  it('counts every filter', () => {
    const counts = countByFilter([
      adminEvent(),
      adminEvent({ post_id: 2, status: 'draft' }),
      adminEvent({ post_id: 3, status: 'draft' }),
      adminEvent({ post_id: 4, status: 'untagged' }),
    ]);
    expect(counts).toEqual({ all: 4, published: 1, draft: 2, hidden: 0, untagged: 1, removed: 0 });
  });

  it('says when, or what the date lacks', () => {
    expect(whenLabel(adminEvent())).toBe('11.10.2026, 12:45');
    expect(whenLabel(adminEvent({ fields: { ...adminEvent().fields, time: null } }))).toBe('11.10.2026, без времени');
    expect(whenLabel(adminEvent({ fields: { ...adminEvent().fields, date: null } }))).toBe('без даты');
  });

  it('names the hand-edited fields in Russian', () => {
    expect(editedLabel(adminEvent())).toBeNull();
    expect(editedLabel(adminEvent({ edited: ['kind', 'time', 'title'] }))).toBe('тип, время, название');
  });

  it('reports a read of the channel', () => {
    expect(reportText({ read: 21, created: 3, updated: 1, removed: 0, next_before: null })).toBe(
      'Прочитано 21 пост: новых 3, обновлено 1, снято 0',
    );
  });
});
