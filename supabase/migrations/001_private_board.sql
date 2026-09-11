-- Liubai Taskboard 私有 owner board。
-- ponytail：单 owner JSONB/CAS 行；数据量或协作增长后升级为按实体的规范化 mutation。
-- 本仓库不会执行 provisioning：
-- 先创建唯一 Auth 用户，再把下面的 REPLACE_WITH_OWNER_UUID 换成其 UUID，
-- 由管理员在 Supabase SQL Editor 执行 DDL。

create schema if not exists private;

create table if not exists private.owner_config (
  singleton boolean primary key default true check (singleton),
  owner_uuid uuid not null references auth.users(id) on delete restrict
);

-- provisioning 步骤（选定 owner 后手动执行一次）：
-- insert into private.owner_config(singleton, owner_uuid)
-- values (true, 'REPLACE_WITH_OWNER_UUID'::uuid);

create table if not exists private.personal_boards (
  owner_uuid uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);

alter table private.owner_config enable row level security;
alter table private.personal_boards enable row level security;

-- 需要 schema 使用权，RLS 策略才能解析 private.is_configured_board_owner。
-- 表本身的权限仍不授予客户端：所有读写只能经由下方 SECURITY DEFINER RPC，
-- 这样即便将来有人授予表权限，策略依然强制「只有配置的 owner」可访问。
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke all on private.owner_config from public, anon, authenticated;
revoke all on private.personal_boards from public, anon, authenticated;

grant usage on schema public to authenticated;

create or replace function private.assert_board_owner()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private, public
as $$
declare
  configured_owner uuid;
  current_owner uuid;
begin
  current_owner := auth.uid();
  if current_owner is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select owner_uuid into configured_owner
  from private.owner_config
  where singleton = true;
  if configured_owner is null or configured_owner <> current_owner then
    raise exception 'Board owner is not authorized' using errcode = '42501';
  end if;
  return current_owner;
end;
$$;

