/**
 * TrueLayer authorization-return parsing, shared by the connector dialog and
 * the connection details page.
 */

/**
 * Parse what the user pasted to confirm a legacy v1 journey: either the full
 * URL TrueLayer redirected to (its confirmation page carries code+state) or a
 * bare authorization code. For a bare code the CSRF `state` is taken from the
 * stored authorization link, since that is what TrueLayer echoes back.
 */
export function parseTrueLayerConfirmation(
  pasted: string,
  authUrl?: string,
): { code?: string; state?: string; redirectUrl?: string } {
  const trimmed = pasted.trim();
  if (/^https?:\/\//i.test(trimmed)) return { redirectUrl: trimmed };
  if (!trimmed) return {};
  let state: string | undefined;
  if (authUrl) {
    try {
      state = new URL(authUrl).searchParams.get('state') ?? undefined;
    } catch {
      state = undefined;
    }
  }
  return { code: trimmed, state };
}
