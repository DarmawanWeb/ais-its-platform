import { describe, expect, it } from 'vitest';

import { escapeLikePattern } from './notes.repository.js';

describe('escapeLikePattern', () => {
  it('makes LIKE wildcards and the escape character literal', () => {
    expect(escapeLikePattern('100% sure_ok\\')).toBe('100\\% sure\\_ok\\\\');
    expect(escapeLikePattern('Hull inspection')).toBe('Hull inspection');
  });
});
