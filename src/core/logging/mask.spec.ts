import { MASK_CENSOR } from './logging.constants.ts';
import { maskSensitive } from './mask.ts';

describe('maskSensitive (LOG-07)', () => {
  it.each([
    'password',
    'Password',
    'new_password',
    'currentPassword',
    'password_confirmation',
    'otp_code',
    'access_token',
    'refreshToken',
    'client_secret',
    'api_key',
    'x-api-key',
    'authorization',
    'set-cookie',
    'card_number',
    'cvv',
    'national_id',
    'private_key',
    // A job's text and its result are the user's content.
    'input',
    'result',
  ])('masks %s', (key) => {
    expect(maskSensitive({ [key]: 'value' })).toEqual({ [key]: MASK_CENSOR });
  });

  it.each(['email', 'first_name', 'order_id', 'card_type', 'keyboard', 'footprint'])('keeps %s', (key) => {
    expect(maskSensitive({ [key]: 'value' })).toEqual({ [key]: 'value' });
  });

  it('masks at any depth, including arrays', () => {
    const input = { user: { profile: { password: 'x' } }, items: [{ api_key: 'y', name: 'lamp' }] };

    expect(maskSensitive(input)).toEqual({
      user: { profile: { password: MASK_CENSOR } },
      items: [{ api_key: MASK_CENSOR, name: 'lamp' }],
    });
  });

  it('does not change the original object', () => {
    const input = { password: 'x' };

    maskSensitive(input);

    expect(input.password).toBe('x');
  });

  it('survives circular references', () => {
    const input: { name: string; self?: object } = { name: 'loop' };
    input.self = input;

    expect(() => maskSensitive(input)).not.toThrow();
  });
});
