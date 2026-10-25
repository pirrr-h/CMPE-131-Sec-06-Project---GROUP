revoke all on public.users from anon;

revoke select on public.users from authenticated;
grant select (user_id, full_name, role, avatar_url, is_verified, rating_avg, rating_count)
  on public.users to authenticated;

revoke update on public.users from authenticated;
grant update (full_name, phone, avatar_url, gender)
  on public.users to authenticated;

revoke insert, delete, truncate, references, trigger on public.users from authenticated;