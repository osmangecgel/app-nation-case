// Authentication is out of scope: the caller is identified by this header alone.
export const USER_ID_HEADER = 'x-user-id';

export const USER_ID_MAX_LENGTH = 64;

export const AuthErrorCode = {
  USER_ID_REQUIRED: 'USER_ID_REQUIRED',
} as const;
