const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a UUID: ids that aren't never reach the database (they simply aren't found). */
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);
