-- 移除已废弃的任务放置历史：`private.validate_board_snapshot` 不再要求或校验 tasks[].history。
-- 该字段失去消费者（编辑面板已删除展示，客户端 validateSnapshot 在读取时丢弃它），因此这里只放宽校验：
-- 不修改任何已存快照、revision、CAS 或权限模型，也不拒绝旧客户端仍带着 history 的写入。
-- 必须先执行本迁移再发布新版前端：003 的校验器仍要求 history 是数组，新前端写出的快照会被它拒绝。
begin;

create or replace function private.validate_board_snapshot(input jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, public
as $$
declare
  item jsonb;
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
      or private.is_blank(item->>'title') or private.utf16_length(item->>'title') > 450
      or jsonb_typeof(item->'note') is distinct from 'string' or private.utf16_length(item->>'note') > 3000
      or jsonb_typeof(item->'checked') is distinct from 'boolean'
      or jsonb_typeof(item->'color') is distinct from 'string' or item->>'color' not in ('ink', 'blue', 'orange', 'green', 'violet')
      or not private.valid_timestamp(item->>'createdAt')
      or not private.valid_timestamp(item->>'updatedAt')
      or not private.valid_optional_id(item->'cycleId')
      or not private.valid_optional_id(item->'weekKey')
      or not private.valid_optional_id(item->'dateKey')
      or not private.valid_optional_id(item->'parentId')
      or not private.valid_optional_id(item->'upperTaskId')
      or not private.valid_optional_id(item->'rescheduledTo')
      or not private.valid_optional_timestamp(item->'archivedAt') then
      raise exception 'Board task is invalid' using errcode = '22023';
    end if;
    -- 004 起不再要求或校验 item->'history'：旧快照里残留的该键被容忍，由客户端在读取时丢弃。
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

revoke all on function private.validate_board_snapshot(jsonb) from public, anon, authenticated;

commit;
