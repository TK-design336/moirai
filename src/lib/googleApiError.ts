/**
 * Extract Google Cloud Console "enable API" URL from error message.
 * e.g. "Enable it by visiting https://console.developers.google.com/apis/api/tasks.googleapis.com/overview?project=..."
 */
export function extractGoogleApiEnableUrl(errorMessage: string): string | null {
  const m = errorMessage.match(/https:\/\/console\.developers\.google\.com\/[^\s)]+/);
  return m ? m[0] : null;
}
