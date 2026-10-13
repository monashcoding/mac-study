-- Guards against forgotten timers. After 8 hours of one continuous session the
-- scheduler sends a single "still studying?" check, and after 12 hours it
-- stops the session, capping it at 12 hours and flagging it for review.
-- Both are claimed atomically so overlapping job runs cannot double-send.

alter table public.study_sessions
  add column if not exists long_session_check_sent_at timestamptz;

create index if not exists study_sessions_active_started_at_idx
on public.study_sessions (started_at)
where ended_at is null
  and deleted_at is null
  and status = 'active';

create or replace function public.claim_long_study_session_checks(
  batch_size integer default 100
)
returns table (
  session_id uuid,
  user_id uuid,
  started_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  return query
  with due_sessions as (
    select session.id
    from public.study_sessions as session
    where session.long_session_check_sent_at is null
      and session.ended_at is null
      and session.deleted_at is null
      and session.status = 'active'
      and session.started_at <= clock_timestamp() - interval '8 hours'
      and session.started_at > clock_timestamp() - interval '12 hours'
    order by session.started_at
    for update skip locked
    limit least(greatest(coalesce(batch_size, 100), 1), 250)
  )
  update public.study_sessions as session
  set long_session_check_sent_at = clock_timestamp()
  from due_sessions
  where session.id = due_sessions.id
  returning
    session.id,
    session.user_id,
    session.started_at;
end;
$$;

create or replace function public.stop_overlong_study_sessions(
  batch_size integer default 100
)
returns table (
  session_id uuid,
  user_id uuid,
  started_at timestamptz,
  ended_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  return query
  with overlong_sessions as (
    select session.id
    from public.study_sessions as session
    where session.ended_at is null
      and session.deleted_at is null
      and session.status = 'active'
      and session.started_at <= clock_timestamp() - interval '12 hours'
    order by session.started_at
    for update skip locked
    limit least(greatest(coalesce(batch_size, 100), 1), 250)
  )
  update public.study_sessions as session
  set
    ended_at = session.started_at + interval '12 hours',
    status = 'needs_confirmation'
  from overlong_sessions
  where session.id = overlong_sessions.id
  returning
    session.id,
    session.user_id,
    session.started_at,
    session.ended_at;
end;
$$;

revoke all on function public.claim_long_study_session_checks(integer)
from public;
grant execute on function public.claim_long_study_session_checks(integer)
to service_role;

revoke all on function public.stop_overlong_study_sessions(integer)
from public;
grant execute on function public.stop_overlong_study_sessions(integer)
to service_role;

notify pgrst, 'reload schema';
