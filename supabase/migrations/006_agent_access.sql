-- OAuth/MCP 与网页共用数据库写入边界：CAS、回收站、审计不可绕过。
begin;

create table private.agent_config (
  singleton boolean primary key default true check (singleton),
  resource_url text not null check (resource_url like 'https://%')
);
insert into private.agent_config values (true, 'https://taskboard-liubai.vercel.app/api/mcp');

create table private.board_trash (
  id uuid primary key default gen_random_uuid(),
  owner_uuid uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  payload jsonb not null
);
create index board_trash_owner_time on private.board_trash(owner_uuid, deleted_at desc);
create table private.board_audit (
  id bigint generated always as identity primary key,
  owner_uuid uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  client_id text,
  action text not null,
  object_kind text not null,
  object_id text,
  result text not null default 'ok'
);
create index board_audit_owner_time on private.board_audit(owner_uuid, occurred_at desc);
create table private.agent_requests (
  owner_uuid uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  request_id uuid not null,
  fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_uuid, client_id, request_id)
);

alter table private.agent_config enable row level security;
alter table private.board_trash enable row level security;
alter table private.board_audit enable row level security;
alter table private.agent_requests enable row level security;
revoke all on private.agent_config, private.board_trash, private.board_audit, private.agent_requests from public, anon, authenticated;

-- 配置为 Supabase Custom Access Token Hook，仅授权服务器可执行。
-- 保留 authenticated audience 供 PostgREST 使用，同时绑定本应用的 MCP 资源。
create function public.taskboard_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare claims jsonb := event->'claims'; resource text;
begin
  if coalesce(event->>'client_id', claims->>'client_id') is not null then
    select resource_url into strict resource from private.agent_config where singleton;
    claims := jsonb_set(claims, '{aud}', jsonb_build_array('authenticated', resource));
    return jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;
revoke all on function public.taskboard_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.taskboard_access_token_hook(jsonb) to supabase_auth_admin;

-- 已签发 JWT 不能靠离线验签实现即时撤销；OAuth 每次读写都核对活动会话和同意记录。
create or replace function private.assert_authenticated_user()
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid(); claims jsonb := auth.jwt(); client text := nullif(auth.jwt()->>'client_id', '');
  resource text;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if client is not null then
    select resource_url into strict resource from private.agent_config where singleton;
    if not coalesce((claims->'aud') ? resource, false)
      or not exists (select 1 from auth.sessions s where s.id::text = claims->>'session_id'
        and s.user_id = owner_id and s.oauth_client_id::text = client
        and (s.not_after is null or s.not_after > now()))
      or not exists (select 1 from auth.oauth_consents c where c.user_id = owner_id
        and c.client_id::text = client and c.revoked_at is null)
    then raise exception 'OAuth session expired or access revoked' using errcode = '42501'; end if;
  end if;
  return owner_id;
end;
$$;
revoke all on function private.assert_authenticated_user() from public, anon, authenticated;

create function private.capture_board_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  kind text; removed jsonb; payload jsonb := '{}'::jsonb; has_deleted boolean := false;
  client text := nullif(auth.jwt()->>'client_id', '');
begin
  foreach kind in array array['cycles', 'tasks', 'focusBlocks'] loop
    select coalesce(jsonb_agg(a.value order by a.ordinality), '[]'::jsonb) into removed
    from jsonb_array_elements(old.snapshot->kind) with ordinality a(value, ordinality)
    where not exists (select 1 from jsonb_array_elements(new.snapshot->kind) b where b->>'id' = a.value->>'id');
    payload := jsonb_set(payload, array[kind], removed);
    has_deleted := has_deleted or jsonb_array_length(removed) > 0;
    insert into private.board_audit(owner_uuid, client_id, action, object_kind, object_id)
    select new.owner_uuid, client,
      case when a.value is null then 'create' when b.value is null then 'delete'
        when a.value is distinct from b.value then 'update' else 'reorder' end,
      kind, coalesce(a.value->>'id', b.value->>'id')
    from jsonb_array_elements(old.snapshot->kind) with ordinality a(value, position)
    full join jsonb_array_elements(new.snapshot->kind) with ordinality b(value, position)
      on a.value->>'id' = b.value->>'id'
    where a.value is distinct from b.value or a.position is distinct from b.position;
  end loop;
  -- ponytail: 一次保存的删除集合是一个回收单位；需要逐项恢复时再拆分回收条目。
  if has_deleted then insert into private.board_trash(owner_uuid, payload) values (new.owner_uuid, payload); end if;
  if old.snapshot->'settings' is distinct from new.snapshot->'settings' then
    insert into private.board_audit(owner_uuid, client_id, action, object_kind)
    values (new.owner_uuid, client, 'update', 'settings');
  end if;
  return new;
