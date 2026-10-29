import { describe, expect, it } from 'vitest';
import { parseChatIntent } from '../src/model';

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
