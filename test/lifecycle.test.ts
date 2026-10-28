import { describe, expect, it } from 'vitest';
import { buildPostmortem, normaliseIncident, parseChatIntent } from '../src/model';

describe('parseChatIntent (typed or dictated)', () => {
  it.each([
    ['acknowledge 4821', undefined, 'ack', 4821],
    ['please ack incident number 4821', undefined, 'ack', 4821],
    ['resolve #77', undefined, 'resolve', 77],
    ["what's open for me", undefined, 'mine', undefined],
    ['ask Paige about 4821', undefined, 'paige', 4821],
    ['why is checkout slow', undefined, 'ask', undefined],
    ['4821', 'ack', 'ack', 4821],
  ])('%s', (text, cmd, intent, number) => {
    const r = parseChatIntent(text, cmd);
    expect(r.intent).toBe(intent);
    expect(r.number).toBe(number);
  });
  it('extracts the note text', () => {
    expect(parseChatIntent('add note to 4821: rolled back the deploy').rest).toBe('rolled back the deploy');
  });
});

describe('buildPostmortem', () => {
  it('assembles impact, timeline, follow-ups and changes', () => {
    const i = normaliseIncident({
      id: 'Q1', incident_number: 9, title: 'DB down', status: 'resolved', urgency: 'high',
      created_at: '2026-10-28T10:00:00Z', service: { id: 'S', summary: 'DB' }, escalation_policy: { id: 'E', summary: 'E' },
      assignments: [{ assignee: { id: 'U', summary: 'Ada' } }], acknowledgements: [], teams: [],
    });
    const md = buildPostmortem(
      i,
      {
        fetchedAt: '',
        alerts: [],
        log: [
          { id: '2', kind: 'resolve', summary: 'Resolved', createdAt: '2026-10-28T11:30:00Z' },
          { id: '1', kind: 'acknowledge', summary: 'Acked', createdAt: '2026-10-28T10:05:00Z' },
        ],
        notes: [
          { id: 'n1', content: 'Follow-up: add pool alerting', createdAt: '2026-10-28T11:00:00Z', author: 'Ada' },
          { id: 'n2', content: 'rolled back', createdAt: '2026-10-28T10:20:00Z', author: 'Ada' },
        ],
      },
      undefined,
    );
    expect(md).toContain('# Postmortem: #9 DB down');
    expect(md).toContain('**Time to acknowledge:** 5m');
    expect(md).toContain('**Time to resolve:** 1h 30m');
    expect(md).toContain('- [ ] add pool alerting (Ada)');
    expect(md.indexOf('Acked')).toBeLessThan(md.indexOf('Resolved'));
    expect(md).toContain('rolled back');
  });
});
