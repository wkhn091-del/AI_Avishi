/**
 * An error that maps directly onto an HTTP response.
 *
 * Throw it from any route or service; the error middleware serialises it as
 * `{ error: { message, code, details? } }` with the given status. Messages are
 * written for the person using the dashboard, so they are shown verbatim.
 */
export class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} message Human-readable explanation of what went wrong
   * @param {string} [code]  Stable machine-readable code for the client
   * @param {object} [details] Extra structured data (e.g. the id of a duplicate)
   */
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Shorthand for a 404, e.g. notFound('הפרויקט לא נמצא.'). */
export const notFound = (message) => new HttpError(404, message, 'NOT_FOUND');
