/**
 * api/strava/auth.ts
 * GET → Redirect the browser to Strava's OAuth authorization page.
 *
 * Environment variables:
 *   STRAVA_CLIENT_ID
 *   STRAVA_REDIRECT_URI   e.g. https://your-app.vercel.app/api/strava/callback
 */
export default function handler(req: any, res: any) {
  const clientId     = process.env.STRAVA_CLIENT_ID
  const redirectUri  = process.env.STRAVA_REDIRECT_URI

  if (!clientId || !redirectUri) {
    res.status(500).send('STRAVA_CLIENT_ID / STRAVA_REDIRECT_URI not configured'); return
  }

  // Generate a random state value (CSRF protection)
  const state = Math.random().toString(36).slice(2, 10)
  res.setHeader('Set-Cookie', `strava_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`)

  const url =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=activity%3Aread_all` +
    `&state=${state}`

  res.redirect(302, url)
}
