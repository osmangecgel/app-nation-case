// A content insert can lose a race to a concurrent transaction inserting the
// same content; it is retried with a fresh snapshot before giving up.
export const MAX_CONTENT_UPSERT_ATTEMPTS = 3;
