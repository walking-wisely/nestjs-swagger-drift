import { describe, expect, it } from 'vitest';
import { joinPath } from '../../src/core/routes.js';

describe('joinPath', () => {
  it('joins a class prefix and a param segment', () => {
    expect(joinPath('users', ':id')).toBe('/users/:id');
  });

  it('bare controller + bare handler is the root', () => {
    expect(joinPath('', '')).toBe('/');
  });

  it('strips duplicate/leading/trailing slashes from both segments', () => {
    expect(joinPath('/users/', '/:id/')).toBe('/users/:id');
  });

  it('handles a class prefix with no method path', () => {
    expect(joinPath('users', '')).toBe('/users');
  });

  it('handles a bare controller with a method path', () => {
    expect(joinPath('', 'health')).toBe('/health');
  });

  it('collapses internal empty segments', () => {
    expect(joinPath('users//', '//:id')).toBe('/users/:id');
  });

  it('is idempotent on an already-joined path used as classPath', () => {
    expect(joinPath('users/:id', '')).toBe('/users/:id');
  });
});
