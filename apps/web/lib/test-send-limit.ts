/**
 * How many test emails one user may send in a rolling window. Shared by the
 * server route and the editor, so this module must stay free of server-only
 * imports.
 */
export const TEST_SEND_LIMIT = 5;
export const TEST_SEND_WINDOW_MS = 3600000;