end;
$$;
revoke all on function private.capture_board_changes() from public, anon, authenticated;
create trigger board_changes after update of snapshot on private.personal_boards
  for each row when (old.snapshot is distinct from new.snapshot) execute function private.capture_board_changes();

create function private.capture_oauth_consent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.revoked_at is distinct from old.revoked_at or new.granted_at is distinct from old.granted_at then
    insert into private.board_audit(owner_uuid, client_id, action, object_kind, object_id)
    values (new.user_id, new.client_id::text, case when new.revoked_at is null then 'authorize' else 'revoke' end, 'authorization', new.client_id::text);
  end if;
  return new;
end;
$$;
revoke all on function private.capture_oauth_consent() from public, anon, authenticated;
create trigger taskboard_oauth_consent after insert or update on auth.oauth_consents
  for each row execute function private.capture_oauth_consent();

create function public.get_board_trash(p_limit integer default 50, p_offset integer default 0, p_id uuid default null)
returns table(id uuid, deleted_at timestamptz, expires_at timestamptz, payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := private.assert_authenticated_user();
begin
  delete from private.board_trash t where t.owner_uuid = owner_id and t.expires_at <= now();
  return query select t.id, t.deleted_at, t.expires_at, t.payload from private.board_trash t
    where t.owner_uuid = owner_id and (p_id is null or t.id = p_id)
    order by t.deleted_at desc, t.id limit greatest(1, least(coalesce(p_limit, 50), 100)) offset greatest(0, least(coalesce(p_offset, 0), 10000));
end;
$$;

create function public.get_board_audit(p_limit integer default 50, p_offset integer default 0)
returns table(id bigint, occurred_at timestamptz, client_id text, action text, object_kind text, object_id text, result text)
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := private.assert_authenticated_user();
begin
  delete from private.board_audit a where a.owner_uuid = owner_id and a.occurred_at <= now() - interval '90 days';
  return query select a.id, a.occurred_at, a.client_id, a.action, a.object_kind, a.object_id, a.result from private.board_audit a
    where a.owner_uuid = owner_id order by a.id desc limit greatest(1, least(coalesce(p_limit, 50), 100)) offset greatest(0, least(coalesce(p_offset, 0), 10000));
end;
$$;

create function public.purge_board_trash(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := private.assert_authenticated_user();
begin
  if nullif(auth.jwt()->>'client_id', '') is not null
    or not exists (select 1 from auth.sessions s where s.id::text = auth.jwt()->>'session_id'
      and s.user_id = owner_id and s.oauth_client_id is null and (s.not_after is null or s.not_after > now()))
  then raise exception 'Permanent purge requires a direct user session' using errcode = '42501'; end if;
  delete from private.board_trash t where t.owner_uuid = owner_id and t.id = p_id;
  if not found then raise exception 'Trash entry missing' using errcode = '22023'; end if;
  insert into private.board_audit(owner_uuid, action, object_kind, object_id) values (owner_id, 'purge', 'trash', p_id::text);
end;
$$;

create function public.get_agent_request(p_request_id uuid, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := private.assert_authenticated_user(); item private.agent_requests;
begin
  select * into item from private.agent_requests r where r.owner_uuid = owner_id
    and r.client_id = coalesce(nullif(auth.jwt()->>'client_id', ''), 'web') and r.request_id = p_request_id;
  if not found then return null; end if;
  if item.fingerprint is distinct from p_fingerprint then raise exception 'Request ID was already used with different input' using errcode = '22023'; end if;
  return item.response || '{"replayed":true}'::jsonb;
end;
$$;

create function public.commit_agent_board(p_expected_revision bigint, p_snapshot jsonb, p_request_id uuid, p_fingerprint text, p_restore_ids uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := private.assert_authenticated_user(); client text := coalesce(nullif(auth.jwt()->>'client_id', ''), 'web');
  previous jsonb; stored_revision bigint; replay jsonb; entry private.board_trash;
  trash_id uuid; kind text; item jsonb; created jsonb := '{}'::jsonb; ids jsonb; response jsonb;
begin
  if p_request_id is null or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'Invalid request identity' using errcode = '22023'; end if;
  perform public.get_private_board();
  select b.snapshot, b.revision into previous, stored_revision from private.personal_boards b where b.owner_uuid = owner_id for update;
  replay := public.get_agent_request(p_request_id, p_fingerprint);
  if replay is not null then return replay; end if;
  if p_expected_revision is distinct from stored_revision then raise exception 'Board revision conflict' using errcode = 'PT409'; end if;
  perform private.validate_board_snapshot(p_snapshot);
  if coalesce(cardinality(p_restore_ids), 0) > 100 then raise exception 'Too many restore entries' using errcode = '22023'; end if;
  foreach trash_id in array coalesce(p_restore_ids, '{}'::uuid[]) loop
    select * into entry from private.board_trash t where t.owner_uuid = owner_id and t.id = trash_id and t.expires_at > now() for update;
    if not found then raise exception 'Trash entry missing or expired' using errcode = '22023'; end if;
    -- 不允许把「消费回收条目」当作 Agent 永久清除入口：所有对象必须真实恢复到工作区。
    foreach kind in array array['cycles', 'tasks', 'focusBlocks'] loop
      for item in select value from jsonb_array_elements(entry.payload->kind) loop
        if not exists (select 1 from jsonb_array_elements(p_snapshot->kind) v where v->>'id' = item->>'id')
          or exists (select 1 from jsonb_array_elements(previous->kind) v where v->>'id' = item->>'id')
        then raise exception 'Restore must add every deleted object without replacing live data' using errcode = '22023'; end if;
      end loop;
    end loop;
  end loop;
  perform public.cas_save_private_board(p_expected_revision, p_snapshot);
  foreach trash_id in array coalesce(p_restore_ids, '{}'::uuid[]) loop
    delete from private.board_trash t where t.owner_uuid = owner_id and t.id = trash_id;
    insert into private.board_audit(owner_uuid, client_id, action, object_kind, object_id)
      values (owner_id, nullif(client, 'web'), 'restore', 'trash', trash_id::text);
  end loop;
  foreach kind in array array['cycles', 'tasks', 'focusBlocks'] loop
    select coalesce(jsonb_agg(v->>'id'), '[]'::jsonb) into ids from jsonb_array_elements(p_snapshot->kind) v
      where not exists (select 1 from jsonb_array_elements(previous->kind) p where p->>'id' = v->>'id');
    created := jsonb_set(created, array[kind], ids);
  end loop;
  -- 幂等结果只保留 ID 和版本，不保留正文或旧快照，避免变成隐藏的永久备份。
  response := jsonb_build_object('revision', stored_revision + 1, 'created', created, 'replayed', false);
  insert into private.agent_requests(owner_uuid, client_id, request_id, fingerprint, response)
    values (owner_id, client, p_request_id, p_fingerprint, response);
  return response;
end;
$$;

create function public.record_board_failure(p_result text)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := private.assert_authenticated_user(); client text := nullif(auth.jwt()->>'client_id', '');
begin
  if p_result not in ('conflict', 'invalid', 'error') then raise exception 'Invalid result' using errcode = '22023'; end if;
  -- 同客户端一分钟最多一条失败摘要，避免无效请求把审计表灌满；不记录输入和令牌。
  if not exists (select 1 from private.board_audit a where a.owner_uuid = owner_id and a.client_id is not distinct from client
    and a.result = p_result and a.occurred_at > now() - interval '1 minute') then
    insert into private.board_audit(owner_uuid, client_id, action, object_kind, result) values (owner_id, client, 'rejected', 'board', p_result);
  end if;
end;
$$;

create function private.cleanup_agent_data()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from private.board_trash where expires_at <= now();
  delete from private.board_audit where occurred_at <= now() - interval '90 days';
  delete from private.agent_requests where created_at <= now() - interval '1 day';
end;
$$;
revoke all on function private.cleanup_agent_data() from public, anon, authenticated;

do $$
declare signature text;
begin
  foreach signature in array array[
    'public.get_board_trash(integer,integer,uuid)', 'public.get_board_audit(integer,integer)',
    'public.purge_board_trash(uuid)', 'public.get_agent_request(uuid,text)',
    'public.commit_agent_board(bigint,jsonb,uuid,text,uuid[])', 'public.record_board_failure(text)'
  ] loop
    execute 'revoke all on function ' || signature || ' from public, anon';
    execute 'grant execute on function ' || signature || ' to authenticated';
  end loop;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$select cron.schedule('liubai-agent-retention', '17 * * * *', 'select private.cleanup_agent_data()')$cron$;
  else
    raise notice 'Enable pg_cron and schedule private.cleanup_agent_data() hourly before production launch';
  end if;
end;
$$;
commit;
