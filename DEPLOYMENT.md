# Deploying Got It Solutions Provider — Pharmaceutical Inventory System

I can't create accounts, run the Supabase CLI, or deploy anything from my sandbox
(no internet access there), so these are the exact steps to do it yourself.

## Part A — Database & Auth setup

### 1. Run the three SQL files (in order)
In Supabase → **SQL Editor → New query**:
1. Paste and run `supabase_schema.sql` first (if you haven't already — creates `app_data`).
2. Paste and run `supabase_schema_auth.sql` next — creates `profiles`, `activity_logs`,
   the max-2-Administrator rule, and the Employee-ID login lookup.
3. Paste and run `supabase_schema_lockout.sql` — adds the 5-failed-attempt account
   lockout used by the new login screen.

### 2. Deploy the 3 Edge Functions
These run server-side with your `service_role` key so the browser never sees it.
You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed locally.

```bash
supabase login
supabase link --project-ref dmaqgryjorevpxbeqlnv
supabase functions deploy create-user
supabase functions deploy delete-user
supabase functions deploy reset-password
```

(The `supabase/functions/` folder with all 3 is included in this deploy package.)

### 3. Create your first Administrator
You already created one Supabase Auth user earlier. Now give it a `profiles` row —
run this in SQL Editor, replacing the email:

```sql
insert into profiles (id, employee_id, full_name, email, role, must_change_password)
values (
  (select id from auth.users where email = 'YOUR_ADMIN_EMAIL_HERE'),
  'ADM001', 'Your Name', 'YOUR_ADMIN_EMAIL_HERE', 'Administrator', false
);
```

From here on, **all other users must be created from inside the app** (User Management
page, Administrator role only) — there is no public sign-up.

## Part B — Deploy the app to Netlify
Same as before:
1. Unzip this package.
2. Netlify → **Deploy manually** → drag the folder in.
3. Done — you get a live URL.

## Part C — Sign in
Go to your Netlify URL, sign in with `ADM001`'s email (or the Employee ID once you're
used to it) and password. You'll land on the Dashboard with full Administrator access,
including **User Management** and **Activity Log** in the sidebar (only Administrators
see these).

## Part D — Package as Android APK / Windows app
No coding needed — **PWABuilder** does this from your live Netlify URL:
1. Go to https://www.pwabuilder.com
2. Paste your live Netlify URL, click **Start**.
3. It reads your `manifest.json` (already configured with your icons/branding).
4. Click **Package for Stores**:
   - **Android** → downloads a signed APK/AAB you can install directly or submit to
     Google Play.
   - **Windows** → downloads an MSIX package installable on Windows 10/11.
5. If PWABuilder flags anything about icons, the icons are already at
   `icons/icon-192.png` and `icons/icon-512.png` in this package — just make sure
   they're in the same relative location on your deployed site (Netlify preserves
   the folder structure automatically).

## What's enforced where
- **Frontend**: hides/disables buttons and nav items the current role shouldn't use
  (fast, but not the real security boundary — just better UX).
- **Database (RLS)**: the actual boundary. Even if someone bypassed the UI, Postgres
  Row Level Security blocks reads/writes their role isn't allowed.
- **Edge Functions**: creating/deleting users and resetting passwords require
  `service_role` privileges, which only exist server-side in these 3 functions —
  never in the browser.

## Known simplification (being upfront about it)
- **"Remember Me"**: currently just a flag stored locally; the real security control
  is the 30-minute inactivity timeout, which applies regardless of this checkbox.
  A stricter "sign out when the tab closes if unchecked" behavior would need a bit
  more work — let me know if you want that tightened up.
- **Staff "Submit New Medicine Request for approval"** (from the OCR Match Detection
  work) is still mid-build from an earlier session — flagging so it doesn't get lost.
