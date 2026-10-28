import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER,
  Incident,
  Me,
  canWrite,
  formatAge,
  isFiltered,
  normaliseIncident,
  parseMapping,
  selectIncidents,
} from '../src/model';

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'Q1',
  incident_number: 42,
  title: 'Checkout latency over SLO',
  status: 'triggered',
  urgency: 'high',
  created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:05:00Z',
  html_url: 'https://acme.pagerduty.com/incidents/Q1',
  service: { id: 'PSVC1', summary: 'Payments API' },
  escalation_policy: { id: 'PEP1', summary: 'Payments' },
  assignments: [{ assignee: { id: 'PU1', summary: 'Ada' } }],
  acknowledgements: [],
  teams: [{ id: 'PT1', summary: 'Payments' }],
  priority: { summary: 'P1' },
  ...over,
});

const me: Me = { id: 'PU1', name: 'Ada', email: 'ada@example.com', role: 'user', teams: [{ id: 'PT1', name: 'Payments' }] };

describe('normaliseIncident', () => {
  it('maps the API shape', () => {
    const i = normaliseIncident(raw());
    expect(i).toMatchObject({ number: 42, service: { id: 'PSVC1', name: 'Payments API' }, assignees: [{ id: 'PU1', name: 'Ada' }], priority: 'P1' });
  });
  it('tolerates a missing priority and teams', () => {
    const i = normaliseIncident(raw({ priority: null, teams: undefined }));
    expect(i.priority).toBeUndefined();
    expect(i.teams).toEqual([]);
  });
});

describe('selectIncidents', () => {
  const list: Incident[] = [
    normaliseIncident(raw({ id: 'A', incident_number: 1, status: 'acknowledged' })),
    normaliseIncident(raw({ id: 'B', incident_number: 2, urgency: 'low' })),
    normaliseIncident(raw({ id: 'C', incident_number: 3, created_at: '2026-10-28T11:00:00Z' })),
    normaliseIncident(raw({ id: 'D', incident_number: 4, assignments: [], teams: [] })),
    normaliseIncident(raw({ id: 'E', incident_number: 5, status: 'resolved' })),
  ];

  it('sorts triggered, then high urgency, then newest', () => {
    expect(selectIncidents(list, 'all', me, DEFAULT_FILTER).map((i) => i.id)).toEqual(['C', 'D', 'B', 'A']);
  });
  it('scopes to mine and to my teams', () => {
    expect(selectIncidents(list, 'mine', me, DEFAULT_FILTER).map((i) => i.id)).not.toContain('D');
    expect(selectIncidents(list, 'teams', { ...me, teams: [] }, DEFAULT_FILTER)).toEqual([]);
  });
  it('filters by text across number and service', () => {
    expect(selectIncidents(list, 'all', me, { ...DEFAULT_FILTER, text: '#3' }).map((i) => i.id)).toEqual(['C']);
    expect(selectIncidents(list, 'all', me, { ...DEFAULT_FILTER, text: 'payments checkout' })).toHaveLength(4);
  });
  it('includes resolved only when asked', () => {
    expect(selectIncidents(list, 'all', me, { ...DEFAULT_FILTER, statuses: ['resolved'] }).map((i) => i.id)).toEqual(['E']);
  });
  it('knows when a filter is active', () => {
    expect(isFiltered(DEFAULT_FILTER)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTER, urgencies: ['high'] })).toBe(true);
  });
});

describe('helpers', () => {
  it('formats ages', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(formatAge('2026-10-28T11:59:30Z', now)).toBe('30s');
    expect(formatAge('2026-10-28T11:00:00Z', now)).toBe('1h');
    expect(formatAge('2026-10-26T12:00:00Z', now)).toBe('2d');
  });
  it('treats read-only roles as read-only', () => {
    expect(canWrite(me)).toBe(true);
    expect(canWrite({ ...me, role: 'observer' })).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });
  it('validates .pagerduty.json', () => {
    expect(parseMapping('{"serviceId":"PABC123"}').mapping).toEqual({ serviceId: 'PABC123' });
    expect(parseMapping('{').error).toMatch(/not valid JSON/);
    expect(parseMapping('{"serviceId":"payments"}').error).toMatch(/serviceId/);
  });
});
