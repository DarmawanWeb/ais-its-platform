import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreateNoteDto } from './create-note.dto.js';
import { UpdateNoteDto } from './update-note.dto.js';

/** Validates like the kit's ValidationPipe (whitelist, forbidNonWhitelisted). */
async function errorsOf(
  type: typeof CreateNoteDto | typeof UpdateNoteDto,
  input: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(type, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}).sort(),
    ]),
  );
}

describe('CreateNoteDto', () => {
  it('accepts a complete note and trims the title', async () => {
    const dto = plainToInstance(CreateNoteDto, {
      mmsi: 525005223,
      title: '  Hull inspection  ',
    });
    expect(dto.title).toBe('Hull inspection');
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects an invalid MMSI, an empty title and malformed tags', async () => {
    expect(
      await errorsOf(CreateNoteDto, {
        mmsi: 12345,
        title: '   ',
        tags: ['Not A Slug', 'ok', 'ok'],
      }),
    ).toEqual({
      mmsi: ['min'],
      title: ['isLength'],
      tags: ['arrayUnique', 'matches'],
    });
  });

  it('rejects unknown properties', async () => {
    expect(
      await errorsOf(CreateNoteDto, {
        mmsi: 525005223,
        title: 'x',
        orgId: 'someone-else',
      }),
    ).toEqual({ orgId: ['whitelistValidation'] });
  });
});

describe('UpdateNoteDto', () => {
  it('makes every field optional but never accepts the vessel', async () => {
    expect(await errorsOf(UpdateNoteDto, {})).toEqual({});
    expect(await errorsOf(UpdateNoteDto, { body: 'text' })).toEqual({});
    expect(await errorsOf(UpdateNoteDto, { mmsi: 525005223 })).toEqual({
      mmsi: ['whitelistValidation'],
    });
  });

  it('rejects null for the NOT NULL columns instead of writing it', async () => {
    expect(
      await errorsOf(UpdateNoteDto, { title: null, body: null, tags: null }),
    ).toEqual({
      title: ['isLength', 'isString'],
      body: ['isString', 'maxLength'],
      tags: ['arrayMaxSize', 'arrayUnique', 'isArray', 'matches'],
    });
    expect(
      await errorsOf(CreateNoteDto, {
        mmsi: 525005223,
        title: 'x',
        body: null,
      }),
    ).toEqual({
      body: ['isString', 'maxLength'],
    });
  });
});
