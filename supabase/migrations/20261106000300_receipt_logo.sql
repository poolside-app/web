-- PLAN.md BZ (Doug 11/6: "add the club logo at the top"): the club's logo,
-- kept with each receipt like its name and address, and the app icon made
-- from it (a PNG), for a logo a PDF can't hold, like a WebP.
alter table public.receipts add column if not exists logo_url text;
alter table public.receipts add column if not exists logo_icon_url text;