create or replace function private.valid_date_key(value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and to_char(to_date(value, 'YYYY-MM-DD'), 'YYYY-MM-DD') = value;
$$;

create or replace function private.valid_week_key(value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select value ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'
    and (
      select extract(isoyear from monday) = substring(value from 1 for 4)::int
        and extract(week from monday) = substring(value from 7 for 2)::int
      from (
        select date_trunc('week', make_date(substring(value from 1 for 4)::int, 1, 4))::date
          + ((substring(value from 7 for 2)::int - 1) * 7) as monday
      ) as iso
    );
$$;

create or replace function private.valid_timestamp(value text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then return false; end if;
  perform value::timestamptz;
  return true;
exception when others then
  return false;
end;
$$;

-- 可选 id 键：键不存在 → true；键存在则必须是非空字符串（≤160）。显式 JSON null 视为存在，与客户端一致。
-- 与 JS `String.prototype.trim()` 对齐的空白判定：
-- btrim 默认只去空格，制表符等仍会残留；NBSP/FEFF 等 Unicode 空白 JS 也会去掉。
create or replace function private.is_blank(value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select value is null
    or value = ''
    or regexp_replace(value, '^[\s\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '') = '';
$$;

-- 与 JS `String.prototype.length` 对齐的长度：JS 以 UTF-16 码元计数，PG 的 length() 以字符计数，
-- 因此补充星号面（4 字节）字符的额外码元，避免“160 个星号面字符”在 SQL 侧被放行。
create or replace function private.utf16_length(value text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(sum(case when octet_length(ch) = 4 then 2 else 1 end), 0)
  from regexp_split_to_table(coalesce(value, ''), '') as ch;
$$;

create or replace function private.valid_optional_id(value jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select value is null
    or (jsonb_typeof(value) = 'string' and not private.is_blank(value #>> '{}') and private.utf16_length(value #>> '{}') <= 160);
$$;

-- 可选时间戳键：键不存在 → true；键存在则必须是合法时间戳字符串。
create or replace function private.valid_optional_timestamp(value jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select value is null
    or (jsonb_typeof(value) = 'string' and private.valid_timestamp(value #>> '{}'));
$$;

create or replace function private.validate_board_snapshot(input jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, public
as $$
declare
  item jsonb;
  history_item jsonb;
  parent jsonb;
  upper_item jsonb;
  task_id text;
  task_domain text;
  parent_id text;
  upper_id text;
  cycle_id text;
  week_key text;
  date_key text;
  seen_ids text[] := array[]::text[];
  cycle_ids text[] := array[]::text[];
  seen_focus_ids text[] := array[]::text[];
  running_count integer := 0;
  duration numeric;
  elapsed numeric;
  zone text;
begin
  -- 统一使用 is distinct from：缺失键时 jsonb_typeof 返回 NULL，普通比较会被 NULL 短路而放行。
  if jsonb_typeof(input) is distinct from 'object'
    or jsonb_typeof(input->'schemaVersion') is distinct from 'number' or input->>'schemaVersion' is distinct from '1'
    or jsonb_typeof(input->'settings') is distinct from 'object'
    or jsonb_typeof(input->'cycles') is distinct from 'array'
    or jsonb_typeof(input->'tasks') is distinct from 'array'
    or jsonb_typeof(input->'focusBlocks') is distinct from 'array' then
    raise exception 'Board snapshot has an unsupported shape' using errcode = '22023';
  end if;
  if octet_length(input::text) > 900000 then
    raise exception 'Board snapshot is too large' using errcode = '22023';
  end if;
  zone := input->'settings'->>'timeZone';
  if zone is null or length(zone) > 100 or not exists (select 1 from pg_timezone_names where name = zone) then
    raise exception 'Board timezone is invalid' using errcode = '22023';
  end if;
  if jsonb_array_length(input->'cycles') > 200
    or jsonb_array_length(input->'tasks') > 2000
    or jsonb_array_length(input->'focusBlocks') > 500 then
    raise exception 'Board collection is too large' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(input->'cycles') loop
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or private.is_blank(item->>'id') or private.utf16_length(item->>'id') > 160
      or item->>'id' = any(seen_ids)
      or jsonb_typeof(item->'name') is distinct from 'string'
      or private.is_blank(item->>'name') or private.utf16_length(item->>'name') > 160
      or item->>'startDate' is null or not private.valid_date_key(item->>'startDate')
      or item->>'endDate' is null or not private.valid_date_key(item->>'endDate')
      or item->>'startDate' > item->>'endDate'
      or not private.valid_timestamp(item->>'createdAt') then
      raise exception 'Board cycle is invalid' using errcode = '22023';
    end if;
    seen_ids := array_append(seen_ids, item->>'id');
    cycle_ids := array_append(cycle_ids, item->>'id');
  end loop;

  for item in select value from jsonb_array_elements(input->'tasks') loop
    task_id := item->>'id';
    task_domain := item->>'domain';
    cycle_id := item->>'cycleId';
    week_key := item->>'weekKey';
    date_key := item->>'dateKey';
    parent_id := item->>'parentId';
    upper_id := item->>'upperTaskId';
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or private.is_blank(task_id) or private.utf16_length(task_id) > 160
      or task_id = any(seen_ids)
      or jsonb_typeof(item->'domain') is distinct from 'string' or task_domain not in ('long', 'weekly', 'daily')
      or jsonb_typeof(item->'title') is distinct from 'string'
      or private.is_blank(item->>'title') or private.utf16_length(item->>'title') > 300
      or jsonb_typeof(item->'note') is distinct from 'string' or private.utf16_length(item->>'note') > 2000
      or jsonb_typeof(item->'checked') is distinct from 'boolean'
      or jsonb_typeof(item->'color') is distinct from 'string' or item->>'color' not in ('ink', 'blue', 'orange', 'green', 'violet')
      or not private.valid_timestamp(item->>'createdAt')
      or not private.valid_timestamp(item->>'updatedAt')
      or jsonb_typeof(item->'history') is distinct from 'array'
      or not private.valid_optional_id(item->'cycleId')
      or not private.valid_optional_id(item->'weekKey')
      or not private.valid_optional_id(item->'dateKey')
      or not private.valid_optional_id(item->'parentId')
      or not private.valid_optional_id(item->'upperTaskId')
      or not private.valid_optional_id(item->'rescheduledTo')
      or not private.valid_optional_timestamp(item->'archivedAt') then
      raise exception 'Board task is invalid' using errcode = '22023';
    end if;
    for history_item in select value from jsonb_array_elements(item->'history') loop
      if jsonb_typeof(history_item) is distinct from 'object'
        or jsonb_typeof(history_item->'domain') is distinct from 'string' or history_item->>'domain' not in ('long', 'weekly', 'daily')
        or not private.valid_timestamp(history_item->>'recordedAt')
        or not private.valid_optional_id(history_item->'cycleId')
        or not private.valid_optional_id(history_item->'weekKey')
        or not private.valid_optional_id(history_item->'dateKey')
        or (history_item->>'dateKey' is not null and not private.valid_date_key(history_item->>'dateKey'))
        or (history_item->>'cycleId' is null and history_item->>'weekKey' is null and history_item->>'dateKey' is null)
        -- 与客户端一致：每个域只能携带自己的放置键，否则快照会在下次加载时被客户端拒绝。
        or (history_item->>'domain' = 'long' and (history_item->>'cycleId' is null or history_item->>'weekKey' is not null or history_item->>'dateKey' is not null))
        or (history_item->>'domain' = 'weekly' and (history_item->>'cycleId' is not null or history_item->>'dateKey' is not null or history_item->>'weekKey' is null))
        or (history_item->>'domain' = 'daily' and (history_item->>'cycleId' is not null or history_item->>'weekKey' is not null or history_item->>'dateKey' is null))
        or (history_item->>'weekKey' is not null and not private.valid_week_key(history_item->>'weekKey')) then
        raise exception 'Task history is invalid' using errcode = '22023';
      end if;
    end loop;
    if task_domain = 'long' and (cycle_id is null or not (cycle_id = any(cycle_ids)) or week_key is not null or date_key is not null) then
      raise exception 'Long-term task placement is invalid' using errcode = '22023';
    elsif task_domain = 'weekly' and (cycle_id is not null or date_key is not null or week_key is null or not private.valid_week_key(week_key)) then
      raise exception 'Weekly task placement is invalid' using errcode = '22023';
    elsif task_domain = 'daily' and (cycle_id is not null or week_key is not null or date_key is null or not private.valid_date_key(date_key)) then
      raise exception 'Daily task placement is invalid' using errcode = '22023';
    end if;
    if item->>'archivedAt' is not null and not private.valid_timestamp(item->>'archivedAt') then
      raise exception 'Archived task timestamp is invalid' using errcode = '22023';
    end if;
    if item->'archivedReason' is not null and item->>'archivedReason' is distinct from 'rescheduled' then
      raise exception 'Archived task reason is invalid' using errcode = '22023';
    end if;
    if (item->>'archivedReason' is not null or item->>'rescheduledTo' is not null) and item->>'archivedAt' is null then
      raise exception 'Archived task metadata is invalid' using errcode = '22023';
    end if;
    if item->>'rescheduledTo' is not null and not exists (
      select 1 from jsonb_array_elements(input->'tasks') as other where other->>'id' = item->>'rescheduledTo'
    ) then
      raise exception 'Reschedule history target is invalid' using errcode = '22023';
    end if;
    seen_ids := array_append(seen_ids, task_id);
  end loop;

  -- A parent is always a same-domain top-level task, so the graph has one level.
  for item in select value from jsonb_array_elements(input->'tasks') loop
    parent_id := item->>'parentId';
    upper_id := item->>'upperTaskId';
    if parent_id is not null then
      select value into parent from jsonb_array_elements(input->'tasks') where value->>'id' = parent_id limit 1;
      if parent is null or parent->>'domain' <> item->>'domain' or parent->>'parentId' is not null
        or parent->>'cycleId' is distinct from item->>'cycleId'
        or parent->>'weekKey' is distinct from item->>'weekKey'
        or parent->>'dateKey' is distinct from item->>'dateKey' then
        raise exception 'Task subtask graph is invalid' using errcode = '22023';
      end if;
    end if;
    if upper_id is not null then
      if parent_id is not null then
        raise exception 'Subtasks cannot cross-link' using errcode = '22023';
      end if;
      select value into upper_item from jsonb_array_elements(input->'tasks') where value->>'id' = upper_id limit 1;
      if upper_item is null
        or upper_item->>'parentId' is not null
        or upper_item->>'id' = item->>'id'
        or (item->>'domain' = 'weekly' and upper_item->>'domain' <> 'long')
        or (item->>'domain' = 'daily' and upper_item->>'domain' <> 'weekly')
        or item->>'domain' = 'long' then
        raise exception 'Task association is invalid' using errcode = '22023';
      end if;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(input->'focusBlocks') loop
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or private.is_blank(item->>'id') or private.utf16_length(item->>'id') > 160
      or item->>'id' = any(seen_focus_ids)
      or item->>'dateKey' is null or not private.valid_date_key(item->>'dateKey')
      or jsonb_typeof(item->'title') is distinct from 'string' or private.is_blank(item->>'title') or private.utf16_length(item->>'title') > 300
      or jsonb_typeof(item->'status') is distinct from 'string' or item->>'status' not in ('running', 'paused', 'finished')
      or jsonb_typeof(item->'durationMinutes') is distinct from 'number'
      or jsonb_typeof(item->'elapsedMs') is distinct from 'number'
      or not private.valid_optional_id(item->'taskId')
      or not private.valid_optional_timestamp(item->'startedAt')
      or not private.valid_optional_timestamp(item->'finishedAt') then
      raise exception 'Focus block is invalid' using errcode = '22023';
    end if;
    duration := (item->>'durationMinutes')::numeric;
    elapsed := (item->>'elapsedMs')::numeric;
    if duration <= 0 or duration > 1440 or elapsed < 0 or elapsed > 86400000
      or not private.valid_timestamp(item->>'createdAt')
      or (item->>'startedAt' is not null and not private.valid_timestamp(item->>'startedAt'))
      or (item->>'finishedAt' is not null and not private.valid_timestamp(item->>'finishedAt')) then
      raise exception 'Focus block timing is invalid' using errcode = '22023';
    end if;
    if item->>'taskId' is not null then
      select value into parent from jsonb_array_elements(input->'tasks') where value->>'id' = item->>'taskId' limit 1;
      if parent is null or parent->>'domain' <> 'daily' then
        raise exception 'Focus task association is invalid' using errcode = '22023';
      end if;
    end if;
    if item->>'status' = 'running' then
      if item->>'startedAt' is null or item->>'finishedAt' is not null then
        raise exception 'Running focus timer is invalid' using errcode = '22023';
      end if;
      running_count := running_count + 1;
    elsif item->>'status' = 'paused' and item->>'startedAt' is not null then
      raise exception 'Paused focus timer is invalid' using errcode = '22023';
    elsif item->>'status' = 'finished' and (item->>'startedAt' is not null or item->>'finishedAt' is null) then
      raise exception 'Finished focus timer is invalid' using errcode = '22023';
    end if;
    seen_focus_ids := array_append(seen_focus_ids, item->>'id');
  end loop;
  if running_count > 1 then
    raise exception 'Only one focus timer may be running' using errcode = '23514';
  end if;
end;
$$;

create or replace function private.is_configured_board_owner(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, private, public
as $$
  -- 三个条件都必须成立：有登录身份、请求者就是 candidate、candidate 是配置的 owner。
  -- 只比较 candidate 与配置 owner 会让任何已认证用户都能读写 owner 的那一行。
  select auth.uid() is not null
    and candidate is not null
    and auth.uid() = candidate
    and candidate = (select owner_uuid from private.owner_config where singleton = true);
$$;

revoke all on function private.is_configured_board_owner(uuid) from public, anon;
grant execute on function private.is_configured_board_owner(uuid) to authenticated;

-- schema USAGE 之后，PUBLIC 的默认 EXECUTE 会让任何已认证用户直接调用这些 SECURITY DEFINER 函数。
-- 它们只被 RPC（以 definer 身份）调用，因此撤销 PUBLIC/anon 执行权限、不单独授予客户端。
revoke all on function private.assert_board_owner() from public, anon, authenticated;
revoke all on function private.validate_board_snapshot(jsonb) from public, anon, authenticated;

drop policy if exists personal_boards_owner_access on private.personal_boards;
create policy personal_boards_owner_access on private.personal_boards
  for all to authenticated
  using (private.is_configured_board_owner(owner_uuid))
  with check (private.is_configured_board_owner(owner_uuid));

create or replace function public.get_private_board()
returns table(revision bigint, snapshot jsonb)
language plpgsql
security definer
set search_path = pg_catalog, private, public
as $$
declare
  owner_id uuid;
begin
  owner_id := private.assert_board_owner();
  insert into private.personal_boards(owner_uuid, revision, snapshot)
  values (owner_id, 0, jsonb_build_object(
    'schemaVersion', 1,
    'settings', jsonb_build_object('timeZone', 'UTC'),
    'cycles', jsonb_build_array(),
    'tasks', jsonb_build_array(),
    'focusBlocks', jsonb_build_array()))
  on conflict (owner_uuid) do nothing;
  return query select b.revision, b.snapshot from private.personal_boards b where b.owner_uuid = owner_id;
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
  owner_id := private.assert_board_owner();
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Expected board revision is invalid' using errcode = '22023';
  end if;
  perform private.validate_board_snapshot(p_snapshot);

  -- 先做 UPDATE ... INTO，再判断 FOUND 并抛错；顺序不能颠倒，也绝不能使用可重试的错误码。
  -- 如果先 RETURN QUERY（它会打开游标开始流式返回）之后才 RAISE，
  -- PostgREST 的流式路径会一直等到超时（实测约 125 秒）才把错误交给客户端，
  -- 期间客户端一直停在“保存中”，并发写入的正确性体验会被彻底拖垮。
  update private.personal_boards b
  set revision = b.revision + 1, snapshot = p_snapshot, updated_at = now()
  where b.owner_uuid = owner_id and b.revision = p_expected_revision
  returning b.revision, b.snapshot into next_revision, next_snapshot;

  if not found then
    -- 必须使用 PT409（PostgREST 的“自定义 HTTP 状态”约定，映射为 409 Conflict）。
    -- 不能用 40001：那是 serialization_failure，平台会把它当成可重试错误自动重试，
    -- 于是每一次正常冲突都会被反复重试直到边缘超时（实测约 125 秒后 504），
    -- 期间客户端一直停在“保存中”，并发请求还会把连接池耗尽。
    raise exception 'Board revision conflict' using errcode = 'PT409';
  end if;

  return query select next_revision, next_snapshot;
end;
$$;

revoke all on function public.get_private_board() from public, anon;
revoke all on function public.cas_save_private_board(bigint, jsonb) from public, anon;
grant execute on function public.get_private_board() to authenticated;
grant execute on function public.cas_save_private_board(bigint, jsonb) to authenticated;

comment on table private.owner_config is 'Single manually provisioned owner UUID; clients cannot read or claim it.';
comment on table private.personal_boards is 'One private JSONB board per owner, written only through CAS RPC.';
