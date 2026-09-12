-- Liubai Taskboard：每个认证用户一块独立看板。
-- 旧 owner_config 只用于单 owner 模式；本迁移保留 personal_boards 中已有数据，
-- 改为按 auth.uid() 幂等创建和读写，不复制、不转移任何旧账号数据。

drop policy if exists personal_boards_owner_access on private.personal_boards;
drop function if exists private.is_configured_board_owner(uuid);
drop function if exists private.assert_board_owner();
drop table if exists private.owner_config;

create or replace function private.assert_authenticated_user()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  return current_user_id;
end;
$$;

revoke all on function private.assert_authenticated_user() from public, anon, authenticated;

create policy personal_boards_owner_access on private.personal_boards
  for all to authenticated
  using ((select auth.uid()) = owner_uuid)
  with check ((select auth.uid()) = owner_uuid);

create or replace function public.get_private_board()
returns table(revision bigint, snapshot jsonb)
language plpgsql
security definer
set search_path = pg_catalog, private, public
as $$
declare
  owner_id uuid;
begin
  owner_id := private.assert_authenticated_user();
  insert into private.personal_boards(owner_uuid, revision, snapshot)
  values (owner_id, 0, jsonb_build_object(
    'schemaVersion', 1,
    'settings', jsonb_build_object('timeZone', 'UTC'),
    'cycles', jsonb_build_array(),
    'tasks', jsonb_build_array(),
    'focusBlocks', jsonb_build_array()))
  on conflict (owner_uuid) do nothing;
  return query
    select b.revision, b.snapshot
    from private.personal_boards b
    where b.owner_uuid = owner_id;
end;
$$;

create or replace function public.cas_save_private_board(p_expected_revision bigint, p_snapshot jsonb)
returns table(revision bigint, snapshot jsonb)
language plpgsql
security definer
set search_path = pg_catalog, private, public
as $$
declare
  owner_id uuid;
  next_revision bigint;
  next_snapshot jsonb;
begin
  owner_id := private.assert_authenticated_user();
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Expected board revision is invalid' using errcode = '22023';
  end if;
  perform private.validate_board_snapshot(p_snapshot);

  update private.personal_boards b
  set revision = b.revision + 1, snapshot = p_snapshot, updated_at = now()
  where b.owner_uuid = owner_id and b.revision = p_expected_revision
  returning b.revision, b.snapshot into next_revision, next_snapshot;

  if not found then
    raise exception 'Board revision conflict' using errcode = 'PT409';
  end if;

  return query select next_revision, next_snapshot;
end;
$$;

revoke all on function public.get_private_board() from public, anon;
revoke all on function public.cas_save_private_board(bigint, jsonb) from public, anon;
grant execute on function public.get_private_board() to authenticated;
grant execute on function public.cas_save_private_board(bigint, jsonb) to authenticated;

comment on table private.personal_boards is 'One private JSONB board per authenticated user, written only through CAS RPC.';
