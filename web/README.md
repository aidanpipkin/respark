# Respark web

React + Vite front end, running on Supabase (Auth, PostgREST, Storage, Edge Functions). The old Base44 SDK surface is preserved as a thin adapter in `src/api/base44Client.js`, so components still import `base44` from there.

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL, e.g. `https://abcd1234.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | The project's anon (public) key |
| `VITE_SUPABASE_UPLOAD_BUCKET` | Optional. Private storage bucket for uploads (default `uploads`) |

Both keys are public by design; row access is enforced by RLS and the edge functions.

## Scripts

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm run preview  # serve dist/ locally
npm run lint     # eslint src --max-warnings=0
npm test         # vitest (query translator)
```

## How the adapter maps to Supabase

- `base44.auth.*` -> Supabase Auth (email+password, sign-up with 6-digit email OTP, password recovery, Google via `signInWithOAuth`). `auth.me()` merges the session user with `profiles` (`role`, `full_name`).
- `base44.entities.<Entity>.filter/get/count` -> PostgREST on the snake_case table (`Lead` -> `lead`, `AIDraft` -> `ai_draft`), or its owner-scoped `v_<table>` view where the schema defines one. Mongo-style queries are translated in `src/api/query.js`; pagination is keyset (`next_cursor` encodes the last row's sort value + id).
- `base44.functions.invoke(name, payload)` -> `POST ${VITE_SUPABASE_URL}/functions/v1/${name}` with the user's JWT (or the anon key when signed out, so the public site and lead form work).
- `base44.integrations.Core.UploadFile / UploadPrivateFile / CreateFileSignedUrl` -> Storage bucket `uploads` (private, 1-hour signed URLs).
- `getAccessToken()` (exported from the client) replaces every read of `localStorage.base44_access_token`.

## Supabase Auth settings the app relies on

- Email confirmations on, with the confirmation template sending `{{ .Token }}` (the register page asks for a 6-digit code). If confirmations are off, sign-up logs the user straight in.
- Password recovery redirect: `https://<your-domain>/reset-password` (and `http://localhost:5173/reset-password` for dev) in the redirect allow-list. The default recovery template works; a custom template may link to `/reset-password?token_hash={{ .TokenHash }}&type=recovery`.
- Google provider enabled; `https://<your-domain>/**` and `http://localhost:5173/**` in the redirect allow-list (the app redirects back to `/dashboard` or `/welcome`).

## Deploying on Vercel

- Root directory: `web`
- Framework preset: Vite (build command `npm run build`, output directory `dist`, install command `npm install`)
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Production and Preview)
- Single-page app routing: `web/vercel.json` rewrites every path to `index.html` so deep links (e.g. `/a/:slug`, `/reset-password`) load.
